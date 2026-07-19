/**
 * @fileoverview Token & Cost Ledger — deterministic, local telemetry (Story WSB-4.5).
 *
 * The ledger is pure code: zero LLM, zero network. It appends one JSON line per
 * AI call to `.aios/telemetry/usage.jsonl`, computing the USD cost from the
 * `pricing` block of the capability matrix. A model without pricing still gets
 * its tokens recorded (cost `null`).
 *
 * Agent activity (who is doing what) is a separate append-only stream
 * (`.aios/telemetry/activity.jsonl`) consumed by the dashboard.
 *
 * Design guarantees:
 *   - Synchronous, best-effort appends (appendFileSync) — never throws to the
 *     caller path when used through the try/catch hooks.
 *   - Pricing is loaded lazily and defensively; a broken matrix degrades to
 *     `costUsd: null` rather than crashing telemetry.
 *
 * @module core/telemetry/ledger
 * @version 1.0.0
 * @created Story WSB-4.5 — Token Telemetry
 */

const fs = require('fs');
const path = require('path');

/** Telemetry directory relative to a project root. */
const TELEMETRY_RELDIR = path.join('.aios', 'telemetry');
/** Usage ledger filename. */
const USAGE_FILE = 'usage.jsonl';
/** Agent activity filename. */
const ACTIVITY_FILE = 'activity.jsonl';

/**
 * Rough token estimate for text that has no provider-reported usage.
 * Heuristic: ~4 characters per token.
 *
 * @param {string} text - Arbitrary text (prompt or output).
 * @returns {number} Estimated token count (>= 0).
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Coerce a value to a finite, non-negative integer (defaults to 0).
 * @param {*} value - Candidate number.
 * @returns {number}
 */
function toTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/**
 * Resolve the telemetry directory for a project, creating it if needed.
 * @param {string} cwd - Project root.
 * @returns {string} Absolute path to the telemetry directory.
 */
function ensureTelemetryDir(cwd) {
  const dir = path.resolve(cwd || process.cwd(), TELEMETRY_RELDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Look up the pricing block for a model from the capability matrix.
 * Loaded lazily and wrapped in try/catch so a broken/missing matrix never
 * breaks telemetry — it simply yields `null` (no cost).
 *
 * @param {string} model - Model id (matches capability-matrix `models` key).
 * @param {string} [cwd] - Project root (for project matrix override).
 * @returns {Object|null} Pricing object or null when unavailable.
 */
function getPricing(model, cwd) {
  if (!model) return null;
  try {
    // Lazy require: avoids a hard dependency cycle and keeps telemetry optional.
    const { loadMatrix } = require('../router/matrix-loader');
    const matrix = loadMatrix({ projectRoot: cwd });
    const entry = matrix && matrix.models ? matrix.models[model] : null;
    return entry && entry.pricing ? entry.pricing : null;
  } catch {
    return null;
  }
}

/**
 * Compute the USD cost of a usage entry from a pricing block.
 * Returns `null` when pricing is absent (tokens are still recorded elsewhere).
 *
 * @param {Object} tokens - Normalized token counts.
 * @param {number} tokens.inputTokens
 * @param {number} tokens.outputTokens
 * @param {number} tokens.cachedInputTokens
 * @param {number} tokens.cacheWriteTokens
 * @param {Object|null} pricing - Pricing block (per_mtok) or null.
 * @returns {number|null} Cost in USD, or null when no pricing.
 */
function computeCost(tokens, pricing) {
  if (!pricing) return null;
  const inRate = Number(pricing.input_per_mtok) || 0;
  const outRate = Number(pricing.output_per_mtok) || 0;
  const cachedRate = Number(pricing.cached_input_per_mtok) || 0;
  const writeRate = Number(pricing.cache_write_per_mtok) || 0;

  const micros =
    tokens.inputTokens * inRate +
    tokens.outputTokens * outRate +
    tokens.cachedInputTokens * cachedRate +
    tokens.cacheWriteTokens * writeRate;

  return micros / 1e6;
}

/**
 * Record a single AI usage event: append one JSON line to `usage.jsonl` with the
 * computed cost. Best-effort and synchronous.
 *
 * @param {Object} entry - Usage entry.
 * @param {string} entry.provider - Provider slug (grok, claude, ...).
 * @param {string} [entry.model] - Model id (used for pricing lookup).
 * @param {number} [entry.inputTokens=0] - Prompt tokens.
 * @param {number} [entry.outputTokens=0] - Completion tokens.
 * @param {number} [entry.cachedInputTokens=0] - Cached input tokens.
 * @param {number} [entry.cacheWriteTokens=0] - Cache-write tokens.
 * @param {string} [entry.agent] - Agent id that triggered the call.
 * @param {string} [entry.storyId] - Story id in flight.
 * @param {string} [entry.project] - Project name.
 * @param {string} [entry.source] - Origin of the record (e.g. 'ai-provider').
 * @param {boolean} [entry.estimated=false] - True when tokens were estimated.
 * @param {Object} [opts]
 * @param {string} [opts.cwd] - Project root (defaults to process.cwd()).
 * @returns {Object|null} The persisted record, or null if it could not be written.
 */
function recordUsage(entry = {}, opts = {}) {
  const cwd = opts.cwd || process.cwd();

  const tokens = {
    inputTokens: toTokenCount(entry.inputTokens),
    outputTokens: toTokenCount(entry.outputTokens),
    cachedInputTokens: toTokenCount(entry.cachedInputTokens),
    cacheWriteTokens: toTokenCount(entry.cacheWriteTokens),
  };

  const pricing = getPricing(entry.model, cwd);
  const costUsd = computeCost(tokens, pricing);

  const record = {
    ts: new Date().toISOString(),
    provider: entry.provider || 'unknown',
    model: entry.model || null,
    ...tokens,
    costUsd,
    agent: entry.agent || null,
    storyId: entry.storyId || null,
    project: entry.project || null,
    source: entry.source || null,
    estimated: Boolean(entry.estimated),
  };

  try {
    const dir = ensureTelemetryDir(cwd);
    fs.appendFileSync(path.join(dir, USAGE_FILE), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch {
    return null;
  }
}

/**
 * Record an agent activity event (who is doing what) to `activity.jsonl`.
 * Feeds the "active agents" view of the dashboard. Best-effort, synchronous.
 *
 * @param {Object} entry - Activity entry.
 * @param {string} entry.agent - Agent id.
 * @param {string} entry.action - Action label (e.g. 'develop-story', 'route').
 * @param {string} [entry.storyId] - Story id in flight.
 * @param {string} [entry.project] - Project name.
 * @param {Object} [opts]
 * @param {string} [opts.cwd] - Project root.
 * @returns {Object|null} The persisted record, or null on failure.
 */
function recordAgentActivity(entry = {}, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const record = {
    ts: new Date().toISOString(),
    agent: entry.agent || 'unknown',
    action: entry.action || null,
    storyId: entry.storyId || null,
    project: entry.project || null,
  };

  try {
    const dir = ensureTelemetryDir(cwd);
    fs.appendFileSync(path.join(dir, ACTIVITY_FILE), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch {
    return null;
  }
}

module.exports = {
  estimateTokens,
  recordUsage,
  recordAgentActivity,
  computeCost,
  getPricing,
  TELEMETRY_RELDIR,
  USAGE_FILE,
  ACTIVITY_FILE,
};
