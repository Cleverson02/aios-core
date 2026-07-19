/**
 * @fileoverview Telemetry Reporting — streaming aggregation (Story WSB-4.5).
 *
 * Reads the append-only JSONL ledgers line-by-line (via readline over a read
 * stream, so it never loads the whole file into memory) and produces grouped
 * totals of tokens and cost. Corrupt lines are tolerated and skipped.
 *
 * @module core/telemetry/report
 * @version 1.0.0
 * @created Story WSB-4.5 — Token Telemetry
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { TELEMETRY_RELDIR, USAGE_FILE, ACTIVITY_FILE } = require('./ledger');

/** Valid groupBy dimensions for {@link aggregate}. */
const GROUP_KEYS = ['provider', 'model', 'agent', 'storyId', 'project', 'day'];

/** Default activity window: 15 minutes. */
const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Parse a `since` value into an epoch-ms lower bound.
 * Accepts:
 *   - relative durations: `<n>d` (days), `<n>h` (hours), `<n>m` (minutes)
 *   - an ISO-8601 timestamp
 *   - null/undefined → no lower bound (returns 0)
 *
 * @param {string|number|Date|null} since - The since specifier.
 * @param {number} [now=Date.now()] - Reference "now" (injectable for tests).
 * @returns {number} Epoch-ms lower bound (0 = no bound).
 */
function parseSince(since, now = Date.now()) {
  if (since === null || since === undefined || since === '') return 0;
  if (since instanceof Date) return since.getTime();
  if (typeof since === 'number') return since;

  const str = String(since).trim();
  const rel = /^(\d+)\s*([dhm])$/i.exec(str);
  if (rel) {
    const value = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const factor = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
    return now - value * factor;
  }

  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Derive the group key for a record given a groupBy dimension.
 * @param {Object} rec - Parsed usage record.
 * @param {string} groupBy - One of {@link GROUP_KEYS}.
 * @returns {string} Group key (never empty; falls back to 'unknown').
 */
function groupKeyFor(rec, groupBy) {
  if (groupBy === 'day') {
    // ISO date portion (YYYY-MM-DD) from the record timestamp.
    return typeof rec.ts === 'string' ? rec.ts.slice(0, 10) : 'unknown';
  }
  const value = rec[groupBy];
  return value === undefined || value === null || value === '' ? 'unknown' : String(value);
}

/**
 * Stream a JSONL file line-by-line, invoking `onRecord` for each parsed object.
 * Corrupt lines are silently skipped. Resolves when the stream ends; resolves
 * immediately (no-op) when the file does not exist.
 *
 * @param {string} filePath - Absolute path to the JSONL file.
 * @param {(rec: Object) => void} onRecord - Per-record callback.
 * @returns {Promise<void>}
 */
function streamJsonl(filePath, onRecord) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      resolve();
      return;
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    stream.on('error', reject);

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        return; // tolerate corrupt line
      }
      if (rec && typeof rec === 'object') {
        onRecord(rec);
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

/**
 * Aggregate the usage ledger into grouped totals.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root (defaults to process.cwd()).
 * @param {string} [options.groupBy='provider'] - One of {@link GROUP_KEYS}.
 * @param {string|number|Date} [options.since] - Lower time bound ('7d','24h',ISO).
 * @param {number} [options.now] - Reference "now" for relative `since` (tests).
 * @returns {Promise<{groups: Array<Object>, totals: Object}>}
 */
async function aggregate({ cwd, groupBy = 'provider', since, now } = {}) {
  const dimension = GROUP_KEYS.includes(groupBy) ? groupBy : 'provider';
  const lowerBound = parseSince(since, now);
  const filePath = path.resolve(cwd || process.cwd(), TELEMETRY_RELDIR, USAGE_FILE);

  /** @type {Map<string, Object>} */
  const buckets = new Map();
  const totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    estimatedCalls: 0,
  };

  await streamJsonl(filePath, (rec) => {
    // Time filter (records without a parseable ts are kept only when no bound).
    if (lowerBound > 0) {
      const ts = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
      if (Number.isNaN(ts) || ts < lowerBound) return;
    }

    const key = groupKeyFor(rec, dimension);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        estimatedCalls: 0,
      };
      buckets.set(key, bucket);
    }

    const input = Number(rec.inputTokens) || 0;
    const output = Number(rec.outputTokens) || 0;
    const cached = Number(rec.cachedInputTokens) || 0;
    const cost = typeof rec.costUsd === 'number' ? rec.costUsd : 0;
    const estimated = rec.estimated === true;

    bucket.calls += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    bucket.cachedInputTokens += cached;
    bucket.costUsd += cost;
    if (estimated) bucket.estimatedCalls += 1;

    totals.calls += 1;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cachedInputTokens += cached;
    totals.costUsd += cost;
    if (estimated) totals.estimatedCalls += 1;
  });

  const groups = [...buckets.values()]
    .map((b) => ({
      key: b.key,
      calls: b.calls,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cachedInputTokens: b.cachedInputTokens,
      costUsd: b.costUsd,
      estimatedPct: b.calls > 0 ? (b.estimatedCalls / b.calls) * 100 : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  return {
    groups,
    totals: {
      calls: totals.calls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      costUsd: totals.costUsd,
      estimatedPct: totals.calls > 0 ? (totals.estimatedCalls / totals.calls) * 100 : 0,
    },
  };
}

/**
 * List agents that have recorded activity within the given window.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root.
 * @param {number} [options.windowMs=900000] - Look-back window (default 15min).
 * @param {number} [options.now=Date.now()] - Reference "now" (tests).
 * @returns {Promise<Array<{agent: string, action: string|null, storyId: string|null, project: string|null, ts: string, lastSeenMsAgo: number}>>}
 */
async function getActiveAgents({ cwd, windowMs = DEFAULT_ACTIVE_WINDOW_MS, now = Date.now() } = {}) {
  const filePath = path.resolve(cwd || process.cwd(), TELEMETRY_RELDIR, ACTIVITY_FILE);
  const lowerBound = now - windowMs;

  /** @type {Map<string, Object>} */
  const latest = new Map();

  await streamJsonl(filePath, (rec) => {
    if (!rec.agent) return;
    const ts = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
    if (Number.isNaN(ts) || ts < lowerBound) return;

    const existing = latest.get(rec.agent);
    if (!existing || ts > existing._ts) {
      latest.set(rec.agent, {
        agent: rec.agent,
        action: rec.action || null,
        storyId: rec.storyId || null,
        project: rec.project || null,
        ts: rec.ts,
        _ts: ts,
      });
    }
  });

  return [...latest.values()]
    .sort((a, b) => b._ts - a._ts)
    .map((a) => ({
      agent: a.agent,
      action: a.action,
      storyId: a.storyId,
      project: a.project,
      ts: a.ts,
      lastSeenMsAgo: now - a._ts,
    }));
}

module.exports = {
  aggregate,
  getActiveAgents,
  parseSince,
  GROUP_KEYS,
  DEFAULT_ACTIVE_WINDOW_MS,
};
