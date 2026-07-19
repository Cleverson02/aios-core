/**
 * Dashboard Server — AIOX Cortex Observability (Story WSB-4.7).
 *
 * A zero-dependency, local-only HTTP server that *observes* the workspace brain
 * and never controls it (Constitution Art. I). Every view is a deterministic
 * aggregation of on-disk artifacts written by other subsystems:
 *
 *   costs / telemetry ← `.aios/telemetry/{usage,activity}.jsonl` (WSB-4.5)
 *   agents            ← telemetry activity + report.getActiveAgents
 *   builds            ← execution/build-state-manager (REUSE)
 *   zones             ← `.aios/autonomy/zone-log.json`         (WSB-3.1)
 *   handoffs          ← `.aios/autonomy/handoffs/*.json`       (WSB-3.2)
 *   escalations       ← `.aios/autonomy/escalations/*.md`      (WSB-3.3)
 *
 * Design guarantees:
 *   - Binds EXPLICITLY to 127.0.0.1 — never 0.0.0.0 (AC3). Local-only, so no
 *     auth and no CORS headers are emitted (documented, AC3).
 *   - Missing/corrupt data never crashes a request: read errors resolve to a
 *     `200 { error }` friendly payload and empty sources yield empty arrays,
 *     so the front-end renders "empty states with instructions" (AC5).
 *   - Zero new dependencies (pure `http`/`fs`/`path`) and zero LLM.
 *
 * @module core/dashboard/server
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  aggregate,
  getActiveAgents,
  GROUP_KEYS,
  DEFAULT_ACTIVE_WINDOW_MS,
} = require('../telemetry/report');
const { TELEMETRY_RELDIR, USAGE_FILE, ACTIVITY_FILE } = require('../telemetry/ledger');

/** Default dashboard port. */
const DEFAULT_PORT = 4801;
/** Loopback bind address — local-only, never 0.0.0.0 (AC3). */
const HOST = '127.0.0.1';
/** Static assets directory (self-contained index.html). */
const PUBLIC_DIR = path.join(__dirname, 'public');
/** Autonomy runtime artifacts, relative to a project root. */
const AUTONOMY_RELDIR = path.join('.aios', 'autonomy');

/** Default number of recent activity rows returned by /api/agents. */
const ACTIVITY_TAIL = 50;
/** Default number of raw usage rows returned by /api/telemetry. */
const TELEMETRY_TAIL = 100;
/** Default number of zone transitions returned by /api/builds. */
const ZONE_LOG_TAIL = 20;

/** Default since-window for the costs view. */
const DEFAULT_SINCE = '7d';

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FACTORY
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Create a dashboard HTTP server bound to loopback.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root to observe (default process.cwd()).
 * @param {number} [options.port=4801] - Listen port (0 → ephemeral, resolved on start).
 * @returns {{server: import('http').Server, start: () => Promise<{port:number, host:string, url:string}>, stop: () => Promise<void>, port: number}}
 */
function createDashboardServer({ cwd = process.cwd(), port = DEFAULT_PORT } = {}) {
  const ctx = { cwd, startedAt: Date.now() };
  let boundPort = port;

  const server = http.createServer((req, res) => {
    // Last-resort guard: a handler must never crash the process (AC5).
    Promise.resolve()
      .then(() => handleRequest(req, res, ctx))
      .catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 200, { error: friendly(err) });
        }
      });
  });

  const api = {
    server,
    /**
     * Begin listening on 127.0.0.1.
     * @returns {Promise<{port:number, host:string, url:string}>}
     */
    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, HOST, () => {
          server.removeListener('error', onError);
          const addr = server.address();
          boundPort = addr && typeof addr === 'object' ? addr.port : port;
          resolve({ port: boundPort, host: HOST, url: `http://${HOST}:${boundPort}` });
        });
      });
    },
    /**
     * Stop listening.
     * @returns {Promise<void>}
     */
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };

  // `port` is a live getter so it reflects the real port after an ephemeral bind.
  Object.defineProperty(api, 'port', {
    enumerable: true,
    get() {
      return boundPort;
    },
  });

  return api;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              REQUEST DISPATCH
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Route a single request. GET-only; `/` serves the SPA, `/api/*` serves JSON.
 *
 * @private
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{cwd:string, startedAt:number}} ctx
 * @returns {Promise<void>}
 */
async function handleRequest(req, res, ctx) {
  const url = new URL(req.url, `http://${HOST}`);
  const pathname = url.pathname;

  if (req.method !== 'GET') {
    sendJson(res, 404, { error: `Método não suportado: ${req.method}` });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendIndex(res);
    return;
  }

  if (pathname.startsWith('/api/')) {
    const query = Object.fromEntries(url.searchParams.entries());
    try {
      const data = await routeApi(pathname, query, ctx);
      if (data === undefined) {
        sendJson(res, 404, { error: `Endpoint desconhecido: ${pathname}` });
        return;
      }
      sendJson(res, 200, data);
    } catch (err) {
      // AC5: read errors degrade to a friendly 200 payload, never a 500.
      sendJson(res, 200, { error: friendly(err) });
    }
    return;
  }

  sendJson(res, 404, { error: `Não encontrado: ${pathname}` });
}

/**
 * Map an /api/* path to its handler result.
 *
 * @private
 * @param {string} pathname
 * @param {Object} query
 * @param {{cwd:string, startedAt:number}} ctx
 * @returns {Promise<Object|undefined>} Handler payload, or undefined for 404.
 */
async function routeApi(pathname, query, ctx) {
  switch (pathname) {
    case '/api/costs':
      return handleCosts(ctx.cwd, query);
    case '/api/agents':
      return handleAgents(ctx.cwd);
    case '/api/builds':
      return handleBuilds(ctx.cwd);
    case '/api/telemetry':
      return handleTelemetry(ctx.cwd, query);
    case '/api/health':
      return handleHealth(ctx);
    default:
      return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENDPOINT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/costs?by=provider|model|agent|storyId|day&since=7d`
 * Deterministic aggregation of the usage ledger via telemetry/report (REUSE).
 *
 * @private
 * @param {string} cwd
 * @param {Object} query
 * @returns {Promise<Object>}
 */
async function handleCosts(cwd, query) {
  const by = GROUP_KEYS.includes(query.by) ? query.by : 'provider';
  const since = query.since || DEFAULT_SINCE;
  const { groups, totals } = await aggregate({ cwd, groupBy: by, since });
  return { by, since, groups, totals };
}

/**
 * `GET /api/agents` — currently-active agents (15min window) + recent activity.
 *
 * @private
 * @param {string} cwd
 * @returns {Promise<Object>}
 */
async function handleAgents(cwd) {
  const active = await getActiveAgents({ cwd, windowMs: DEFAULT_ACTIVE_WINDOW_MS });
  const activityPath = path.join(cwd, TELEMETRY_RELDIR, ACTIVITY_FILE);
  // Newest-first timeline of the last N activity records.
  const recent = tailJsonl(activityPath, ACTIVITY_TAIL).reverse();
  return { active, recent, windowMs: DEFAULT_ACTIVE_WINDOW_MS };
}

/**
 * `GET /api/builds` — build states + recent zone transitions + handoff packets
 * + pending escalations (a `.md` with no sibling `.decision.json`).
 *
 * @private
 * @param {string} cwd
 * @returns {Promise<Object>}
 */
async function handleBuilds(cwd) {
  return {
    builds: readBuilds(cwd),
    zones: readZoneLog(cwd, ZONE_LOG_TAIL),
    handoffs: readHandoffs(cwd),
    escalations: readPendingEscalations(cwd),
  };
}

/**
 * `GET /api/telemetry?limit=100` — the last N raw usage records for the
 * filterable telemetry table (AC2). Newest-first.
 *
 * @private
 * @param {string} cwd
 * @param {Object} query
 * @returns {Promise<Object>}
 */
async function handleTelemetry(cwd, query) {
  const limit = clampLimit(query.limit, TELEMETRY_TAIL);
  const usagePath = path.join(cwd, TELEMETRY_RELDIR, USAGE_FILE);
  const calls = tailJsonl(usagePath, limit).reverse();
  return { calls, count: calls.length };
}

/**
 * `GET /api/health` — liveness + identity.
 *
 * @private
 * @param {{cwd:string, startedAt:number}} ctx
 * @returns {Object}
 */
function handleHealth(ctx) {
  return {
    ok: true,
    version: getVersion(),
    cwd: ctx.cwd,
    uptime: Date.now() - ctx.startedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DATA READERS (never throw)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * All build states via BuildStateManager.getAllBuilds (REUSE, consume-only).
 * @private
 * @param {string} cwd
 * @returns {Object[]}
 */
function readBuilds(cwd) {
  try {
    const { BuildStateManager } = require('../execution/build-state-manager');
    return BuildStateManager.getAllBuilds(cwd) || [];
  } catch {
    return [];
  }
}

/**
 * Recent zone transitions from `.aios/autonomy/zone-log.json` (JSON array).
 * @private
 * @param {string} cwd
 * @param {number} limit
 * @returns {Object[]}
 */
function readZoneLog(cwd, limit) {
  try {
    const logPath = path.join(cwd, AUTONOMY_RELDIR, 'zone-log.json');
    if (!fs.existsSync(logPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : [];
    return limit ? arr.slice(-limit).reverse() : arr.reverse();
  } catch {
    return [];
  }
}

/**
 * Handoff packets: `.json` twins in `.aios/autonomy/handoffs/` (name + mtime).
 * @private
 * @param {string} cwd
 * @returns {Array<{name:string, storyId:(string|null), mtime:string}>}
 */
function readHandoffs(cwd) {
  const dir = path.join(cwd, AUTONOMY_RELDIR, 'handoffs');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((name) => {
        const stat = safeStat(path.join(dir, name));
        return {
          name,
          storyId: name.replace(/-\d+\.json$/, '') || null,
          mtime: stat ? stat.mtime.toISOString() : null,
        };
      })
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  } catch {
    return [];
  }
}

/**
 * Pending escalations: `.md` records in `.aios/autonomy/escalations/` with no
 * sibling `<id>.decision.json` (matches gateway/escalation-watcher convention).
 * @private
 * @param {string} cwd
 * @returns {Array<{name:string, title:string, mtime:string}>}
 */
function readPendingEscalations(cwd) {
  const dir = path.join(cwd, AUTONOMY_RELDIR, 'escalations');
  try {
    if (!fs.existsSync(dir)) return [];
    const names = fs.readdirSync(dir);
    const pending = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const id = name.replace(/\.md$/, '');
      if (names.includes(`${id}.decision.json`)) continue; // already handled
      const full = path.join(dir, name);
      const stat = safeStat(full);
      pending.push({
        name,
        title: firstHeading(full) || name,
        mtime: stat ? stat.mtime.toISOString() : null,
      });
    }
    return pending.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Serve the self-contained SPA. Never throws — a missing asset degrades to a
 * plain-text notice instead of crashing the server.
 * @private
 * @param {import('http').ServerResponse} res
 */
function sendIndex(res) {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('AIOX Cortex dashboard: index.html indisponível.');
  }
}

/**
 * Write a JSON response. No CORS headers are emitted (local-only, AC3).
 * @private
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {Object} obj
 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              LOW-LEVEL UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Read the last `limit` JSONL records from a file, tolerating corrupt lines and
 * a missing file (returns []). Files are small (append-only ledgers).
 * @private
 * @param {string} filePath
 * @param {number} [limit]
 * @returns {Object[]}
 */
function tailJsonl(filePath, limit) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const slice = limit ? lines.slice(-limit) : lines;
    const out = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // tolerate corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * First markdown heading of a file (without the leading `#`s), or null.
 * @private
 * @param {string} filePath
 * @returns {string|null}
 */
function firstHeading(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = raw.match(/^#{1,6}\s+(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * fs.statSync that returns null instead of throwing.
 * @private
 * @param {string} filePath
 * @returns {import('fs').Stats|null}
 */
function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Coerce a query `limit` to a positive integer, falling back to a default.
 * @private
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 1000);
}

/**
 * Read the framework version from the root package.json (best-effort).
 * @private
 * @returns {string}
 */
function getVersion() {
  try {
    return require('../../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Build a friendly, human-readable error message for degraded responses (AC5).
 * @private
 * @param {*} err
 * @returns {string}
 */
function friendly(err) {
  const msg = err && err.message ? err.message : String(err);
  return `Não foi possível ler os dados de observabilidade: ${msg}`;
}

module.exports = {
  createDashboardServer,
  DEFAULT_PORT,
  HOST,
};
