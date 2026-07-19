/**
 * LLM Router — categorize a task and pick the best model (Story WSB-2.3).
 *
 * `LlmRouter` turns free-form task text into a routing decision:
 *   task text → category (keyword heuristic) → task_routing entry →
 *   a direct model OR a policy → concrete model + human-readable reason.
 *
 * It REUSES `TaskComplexityClassifier` from `core/orchestration` to gauge how
 * hard the task is, which lets `cost-first` upgrade one cost tier for genuinely
 * complex work (so we don't send an architecture-grade problem to the cheapest
 * model just because it technically "covers" the category).
 *
 * Two modes are served by this class (advisor + autonomous share the logic):
 *   - advisor    → `route()` returns a suggestion; the CLI prints it.
 *   - autonomous → a caller feeds `route().model` to a dispatcher (out of scope).
 *
 * @module core/router/router
 * @version 1.0.0
 * @created Story WSB-2.3 — LLM Router (roteamento + conselheiro)
 */

const { loadMatrix } = require('./matrix-loader');
const { TaskComplexityClassifier } = require('../orchestration/task-complexity-classifier');
const { switchCost } = require('./cache-affinity');

/** Default fresh-input tokens assumed per chain step when a subtask omits it. */
const DEFAULT_STEP_NEW_TOKENS = 2000;
/** Categories that ALWAYS justify the strong model regardless of cache economics. */
const QUALITY_OVERRIDE_CATEGORIES = new Set(['architecture-decision', 'security-review']);

/**
 * Keyword → category heuristic (PT + EN). Substrings are matched against the
 * lower-cased task text; the FIRST category whose any-keyword matches wins, so
 * order encodes priority. Kept intentionally small and documented so product
 * can reason about it without reading code.
 *
 * @type {Array<{ category: string, keywords: string[] }>}
 */
const CATEGORY_KEYWORDS = [
  { category: 'architecture-decision', keywords: ['arquitetura', 'architecture', 'design de sistema', 'system design'] },
  { category: 'security-review', keywords: ['seguran', 'security', 'auditoria de seguran', 'vulnerab'] },
  { category: 'bulk-refactor', keywords: ['refator', 'refactor', 'migra', 'migrate'] },
  { category: 'test-generation', keywords: ['teste', 'test', 'cobertura', 'coverage'] },
  { category: 'code-review', keywords: ['review', 'revisar', 'revisão', 'auditoria', 'code review'] },
  { category: 'research-summarize', keywords: ['pesquis', 'research', 'resum', 'summar'] },
  { category: 'agentic-coding', keywords: ['terminal', 'agentic', 'computer use', 'computer-use'] },
  { category: 'story-implementation', keywords: ['implementa', 'implement', 'story', 'feature', 'funcionalidade'] },
];

/**
 * Category → desired capability tags. A model is "relevant" to a category when
 * its strengths intersect this set. Policies only ever choose among relevant
 * models. `default` (empty set) means every model is relevant.
 *
 * @type {Record<string, string[]>}
 */
const CATEGORY_STRENGTHS = {
  'architecture-decision': ['architecture', 'reasoning', 'long-context', 'security'],
  'security-review': ['security', 'reasoning', 'code-review'],
  'code-review': ['code-review', 'reasoning', 'security'],
  'bulk-refactor': ['bulk-refactor', 'refactor-scale', 'coding-speed', 'token-efficiency'],
  'test-generation': ['test-generation', 'coding-speed'],
  'research-summarize': ['research-summarize', 'long-context-bulk', 'multimodal'],
  'agentic-coding': ['agentic-coding', 'terminal', 'computer-use'],
  'story-implementation': ['agentic-coding', 'coding-speed', 'reasoning'],
  default: [],
};

/** cost_tier → numeric rank (lower is cheaper). */
const COST_RANK = { low: 0, medium: 1, high: 2 };
/** speed_tier → numeric rank (lower is faster). */
const SPEED_RANK = { fast: 0, medium: 1, slow: 2 };
/** Inverse of COST_RANK for tier-upgrade lookups. */
const COST_BY_RANK = ['low', 'medium', 'high'];

class LlmRouter {
  /**
   * @param {Object} [options]
   * @param {string} [options.projectRoot] - Root for the project matrix override.
   * @param {Object} [options.matrix] - Pre-loaded matrix (test injection; skips loadMatrix).
   */
  constructor({ projectRoot, matrix } = {}) {
    this.projectRoot = projectRoot;
    this.matrix = matrix || loadMatrix({ projectRoot });
    this.classifier = new TaskComplexityClassifier();
  }

  /**
   * Normalize a task argument into plain text.
   * @param {string|Object} task - Raw task string or `{ description|text }`.
   * @returns {string}
   * @private
   */
  _text(task) {
    if (typeof task === 'string') return task;
    if (task && typeof task === 'object') return task.description || task.text || '';
    return '';
  }

  /**
   * Classify task text into a routing category via the keyword heuristic.
   *
   * @param {string} taskText - Free-form task description.
   * @returns {string} Category id (falls back to `default`).
   */
  categorize(taskText) {
    const text = String(taskText || '').toLowerCase();
    for (const { category, keywords } of CATEGORY_KEYWORDS) {
      if (keywords.some((kw) => text.includes(kw))) {
        return category;
      }
    }
    return 'default';
  }

  /**
   * Models relevant to a category (strengths intersect the desired set). When
   * the category has no desired tags (`default`), every model is relevant.
   *
   * @param {string} category - Category id.
   * @returns {Array<{ id: string, model: Object, matches: string[] }>}
   * @private
   */
  _relevantModels(category) {
    const desired = CATEGORY_STRENGTHS[category] || [];
    const entries = Object.entries(this.matrix.models).map(([id, model]) => {
      const matches = desired.length
        ? model.strengths.filter((s) => desired.includes(s))
        : [...model.strengths];
      return { id, model, matches };
    });

    if (!desired.length) return entries;
    const relevant = entries.filter((e) => e.matches.length > 0);
    // Never strand the caller: if nothing matches, every model is a candidate.
    return relevant.length ? relevant : entries;
  }

  /**
   * Apply a policy to a set of relevant candidates, returning them sorted best-
   * first for that policy. Complexity-driven cost upgrade is handled by caller.
   *
   * @param {string} policy - Policy name.
   * @param {Array} candidates - Output of `_relevantModels`.
   * @returns {Array} Candidates sorted best-first.
   * @private
   */
  _rankByPolicy(policy, candidates) {
    const byName = (a, b) => a.id.localeCompare(b.id);
    const sorted = [...candidates];

    if (policy === 'quality-first') {
      // Most matching strengths; tie-break: more total strengths, then name.
      sorted.sort(
        (a, b) =>
          b.matches.length - a.matches.length ||
          b.model.strengths.length - a.model.strengths.length ||
          byName(a, b),
      );
    } else if (policy === 'speed-first') {
      // Fastest; tie-break: cheaper, then name.
      sorted.sort(
        (a, b) =>
          SPEED_RANK[a.model.speed_tier] - SPEED_RANK[b.model.speed_tier] ||
          COST_RANK[a.model.cost_tier] - COST_RANK[b.model.cost_tier] ||
          byName(a, b),
      );
    } else {
      // cost-first (default): cheapest; tie-break: faster, then name.
      sorted.sort(
        (a, b) =>
          COST_RANK[a.model.cost_tier] - COST_RANK[b.model.cost_tier] ||
          SPEED_RANK[a.model.speed_tier] - SPEED_RANK[b.model.speed_tier] ||
          byName(a, b),
      );
    }
    return sorted;
  }

  /**
   * Route a task to a model.
   *
   * Resolution order:
   *   1. `categorize(text)` → category.
   *   2. `task_routing[category]` (fallback `task_routing.default`) → target.
   *   3. An explicit `{ policy }` overrides the target's policy/model choice.
   *   4. A direct-model target is honored as-is; a `policy:<name>` target (or an
   *      explicit policy) is resolved against the relevant candidates.
   *
   * Complexity upgrade: with `cost-first` on a `complex` task, the pick is bumped
   * one cost tier up (cheapest → next tier) for quality — documented and flagged
   * via `upgraded` in the reason.
   *
   * Cache-aware overload (WSB-4.6): when `incumbent` is provided, the base
   * decision is post-processed by `switchCost()`. If keeping the incumbent is
   * cheaper (within `marginPct`) the incumbent is returned with a reason that
   * spells out the USD on each side; otherwise the base recommendation stands
   * (with the math appended). WITHOUT `incumbent` the behavior is byte-for-byte
   * identical to before — existing callers/tests are untouched.
   *
   * @param {string|Object} task - Task text or `{ description }`.
   * @param {Object} [options]
   * @param {string} [options.policy] - Force a policy (overrides task_routing).
   * @param {boolean} [options.ignoreAvailability] - Skip the availability filter (WSB-4.4).
   * @param {string} [options.incumbent] - Model already holding the cached context.
   * @param {number} [options.cachedContextTokens] - Tokens cached on the incumbent.
   * @param {number} [options.expectedNewInputTokens] - Fresh input tokens this step.
   * @param {number} [options.expectedOutputTokens] - Expected completion tokens.
   * @param {number} [options.marginPct] - Protective switch margin (default 10%).
   * @returns {{ model: string, provider: string, category: string, complexity: string,
   *   policy: string, reason: string, alternatives: Array<{ model: string, why: string }>,
   *   cacheAffinity?: Object }}
   */
  route(task, options = {}) {
    const {
      policy,
      ignoreAvailability,
      incumbent,
      cachedContextTokens = 0,
      expectedNewInputTokens = 0,
      expectedOutputTokens = 0,
      marginPct,
    } = options;

    const base = this._decide(task, { policy, ignoreAvailability });

    // No incumbent (or the pick already IS the incumbent) → unchanged behavior.
    if (!incumbent || incumbent === base.model) return base;

    return this._applyCacheAffinity(base, {
      incumbent,
      cachedContextTokens,
      expectedNewInputTokens,
      expectedOutputTokens,
      marginPct,
    });
  }

  /**
   * Post-process a base decision with cache economics. Returns the incumbent when
   * staying is cheaper (within margin), the base pick when switching wins, and
   * the base pick untouched (but annotated) when pricing is missing (neutral).
   *
   * @param {Object} base - Decision from `_decide`.
   * @param {Object} params - `{ incumbent, cachedContextTokens, expectedNewInputTokens, expectedOutputTokens, marginPct }`.
   * @returns {Object} Possibly-rewritten decision (adds `cacheAffinity`).
   * @private
   */
  _applyCacheAffinity(base, {
    incumbent,
    cachedContextTokens,
    expectedNewInputTokens,
    expectedOutputTokens,
    marginPct,
  }) {
    const sc = switchCost({
      incumbentModel: incumbent,
      candidateModel: base.model,
      cachedContextTokens,
      expectedNewInputTokens,
      expectedOutputTokens,
      matrix: this.matrix,
      marginPct,
    });

    if (sc.recommendation === 'neutral') {
      return { ...base, cacheAffinity: sc, reason: `${base.reason} [cache-affinity neutro: ${sc.reason}]` };
    }

    if (sc.recommendation === 'stay') {
      const incModel = this.matrix.models[incumbent];
      return {
        model: incumbent,
        provider: incModel ? incModel.provider : 'unknown',
        category: base.category,
        complexity: base.complexity,
        policy: base.policy,
        reason:
          `Mantém incumbente ${incumbent} por afinidade de cache — trocar p/ ${base.model} sairia mais caro. ${sc.explanation}`,
        alternatives: base.alternatives,
        cacheAffinity: sc,
      };
    }

    // switch: keep the base recommendation, expose the winning math.
    return { ...base, reason: `${base.reason} Cache-affinity confirma a troca: ${sc.explanation}`, cacheAffinity: sc };
  }

  /**
   * Route an ENTIRE chain of subtasks with cache affinity (AC3).
   *
   * Picks a single anchor model from the dominant category (mode; ties broken by
   * the higher cost_tier of the routed model, then name), then walks the chain
   * keeping the anchor as the cached incumbent. Cached context ACCUMULATES as the
   * chain proceeds (each step adds its `expectedNewInputTokens`, default 2000), so
   * switching away gets progressively more expensive. Exceptions are marked where
   * a switch genuinely pays off, and `architecture-decision`/`security-review`
   * ALWAYS flag `qualityOverride: true` (strong model wins on quality, with the
   * cache math exposed in the reason).
   *
   * @param {Array<{ description?: string, text?: string, expectedNewInputTokens?: number,
   *   expectedOutputTokens?: number }|string>} subtasks - The chain.
   * @param {Object} [options]
   * @param {string} [options.policy] - Force a policy for every step.
   * @param {number} [options.cachedContextTokens] - Pre-existing cached tokens on the anchor.
   * @param {number} [options.marginPct] - Protective switch margin (default 10%).
   * @returns {{ anchor: string|null,
   *   steps: Array<{ index: number, category: string, model: string, switched: boolean,
   *     qualityOverride: boolean, reason: string }>,
   *   totalEstimatedCost: number }}
   */
  routeChain(subtasks = [], { policy, cachedContextTokens = 0, marginPct } = {}) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      return { anchor: null, steps: [], totalEstimatedCost: 0 };
    }

    const items = subtasks.map((st, index) => {
      const description = typeof st === 'string' ? st : this._text(st);
      const expectedNewInputTokens =
        st && typeof st === 'object' && st.expectedNewInputTokens !== undefined
          ? st.expectedNewInputTokens
          : DEFAULT_STEP_NEW_TOKENS;
      const expectedOutputTokens =
        st && typeof st === 'object' && st.expectedOutputTokens !== undefined ? st.expectedOutputTokens : 0;
      return { index, description, category: this.categorize(description), expectedNewInputTokens, expectedOutputTokens };
    });

    const anchorCategory = this._dominantCategory(items, policy);
    const anchorRep = items.find((it) => it.category === anchorCategory) || items[0];
    const anchor = this._decide(anchorRep.description, { policy }).model;

    let cached = Math.max(0, Number(cachedContextTokens) || 0);
    let totalEstimatedCost = 0;
    const steps = [];

    for (const it of items) {
      const naive = this._decide(it.description, { policy }).model;
      const forcedQuality = QUALITY_OVERRIDE_CATEGORIES.has(it.category);
      const sc = switchCost({
        incumbentModel: anchor,
        candidateModel: naive,
        cachedContextTokens: cached,
        expectedNewInputTokens: it.expectedNewInputTokens,
        expectedOutputTokens: it.expectedOutputTokens,
        matrix: this.matrix,
        marginPct,
      });

      let model;
      let switched;
      let qualityOverride = false;
      let reason;

      if (forcedQuality && naive !== anchor) {
        qualityOverride = true;
        model = naive;
        switched = true;
        reason =
          `Quality override (${it.category}): usa ${model} independentemente do cache. ` +
          (sc.recommendation === 'neutral' ? sc.reason : sc.explanation);
      } else if (naive === anchor) {
        model = anchor;
        switched = false;
        qualityOverride = forcedQuality; // anchor already IS the strong model
        reason = forcedQuality
          ? `Âncora ${anchor} já é o modelo forte para ${it.category}.`
          : `Mantém âncora ${anchor} (categoria ${it.category} roteia para a âncora).`;
      } else if (sc.recommendation === 'switch') {
        model = naive;
        switched = true;
        reason = `Troca compensa mesmo perdendo cache: ${sc.explanation}`;
      } else if (sc.recommendation === 'neutral') {
        model = anchor;
        switched = false;
        reason = `Afinidade neutra (${sc.reason}) → mantém âncora ${anchor}.`;
      } else {
        model = anchor;
        switched = false;
        reason = `Mantém âncora ${anchor} por afinidade de cache: ${sc.explanation}`;
      }

      if (sc.recommendation !== 'neutral') {
        totalEstimatedCost += switched ? sc.switchCost : sc.stayCost;
      }

      steps.push({ index: it.index, category: it.category, model, switched, qualityOverride, reason });
      cached += it.expectedNewInputTokens;
    }

    return { anchor, steps, totalEstimatedCost };
  }

  /**
   * Dominant category of a categorized chain: the mode, with ties broken by the
   * higher cost_tier of the category's routed model, then by category name.
   *
   * @param {Array<{ category: string, description: string }>} items - Categorized subtasks.
   * @param {string} [policy] - Policy used to resolve a category's model for tie-breaks.
   * @returns {string} Winning category id.
   * @private
   */
  _dominantCategory(items, policy) {
    const counts = new Map();
    for (const it of items) counts.set(it.category, (counts.get(it.category) || 0) + 1);

    let maxCount = 0;
    for (const c of counts.values()) if (c > maxCount) maxCount = c;
    const tied = [...counts.entries()].filter(([, c]) => c === maxCount).map(([cat]) => cat);
    if (tied.length === 1) return tied[0];

    const costRankOf = (cat) => {
      const rep = items.find((it) => it.category === cat);
      const modelId = this._decide(rep.description, { policy }).model;
      const model = this.matrix.models[modelId];
      return model ? COST_RANK[model.cost_tier] : -1;
    };
    tied.sort((a, b) => costRankOf(b) - costRankOf(a) || a.localeCompare(b));
    return tied[0];
  }

  /**
   * Decide a model for a single task (the pre-WSB-4.6 `route` core). Kept private
   * so the public `route` can layer cache-affinity on top without duplicating the
   * category/policy/availability logic.
   *
   * @param {string|Object} task - Task text or `{ description }`.
   * @param {Object} [options]
   * @param {string} [options.policy] - Force a policy (overrides task_routing).
   * @param {boolean} [options.ignoreAvailability] - Skip the availability filter (WSB-4.4).
   * @returns {{ model: string, provider: string, category: string, complexity: string,
   *   policy: string, reason: string, alternatives: Array<{ model: string, why: string }> }}
   * @private
   */
  _decide(task, { policy: forcedPolicy, ignoreAvailability = false } = {}) {
    const text = this._text(task);
    const category = this.categorize(text);
    const complexity = this.classifier.classify({ description: text }).level;

    const target = this.matrix.task_routing[category] || this.matrix.task_routing.default;

    // Resolve the effective policy (if any) and any direct model target.
    let effectivePolicy = null;
    let directModel = null;

    if (forcedPolicy) {
      effectivePolicy = forcedPolicy;
    } else if (target && target.startsWith('policy:')) {
      const name = target.slice('policy:'.length);
      effectivePolicy = name === 'default' ? this.matrix.default_policy : name;
    } else {
      directModel = target;
    }

    if (effectivePolicy && !this.matrix.routing_policies[effectivePolicy]) {
      throw new Error(
        `Unknown policy "${effectivePolicy}" (available: ${Object.keys(this.matrix.routing_policies).join(', ')})`,
      );
    }

    let candidates = this._relevantModels(category);

    // WSB-4.4 AC3: honor provider availability (per the availability cache).
    // NO-OP when the cache is absent (`null`) — routing behaves exactly as
    // before wherever provider setup has not run.
    const unavailable = ignoreAvailability ? null : this._unavailableProviders();
    const isDown = (provider) => (unavailable ? unavailable.has(provider) : false);

    // Within the category, drop unavailable providers — but never strand: if
    // that would empty the set, keep the original (all-unavailable ⇒ neutral).
    if (unavailable && unavailable.size) {
      const filtered = candidates.filter((c) => !isDown(c.model.provider));
      if (filtered.length) candidates = filtered;
    }

    if (directModel) {
      const directModelObj = this.matrix.models[directModel];
      const directProvider = directModelObj && directModelObj.provider;
      if (unavailable && directProvider && isDown(directProvider)) {
        // Curated model's provider is down → re-route via the default policy
        // among the AVAILABLE models (relevant first, else any available), and
        // record the substitution in the reason. If nothing is available
        // anywhere, stay neutral and keep the curated choice.
        const pool = this._availablePool(category, isDown);
        if (pool.length) {
          const decision = this._policyDecision(this.matrix.default_policy, category, complexity, pool);
          decision.reason = `${directModel} indisponível → roteado para ${decision.model}. ${decision.reason}`;
          return decision;
        }
      }
      return this._directDecision(directModel, category, complexity, candidates);
    }
    return this._policyDecision(effectivePolicy, category, complexity, candidates);
  }

  /**
   * Build a re-route pool of AVAILABLE models: category-relevant ones first, and
   * when none of those are available, every available model in the matrix. Used
   * only when a curated direct mapping points to a down provider.
   *
   * @param {string} category - Routing category.
   * @param {(provider: string) => boolean} isDown - Availability predicate.
   * @returns {Array<{ id: string, model: Object, matches: string[] }>}
   * @private
   */
  _availablePool(category, isDown) {
    const relevantAvailable = this._relevantModels(category).filter((c) => !isDown(c.model.provider));
    if (relevantAvailable.length) return relevantAvailable;
    return Object.entries(this.matrix.models)
      .filter(([, model]) => !isDown(model.provider))
      .map(([id, model]) => ({ id, model, matches: [...model.strengths] }));
  }

  /**
   * Set of provider ids currently marked unavailable, read lazily from the
   * provider-availability cache. Returns `null` (⇒ filter nothing) when the
   * providers module or its cache is absent — this keeps routing behavior
   * unchanged wherever WSB-4.4 has not been set up.
   *
   * @returns {Set<string>|null}
   * @private
   */
  _unavailableProviders() {
    try {
      // Lazy require so the router has zero hard dependency on the providers
      // module; any load/read failure degrades to "no filtering".
      const providers = require('../providers');
      if (!providers || typeof providers.unavailableProviders !== 'function') return null;
      return providers.unavailableProviders({ cwd: this.projectRoot || process.cwd() });
    } catch {
      return null;
    }
  }

  /**
   * Build a decision for a direct (task_routing) model mapping.
   * @private
   */
  _directDecision(modelId, category, complexity, candidates) {
    const model = this.matrix.models[modelId];
    if (!model) {
      // Should be caught by the loader, but degrade with a clear error.
      throw new Error(`task_routing points to undefined model "${modelId}" for category "${category}"`);
    }
    const reason =
      `Categoria "${category}" mapeia diretamente para ${modelId} (${model.provider}) ` +
      'na matrix — escolha curada para este tipo de tarefa.';
    const alternatives = this._alternatives(candidates, modelId);
    return {
      model: modelId,
      provider: model.provider,
      category,
      complexity,
      policy: 'direct',
      reason,
      alternatives,
    };
  }

  /**
   * Build a decision by applying a policy to the relevant candidates.
   * @private
   */
  _policyDecision(policy, category, complexity, candidates) {
    const ranked = this._rankByPolicy(policy, candidates);
    let chosen = ranked[0];
    let upgraded = false;

    // Complexity-driven cost upgrade: bump one cost tier up on complex tasks.
    if (policy === 'cost-first' && complexity === 'complex') {
      const baseRank = COST_RANK[chosen.model.cost_tier];
      const targetTier = COST_BY_RANK[baseRank + 1];
      if (targetTier) {
        const upgradedPool = candidates.filter((c) => c.model.cost_tier === targetTier);
        if (upgradedPool.length) {
          chosen = this._rankByPolicy('cost-first', upgradedPool)[0];
          upgraded = true;
        }
      }
    }

    const model = chosen.model;
    const matchNote = chosen.matches.length ? ` [match: ${chosen.matches.join(', ')}]` : '';
    const policyNote = this._policyReason(policy, model);
    const upgradeNote = upgraded
      ? ' Tarefa classificada como "complex": subiu um cost tier para priorizar qualidade.'
      : '';
    const reason =
      `Policy ${policy}: ${chosen.id} (${model.provider}) — ${policyNote}${matchNote}.${upgradeNote}`;

    const alternatives = this._alternatives(ranked, chosen.id);
    return {
      model: chosen.id,
      provider: model.provider,
      category,
      complexity,
      policy,
      reason,
      alternatives,
    };
  }

  /**
   * One-line rationale fragment describing why a policy favored a model.
   * @private
   */
  _policyReason(policy, model) {
    if (policy === 'quality-first') return `melhor match de capacidade (custo ignorado, cost_tier ${model.cost_tier})`;
    if (policy === 'speed-first') return `mais rápido (speed_tier ${model.speed_tier}, cost_tier ${model.cost_tier})`;
    return `menor custo que cobre a categoria (cost_tier ${model.cost_tier}, speed_tier ${model.speed_tier})`;
  }

  /**
   * Build the alternatives list (all candidates except the chosen one), each with
   * a short trade-off phrase.
   * @private
   */
  _alternatives(candidates, chosenId) {
    return candidates
      .filter((c) => c.id !== chosenId)
      .map((c) => ({
        model: c.id,
        why:
          `${c.model.provider}, cost ${c.model.cost_tier}, speed ${c.model.speed_tier}` +
          (c.matches && c.matches.length ? `, cobre: ${c.matches.join('/')}` : ''),
      }));
  }

  /**
   * List models with their capability metadata.
   * @returns {Array<{ id: string, provider: string, cost_tier: string, speed_tier: string, strengths: string[], notes: string }>}
   */
  listModels() {
    return Object.entries(this.matrix.models).map(([id, m]) => ({
      id,
      provider: m.provider,
      cost_tier: m.cost_tier,
      speed_tier: m.speed_tier,
      strengths: [...m.strengths],
      notes: m.notes || '',
    }));
  }

  /**
   * List policies (name + description), flagging the default.
   * @returns {Array<{ name: string, description: string, isDefault: boolean }>}
   */
  listPolicies() {
    return Object.entries(this.matrix.routing_policies).map(([name, p]) => ({
      name,
      description: p.description,
      isDefault: name === this.matrix.default_policy,
    }));
  }
}

module.exports = {
  LlmRouter,
  CATEGORY_KEYWORDS,
  CATEGORY_STRENGTHS,
  COST_RANK,
  SPEED_RANK,
  DEFAULT_STEP_NEW_TOKENS,
  QUALITY_OVERRIDE_CATEGORIES,
};
