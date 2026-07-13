/**
 * L8 Workspace Knowledge Layer Processor
 *
 * Story: WSB-1.5 - SYNAPSE L8 (Workspace Knowledge) — completes the SYN-10 slot.
 *
 * Injects automatic hints from the workspace brain into every prompt: which
 * business entities are mentioned, which areas are relevant, and WHERE the
 * documents live — all inside the SYNAPSE token/time budget, without anyone
 * running `aios brain ask` by hand.
 *
 * Performance contract (design driver): the SYNAPSE hook spawns a fresh process
 * per prompt (no in-memory cache) under a 100ms pipeline / 15ms layer budget.
 * Reading chunks.json / vectors.json (tens of MB) is impossible here, so this
 * layer reads ONLY the compact `hot-index.json` (capped ~200KB, produced by
 * `brain/hot-index.js`), which loads in <10ms. Full retrieval stays in
 * `aios brain ask`; L8 injects hints + pointers.
 *
 * Coupling: this layer does NOT require brain/indexer.js — doing so would pay
 * that module's load cost (fast-glob + chunker + lexical-search) on every
 * prompt. The workspace-hash helper below is a small, documented MIRROR of
 * `BrainIndexer.defaultBrainDir`; loadHotIndex() from brain/hot-index.js is
 * intentionally cheap to require (fs/os/path only).
 *
 * @module core/synapse/layers/l8-workspace-knowledge
 * @version 1.0.0
 * @created Story WSB-1.5 - SYNAPSE L8 (Workspace Knowledge)
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LayerProcessor = require('./layer-processor');
const { loadHotIndex } = require('../../brain/hot-index');

/** Max entity hints emitted per prompt. */
const MAX_ENTITY_HINTS = 5;

/** Max area pointers emitted per prompt. */
const MAX_AREA_HINTS = 3;

/** Minimum token length considered for prompt matching. */
const MIN_TOKEN_LENGTH = 3;

/** Short area-summary slice appended to an area pointer (chars). */
const AREA_SUMMARY_SLICE = 120;

/**
 * Brackets in which L8 must stay silent even if it is somehow invoked. The
 * PRIMARY gate is upstream: context-tracker's LAYER_CONFIGS only lists layer 8
 * for FRESH/MODERATE, so the engine never calls L8 in DEPLETED/CRITICAL. This
 * set is a defensive belt-and-suspenders check for callers that DO pass a
 * bracket into the context (the current engine does not).
 * @type {Set<string>}
 */
const SILENT_BRACKETS = new Set(['DEPLETED', 'CRITICAL']);

/**
 * L8 Workspace Knowledge Processor.
 *
 * Loads the compact hot index, matches prompt tokens against entity
 * names/aliases and area names (word-boundary, case-insensitive, ≥3 chars),
 * and emits compact hint rules with source pointers.
 *
 * @extends LayerProcessor
 */
class L8WorkspaceKnowledgeProcessor extends LayerProcessor {
  constructor() {
    super({ name: 'workspace-knowledge', layer: 8, timeout: 15 });
  }

  /**
   * Match workspace knowledge against the prompt and emit hint rules.
   *
   * Returns null (never throws) when there is no hot index, no workspace, no
   * match, or on any error — zero impact on the pipeline.
   *
   * @param {object} context
   * @param {string} context.prompt - Current prompt text.
   * @param {object} context.config - Config (may carry `cwd` and/or `brainDir`).
   * @param {string} [context.config.cwd] - Workspace cwd (defaults to process.cwd()).
   * @param {string} [context.config.brainDir] - Explicit brainDir override (tests/DI).
   * @param {string} [context.bracket] - Optional bracket hint (defensive gating).
   * @returns {{ rules: string[], metadata: object } | null}
   */
  process(context) {
    const { prompt, config } = context || {};
    if (!prompt || typeof prompt !== 'string') return null;

    // Defensive budget gate. In the real pipeline the engine already skips L8 in
    // tight brackets (context-tracker), so `context.bracket` is normally absent.
    if (context.bracket && SILENT_BRACKETS.has(context.bracket)) return null;

    const brainDir = this._resolveBrainDir(config);
    if (!brainDir) return null;

    const hot = loadHotIndex(brainDir);
    if (!hot) return null;

    const tokens = tokenizePrompt(prompt);
    if (tokens.size === 0) return null;

    const matchedEntities = matchEntities(hot.entities || [], tokens, prompt);
    const matchedAreas = matchAreas(hot.areaIndexes || [], tokens, prompt);

    if (matchedEntities.length === 0 && matchedAreas.length === 0) return null;

    const rules = [];

    for (const e of matchedEntities.slice(0, MAX_ENTITY_HINTS)) {
      const desc = e.description ? ` — ${e.description}` : '';
      const source = e.topSource ? ` | fonte: ${e.topSource}` : '';
      rules.push(`Entidade: ${e.name} (${e.type})${desc}${source}`);
    }

    for (const a of matchedAreas.slice(0, MAX_AREA_HINTS)) {
      const summary = a.summary
        ? ` — ${firstLine(a.summary, AREA_SUMMARY_SLICE)}`
        : '';
      rules.push(`Área ${a.area}: documentos em ${a.path}${summary}`);
    }

    if (rules.length === 0) return null;

    return {
      rules,
      metadata: {
        layer: 8,
        source: 'hot-index',
        matched: {
          entities: Math.min(matchedEntities.length, MAX_ENTITY_HINTS),
          areas: Math.min(matchedAreas.length, MAX_AREA_HINTS),
        },
      },
    };
  }

  /**
   * Resolve the brainDir from config. Order: explicit `config.brainDir` (DI) →
   * workspace-hash of `config.cwd` → workspace-hash of `process.cwd()`.
   *
   * @param {object} [config]
   * @returns {string|null}
   * @private
   */
  _resolveBrainDir(config) {
    const cfg = config || {};
    if (cfg.brainDir) return cfg.brainDir;
    const cwd = cfg.cwd || process.cwd();
    return workspaceBrainDir(cwd);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MODULE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Compute the brainDir for a workspace path. MIRROR of
 * `BrainIndexer.defaultBrainDir` (short sha256 of the resolved workspace path
 * under ~/.aiox/brain/<hash>). Duplicated deliberately to avoid requiring
 * brain/indexer.js inside the per-prompt hook. Keep in sync with the indexer.
 *
 * @param {string} workspacePath - Absolute workspace path.
 * @returns {string}
 */
function workspaceBrainDir(workspacePath) {
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 12);
  return path.join(os.homedir(), '.aiox', 'brain', hash);
}

/**
 * Tokenise a prompt into a set of lowercase words (≥3 chars) for matching.
 *
 * @param {string} prompt - Prompt text.
 * @returns {Set<string>}
 */
function tokenizePrompt(prompt) {
  const set = new Set();
  const matches = String(prompt).toLowerCase().match(/[a-z0-9à-ÿ]+/g) || [];
  for (const w of matches) {
    if (w.length >= MIN_TOKEN_LENGTH) set.add(w);
  }
  return set;
}

/**
 * Whether a candidate name/alias matches the prompt. Multi-word candidates are
 * matched as a case-insensitive word-boundary substring; single words are
 * matched against the token set.
 *
 * @param {string} candidate - Entity name / alias / area name.
 * @param {Set<string>} tokens - Prompt tokens.
 * @param {string} lowerPrompt - Lowercased full prompt.
 * @returns {boolean}
 */
function candidateMatches(candidate, tokens, lowerPrompt) {
  const value = String(candidate || '').trim().toLowerCase();
  if (value.length < MIN_TOKEN_LENGTH) return false;

  if (/\s/.test(value)) {
    // Multi-word — word-boundary substring match against the full prompt.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(lowerPrompt);
  }
  return tokens.has(value);
}

/**
 * Match hot-index entities against the prompt (by name or any alias).
 *
 * @param {Array} entities - hot.entities.
 * @param {Set<string>} tokens - Prompt tokens.
 * @param {string} prompt - Raw prompt.
 * @returns {Array} Matched entities (original order preserved).
 */
function matchEntities(entities, tokens, prompt) {
  const lowerPrompt = prompt.toLowerCase();
  const out = [];
  for (const e of entities) {
    if (!e || !e.name) continue;
    const names = [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])];
    if (names.some((n) => candidateMatches(n, tokens, lowerPrompt))) {
      out.push(e);
    }
  }
  return out;
}

/**
 * Match hot-index area entries against the prompt (by area name).
 *
 * @param {Array} areaIndexes - hot.areaIndexes.
 * @param {Set<string>} tokens - Prompt tokens.
 * @param {string} prompt - Raw prompt.
 * @returns {Array} Matched areas (original order preserved).
 */
function matchAreas(areaIndexes, tokens, prompt) {
  const lowerPrompt = prompt.toLowerCase();
  const out = [];
  for (const a of areaIndexes) {
    if (!a || !a.area) continue;
    if (candidateMatches(a.area, tokens, lowerPrompt)) out.push(a);
  }
  return out;
}

/**
 * First line of a summary, collapsed and sliced to `max` chars.
 *
 * @param {string} summary - Area summary.
 * @param {number} max - Char ceiling.
 * @returns {string}
 */
function firstLine(summary, max) {
  const flat = String(summary || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

module.exports = L8WorkspaceKnowledgeProcessor;
