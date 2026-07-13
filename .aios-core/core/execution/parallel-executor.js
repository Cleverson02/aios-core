/**
 * Parallel Executor
 * Story GEMINI-INT.17 - Multi-Agent Parallel Execution
 *
 * Executes Claude and Gemini in parallel for improved quality and reliability.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/**
 * Parallel execution modes
 */
const ParallelMode = {
  RACE: 'race', // First successful response wins
  CONSENSUS: 'consensus', // Both must agree
  BEST_OF: 'best-of', // Score and pick best
  MERGE: 'merge', // Combine outputs
  FALLBACK: 'fallback', // Primary with backup
};

/**
 * Relative path to the AI provider factory (used lazily so the classic
 * 2-provider API keeps zero coupling to the factory / provider modules).
 * @type {string}
 */
const FACTORY_MODULE = '../../infrastructure/integrations/ai-providers/ai-provider-factory';

/**
 * Named consensus presets (Story WSB-2.4).
 * A preset maps a name to an ordered list of provider names resolved via the
 * factory. Overridable per-project via `.aios/consensus-presets.yaml`
 * (a matching key in the YAML file replaces the built-in entry).
 * @type {Record<string, string[]>}
 */
const CONSENSUS_PRESETS = {
  'critical-review': ['claude', 'codex', 'grok'],
};

class ParallelExecutor extends EventEmitter {
  constructor(config = {}) {
    super();

    this.mode = config.mode || ParallelMode.FALLBACK;
    this.consensusSimilarity = config.consensusSimilarity || 0.85;
    this.timeout = config.timeout || 300000;

    // Track executions
    this.stats = {
      executions: 0,
      consensusAgreements: 0,
      fallbacksUsed: 0,
    };
  }

  /**
   * Execute with both providers in parallel
   * @param {Function} claudeExecutor - Claude execution function
   * @param {Function} geminiExecutor - Gemini execution function
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} Best result based on mode
   */
  async execute(claudeExecutor, geminiExecutor, options = {}) {
    const mode = options.mode || this.mode;
    const startTime = Date.now();

    this.stats.executions++;
    this.emit('parallel_started', { mode });

    // Execute both in parallel
    const results = await Promise.allSettled([
      this._wrapExecution('claude', claudeExecutor),
      this._wrapExecution('gemini', geminiExecutor),
    ]);

    const claudeResult = results[0].status === 'fulfilled' ? results[0].value : null;
    const geminiResult = results[1].status === 'fulfilled' ? results[1].value : null;

    const duration = Date.now() - startTime;

    this.emit('parallel_completed', {
      mode,
      duration,
      claudeSuccess: !!claudeResult?.success,
      geminiSuccess: !!geminiResult?.success,
    });

    // Select result based on mode
    return this._selectResult(mode, claudeResult, geminiResult);
  }

  /**
   * Select result based on execution mode
   */
  _selectResult(mode, claudeResult, geminiResult) {
    switch (mode) {
      case ParallelMode.RACE:
        return this._raceMode(claudeResult, geminiResult);

      case ParallelMode.CONSENSUS:
        return this._consensusMode(claudeResult, geminiResult);

      case ParallelMode.BEST_OF:
        return this._bestOfMode(claudeResult, geminiResult);

      case ParallelMode.MERGE:
        return this._mergeMode(claudeResult, geminiResult);

      case ParallelMode.FALLBACK:
      default:
        return this._fallbackMode(claudeResult, geminiResult);
    }
  }

  /**
   * Race mode - first successful wins
   */
  _raceMode(claude, gemini) {
    // Return first successful
    if (claude?.success) return { ...claude, mode: 'race', selectedProvider: 'claude' };
    if (gemini?.success) return { ...gemini, mode: 'race', selectedProvider: 'gemini' };
    return this._handleBothFailed(claude, gemini);
  }

  /**
   * Consensus mode - both must succeed and agree
   */
  _consensusMode(claude, gemini) {
    if (!claude?.success || !gemini?.success) {
      // Fall back to whichever succeeded
      return this._fallbackMode(claude, gemini);
    }

    // Check similarity
    const similarity = this._calculateSimilarity(claude.output, gemini.output);

    if (similarity >= this.consensusSimilarity) {
      this.stats.consensusAgreements++;
      return {
        ...claude,
        mode: 'consensus',
        consensus: true,
        similarity,
        providers: ['claude', 'gemini'],
      };
    }

    // No consensus - return Claude with warning
    return {
      ...claude,
      mode: 'consensus',
      consensus: false,
      similarity,
      warning: 'Providers did not reach consensus',
    };
  }

  /**
   * Best-of mode - score and pick best
   */
  _bestOfMode(claude, gemini) {
    if (!claude?.success && !gemini?.success) {
      return this._handleBothFailed(claude, gemini);
    }

    if (!claude?.success) return { ...gemini, mode: 'best-of', selectedProvider: 'gemini' };
    if (!gemini?.success) return { ...claude, mode: 'best-of', selectedProvider: 'claude' };

    // Score based on output quality heuristics
    const claudeScore = this._scoreOutput(claude.output);
    const geminiScore = this._scoreOutput(gemini.output);

    const selected = claudeScore >= geminiScore ? claude : gemini;
    const selectedProvider = claudeScore >= geminiScore ? 'claude' : 'gemini';

    return {
      ...selected,
      mode: 'best-of',
      selectedProvider,
      scores: { claude: claudeScore, gemini: geminiScore },
    };
  }

  /**
   * Merge mode - combine outputs
   */
  _mergeMode(claude, gemini) {
    if (!claude?.success && !gemini?.success) {
      return this._handleBothFailed(claude, gemini);
    }

    if (!claude?.success) return { ...gemini, mode: 'merge' };
    if (!gemini?.success) return { ...claude, mode: 'merge' };

    // Simple merge - could be enhanced with semantic merging
    const merged = this._mergeOutputs(claude.output, gemini.output);

    return {
      success: true,
      output: merged,
      mode: 'merge',
      providers: ['claude', 'gemini'],
    };
  }

  /**
   * Fallback mode - primary with backup
   */
  _fallbackMode(claude, gemini) {
    if (claude?.success) {
      return { ...claude, mode: 'fallback', selectedProvider: 'claude' };
    }

    this.stats.fallbacksUsed++;

    if (gemini?.success) {
      return { ...gemini, mode: 'fallback', selectedProvider: 'gemini', usedFallback: true };
    }

    return this._handleBothFailed(claude, gemini);
  }

  /**
   * Handle case where both providers failed
   */
  _handleBothFailed(claude, gemini) {
    return {
      success: false,
      error: 'Both providers failed',
      claudeError: claude?.error,
      geminiError: gemini?.error,
    };
  }

  /**
   * Wrap execution with timeout and error handling
   */
  async _wrapExecution(provider, executor) {
    try {
      const result = await Promise.race([
        executor(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), this.timeout),
        ),
      ]);
      return { ...result, provider };
    } catch (error) {
      return { success: false, error: error.message, provider };
    }
  }

  /**
   * Calculate similarity between two outputs (simple)
   */
  _calculateSimilarity(output1, output2) {
    if (!output1 || !output2) return 0;

    const words1 = new Set(output1.toLowerCase().split(/\s+/));
    const words2 = new Set(output2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Score output quality (simple heuristics)
   */
  _scoreOutput(output) {
    if (!output) return 0;

    let score = 0;

    // Length (reasonable responses get points)
    if (output.length > 100) score += 1;
    if (output.length > 500) score += 1;

    // Structure (code blocks, lists)
    if (output.includes('```')) score += 2;
    if (output.includes('- ') || output.includes('* ')) score += 1;

    // Completeness indicators
    if (output.includes('done') || output.includes('complete')) score += 1;

    return score;
  }

  /**
   * Merge two outputs (simple concatenation with dedup)
   */
  _mergeOutputs(output1, output2) {
    // Simple merge - in production would use semantic merging
    return `## Claude Response:\n${output1}\n\n## Gemini Response:\n${output2}`;
  }

  // ---------------------------------------------------------------------------
  // N-provider API (Story WSB-2.4 — Cross-Vendor Consensus)
  //
  // Extends RACE / CONSENSUS / BEST_OF to an arbitrary list of providers
  // resolved by name through the AI provider factory. The classic 2-provider
  // `execute()` above is untouched and keeps working unchanged.
  // ---------------------------------------------------------------------------

  /**
   * Execute a prompt across N providers resolved by name via the factory.
   *
   * @param {string|string[]} providersOrPreset - Ordered provider names
   *   (e.g. `['claude', 'codex', 'grok']`) or a preset name (string) such as
   *   `'critical-review'`.
   * @param {string} prompt - The prompt to send to every provider.
   * @param {Object} [options={}] - Execution options.
   * @param {string} [options.mode='consensus'] - One of ParallelMode RACE/CONSENSUS/BEST_OF.
   * @param {string} [options.cwd] - Working dir for preset/decision-log resolution (default: process.cwd()).
   * @param {Object} [options.factory] - Inject a factory (defaults to the real ai-provider-factory).
   * @param {boolean} [options.decisionLog] - Set to false to skip decision-log writing on CONSENSUS.
   * @param {string|number} [options.consensusId] - Identifier used in the decision-log filename.
   * @param {number} [options.minProviders=2] - Minimum available providers required for CONSENSUS.
   * @returns {Promise<Object>} Structured result (never throws for expected conditions).
   */
  async executeWithProviders(providersOrPreset, prompt, options = {}) {
    const {
      mode: modeOpt,
      cwd: cwdOpt,
      factory: factoryOpt,
      decisionLog,
      consensusId,
      minProviders,
      ...execOptions
    } = options;

    const mode = modeOpt || ParallelMode.CONSENSUS;
    const cwd = cwdOpt || process.cwd();
    const minRequired = typeof minProviders === 'number' ? minProviders : 2;

    const providerNames = this._resolveProviderNames(providersOrPreset, cwd);

    // Resolve provider instances via the factory (never mutate the factory).
    const factory = factoryOpt || require(FACTORY_MODULE);
    const skipped = [];
    const resolved = [];

    for (const name of providerNames) {
      let provider;
      try {
        provider = factory.getProvider(name);
      } catch (error) {
        skipped.push({ name, reason: error.message || 'Unknown provider' });
        continue;
      }
      resolved.push({ name, provider });
    }

    // Availability probe in parallel; unavailable providers are skipped.
    const availabilityResults = await Promise.allSettled(
      resolved.map((entry) => entry.provider.checkAvailability()),
    );

    const available = [];
    availabilityResults.forEach((res, index) => {
      const entry = resolved[index];
      const isAvailable = res.status === 'fulfilled' && res.value === true;
      if (isAvailable) {
        available.push(entry);
      } else {
        const reason =
          res.status === 'rejected'
            ? res.reason?.message || 'Availability check failed'
            : 'Provider not available';
        skipped.push({ name: entry.name, reason });
      }
    });

    // Minimum-availability gate — structured error, never throw.
    const floor = mode === ParallelMode.CONSENSUS ? minRequired : 1;
    if (available.length < floor) {
      return {
        success: false,
        mode,
        code: 'INSUFFICIENT_PROVIDERS',
        error: `Need at least ${floor} available provider(s) for ${mode}, got ${available.length}`,
        available: available.map((e) => e.name),
        skipped,
      };
    }

    this.stats.executions++;
    this.emit('parallel_started', { mode, providers: available.map((e) => e.name) });

    const startTime = Date.now();
    const settled = await Promise.allSettled(
      available.map((entry) =>
        this._wrapExecution(entry.name, () => entry.provider.execute(prompt, execOptions)),
      ),
    );

    const results = settled.map((res, index) =>
      res.status === 'fulfilled'
        ? res.value
        : { success: false, error: res.reason?.message || 'Execution failed', provider: available[index].name },
    );

    const duration = Date.now() - startTime;
    this.emit('parallel_completed', {
      mode,
      duration,
      providers: available.map((e) => e.name),
      successes: results.filter((r) => r?.success).length,
    });

    switch (mode) {
      case ParallelMode.RACE:
        return this._raceModeN(results, skipped);
      case ParallelMode.BEST_OF:
        return this._bestOfModeN(results, skipped);
      case ParallelMode.CONSENSUS:
      default:
        return this._consensusModeN(results, skipped, {
          prompt,
          cwd,
          decisionLog: decisionLog !== false,
          consensusId,
        });
    }
  }

  /**
   * Resolve a preset name or explicit list into an ordered array of provider names.
   * @param {string|string[]} providersOrPreset - Preset name or explicit list.
   * @param {string} cwd - Project root for preset override lookup.
   * @returns {string[]} Ordered provider names.
   * @private
   */
  _resolveProviderNames(providersOrPreset, cwd) {
    if (Array.isArray(providersOrPreset)) {
      return providersOrPreset.slice();
    }

    if (typeof providersOrPreset === 'string') {
      const presets = this._loadPresets(cwd);
      const preset = presets[providersOrPreset];
      if (preset) {
        return preset.slice();
      }
      // A bare string that is not a known preset is treated as a single provider.
      return [providersOrPreset];
    }

    return [];
  }

  /**
   * Load consensus presets, merging any project-level overrides from
   * `.aios/consensus-presets.yaml` (a matching key replaces the built-in).
   * @param {string} cwd - Project root.
   * @returns {Record<string, string[]>} Merged presets.
   * @private
   */
  _loadPresets(cwd) {
    const presets = { ...CONSENSUS_PRESETS };
    const yamlPath = path.join(cwd, '.aios', 'consensus-presets.yaml');

    if (fs.existsSync(yamlPath)) {
      try {
        const yaml = require('js-yaml');
        const parsed = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          Object.assign(presets, parsed);
        }
      } catch (error) {
        this.emit('preset_load_error', { path: yamlPath, error: error.message });
      }
    }

    return presets;
  }

  /**
   * RACE across N providers — first successful result (in provider order) wins.
   * @param {Object[]} results - Wrapped execution results.
   * @param {Array<{name:string,reason:string}>} skipped - Skipped providers.
   * @returns {Object} Race result.
   * @private
   */
  _raceModeN(results, skipped) {
    const winner = results.find((r) => r?.success);
    if (winner) {
      return {
        ...winner,
        mode: 'race',
        selectedProvider: winner.provider,
        skipped,
      };
    }
    return this._handleAllFailed('race', results, skipped);
  }

  /**
   * BEST_OF across N providers — highest scored successful output wins.
   * @param {Object[]} results - Wrapped execution results.
   * @param {Array<{name:string,reason:string}>} skipped - Skipped providers.
   * @returns {Object} Best-of result.
   * @private
   */
  _bestOfModeN(results, skipped) {
    const successful = results.filter((r) => r?.success);
    if (successful.length === 0) {
      return this._handleAllFailed('best-of', results, skipped);
    }

    const scores = {};
    let best = null;
    let bestScore = -Infinity;
    for (const r of successful) {
      const score = this._scoreOutput(r.output);
      scores[r.provider] = score;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    return {
      ...best,
      mode: 'best-of',
      selectedProvider: best.provider,
      scores,
      skipped,
    };
  }

  /**
   * CONSENSUS across N providers — simple majority over responses grouped by
   * similarity (reuses the existing `_calculateSimilarity` / `consensusSimilarity`
   * criterion used by the 2-provider path). Ties are broken with BEST_OF scoring.
   * @param {Object[]} results - Wrapped execution results.
   * @param {Array<{name:string,reason:string}>} skipped - Skipped providers.
   * @param {Object} ctx - Context ({ prompt, cwd, decisionLog, consensusId }).
   * @returns {Promise<Object>} Consensus result with per-provider votes.
   * @private
   */
  async _consensusModeN(results, skipped, ctx) {
    const successful = results.filter((r) => r?.success);
    if (successful.length < 2) {
      return {
        success: false,
        mode: 'consensus',
        code: 'INSUFFICIENT_RESPONSES',
        error: `Consensus needs at least 2 successful responses, got ${successful.length}`,
        failures: results.filter((r) => !r?.success).map((r) => ({ provider: r.provider, error: r.error })),
        skipped,
      };
    }

    const groups = this._groupResponses(successful);
    const providerGroup = new Map();
    groups.forEach((g) => g.members.forEach((m) => providerGroup.set(m.provider, g.id)));

    const votes = successful.map((r) => ({
      provider: r.provider,
      response: r.output,
      group: providerGroup.get(r.provider),
    }));

    const maxSize = Math.max(...groups.map((g) => g.members.length));
    const topGroups = groups.filter((g) => g.members.length === maxSize);

    let winner;
    let tiebreak;
    let scores;
    let consensus;

    if (topGroups.length === 1 && maxSize >= 2) {
      // Clear majority group — winner is the highest-scored member of it.
      winner = this._bestMember(topGroups[0].members);
      consensus = true;
    } else {
      // Tie (including all-distinct 1-1-1) → BEST_OF desempate across the tied groups.
      tiebreak = 'best-of';
      consensus = false;
      const candidates = topGroups.flatMap((g) => g.members);
      scores = {};
      let bestScore = -Infinity;
      for (const m of candidates) {
        const score = this._scoreOutput(m.response);
        scores[m.provider] = score;
        if (score > bestScore) {
          bestScore = score;
          winner = m;
        }
      }
    }

    if (consensus) {
      this.stats.consensusAgreements++;
    }

    const result = {
      success: true,
      mode: 'consensus',
      consensus,
      output: winner.response,
      selectedProvider: winner.provider,
      winner: { provider: winner.provider, response: winner.response, group: providerGroup.get(winner.provider) },
      votes,
      groups: groups.map((g) => ({ id: g.id, size: g.members.length, providers: g.members.map((m) => m.provider) })),
      skipped,
    };

    if (tiebreak) {
      result.tiebreak = tiebreak;
      result.scores = scores;
    }

    if (ctx.decisionLog) {
      try {
        result.decisionLogPath = await this._writeConsensusDecisionLog({
          prompt: ctx.prompt,
          cwd: ctx.cwd,
          consensusId: ctx.consensusId,
          votes,
          winner: result.winner,
          consensus,
          tiebreak,
          skipped,
        });
      } catch (error) {
        this.emit('decision_log_error', { error: error.message });
      }
    }

    return result;
  }

  /**
   * Group successful responses by similarity using the existing consensus
   * criterion. Two responses share a group when their `_calculateSimilarity`
   * meets `consensusSimilarity`. (Heuristic: free-form long answers rarely tie
   * literally, so grouping is by similarity to a group representative.)
   * @param {Object[]} successful - Successful wrapped results (with `output`).
   * @returns {Array<{id:number, representative:string, members:Array<{provider:string,response:string}>}>}
   * @private
   */
  _groupResponses(successful) {
    const groups = [];
    for (const r of successful) {
      let placed = false;
      for (const g of groups) {
        if (this._calculateSimilarity(r.output, g.representative) >= this.consensusSimilarity) {
          g.members.push({ provider: r.provider, response: r.output });
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push({
          id: groups.length,
          representative: r.output,
          members: [{ provider: r.provider, response: r.output }],
        });
      }
    }
    return groups;
  }

  /**
   * Pick the highest-scored member of a group (ties resolved by order).
   * @param {Array<{provider:string,response:string}>} members - Group members.
   * @returns {{provider:string,response:string}} Best member.
   * @private
   */
  _bestMember(members) {
    let best = members[0];
    let bestScore = this._scoreOutput(best.response);
    for (let i = 1; i < members.length; i++) {
      const score = this._scoreOutput(members[i].response);
      if (score > bestScore) {
        bestScore = score;
        best = members[i];
      }
    }
    return best;
  }

  /**
   * Structured all-failed result for N-provider modes.
   * @param {string} mode - Execution mode.
   * @param {Object[]} results - Wrapped execution results.
   * @param {Array<{name:string,reason:string}>} skipped - Skipped providers.
   * @returns {Object} Failure result.
   * @private
   */
  _handleAllFailed(mode, results, skipped) {
    return {
      success: false,
      mode,
      error: 'All providers failed',
      failures: results.map((r) => ({ provider: r.provider, error: r.error })),
      skipped,
    };
  }

  /**
   * Write a CONSENSUS decision log to `.ai/` in the existing ADR markdown style
   * (mirrors `.aios-core/development/scripts/decision-log-generator.js`, but
   * records per-provider votes/groups/winner/skipped which that story-oriented
   * generator does not model).
   * @param {Object} ctx - Log context.
   * @returns {Promise<string>} Path to the written decision log.
   * @private
   */
  async _writeConsensusDecisionLog(ctx) {
    const aiDir = path.join(ctx.cwd || process.cwd(), '.ai');
    await fs.promises.mkdir(aiDir, { recursive: true });

    const id = ctx.consensusId != null ? String(ctx.consensusId) : String(Date.now());
    const logPath = path.join(aiDir, `decision-log-consensus-${id}.md`);
    const truncate = (text, max) => {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      return clean.length > max ? `${clean.slice(0, max)}…` : clean;
    };

    const votesTable = ctx.votes
      .map((v) => `| ${v.provider} | ${v.group} | ${truncate(v.response, 200)} |`)
      .join('\n');

    const skippedList =
      ctx.skipped.length > 0
        ? ctx.skipped.map((s) => `- \`${s.name}\`: ${s.reason}`).join('\n')
        : '*None — all providers responded.*';

    const template = `# Decision Log: Cross-Vendor Consensus ${id}

**Generated:** ${new Date().toISOString()}
**Mode:** consensus
**Story:** WSB-2.4 (Cross-Vendor Consensus)
**Consensus Reached:** ${ctx.consensus ? 'yes' : 'no'}${ctx.tiebreak ? `\n**Tiebreak:** ${ctx.tiebreak}` : ''}

---

## Context

**Prompt:**

> ${truncate(ctx.prompt, 500)}

---

## Votes

| Provider | Group | Response (truncated) |
|----------|-------|----------------------|
${votesTable}

---

## Winner

**Provider:** ${ctx.winner.provider}
**Group:** ${ctx.winner.group}

${truncate(ctx.winner.response, 500)}

---

## Skipped Providers

${skippedList}

---

*Architecture Decision Record (ADR) auto-generated by AIOS Parallel Executor — Story WSB-2.4*
`;

    await fs.promises.writeFile(logPath, template, 'utf8');
    return logPath;
  }

  /**
   * Get execution statistics
   */
  getStats() {
    return {
      ...this.stats,
      consensusRate:
        this.stats.executions > 0 ? this.stats.consensusAgreements / this.stats.executions : 0,
      fallbackRate:
        this.stats.executions > 0 ? this.stats.fallbacksUsed / this.stats.executions : 0,
    };
  }
}

module.exports = { ParallelExecutor, ParallelMode, CONSENSUS_PRESETS };
