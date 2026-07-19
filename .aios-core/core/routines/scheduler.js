'use strict';

/**
 * AIOS Routines — Scheduler (Story WSB-5.2, AC2/AC3).
 *
 * A light daemon in the exact shape of the gateway's escalation watcher: a
 * `setInterval` tick (default 60s) that, for every ENABLED routine, checks
 * whether a scheduled slot has elapsed since its last run and, if so, executes
 * the routine's deterministic handler.
 *
 * WHY setInterval + a persisted `.aios/routines-state.json` (and NOT cron / a
 * native scheduler dependency): routines fire at human cadence (hours/days), the
 * registry is tiny, and a 60s tick costs nothing. Persisting `lastRunAt` lets the
 * schedule survive restarts — if the process was down over a scheduled slot the
 * next tick performs a **single** catch-up run (never a burst, even if many slots
 * were missed), because immediately after running we stamp `lastRunAt = now` and
 * the next `nextRunAt(schedule, lastRunAt)` lands in the future.
 *
 * `nextRunAt` is pure (no I/O) and fully testable with fake timers.
 *
 * Zero new dependencies. Handlers reach the real modules (brain / radar / gateway)
 * via LAZY require wrapped in try/catch, so a not-yet-built module degrades to a
 * `{ ok:false, reason }` result instead of throwing.
 *
 * @module core/routines/scheduler
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const { loadRoutines } = require('./registry');

/** State file (survives restart) relative to the workspace root. */
const STATE_FILE = path.join('.aios', 'routines-state.json');

/** JSONL execution log relative to the workspace root. */
const LOG_FILE = path.join('.aios', 'routines', 'log.jsonl');

/** Default tick interval. */
const DEFAULT_INTERVAL_MS = 60000;

/** JS getDay() index for each weekday token (Sunday = 0). */
const DOW_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// ═══════════════════════════════════════════════════════════════════════════════
//                              PURE — NEXT RUN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a schedule string into a structured spec.
 *
 * @param {string} schedule - `daily@HH:MM` | `weekly@DOW HH:MM` | `monthly@D HH:MM`.
 * @returns {{kind: string, hour: number, minute: number, dow?: number, day?: number}}
 */
function parseSchedule(schedule) {
  const s = String(schedule || '').trim();
  let m;

  if ((m = s.match(/^daily@(\d{1,2}):(\d{2})$/))) {
    return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]) };
  }
  if ((m = s.match(/^weekly@([a-z]{3})\s+(\d{1,2}):(\d{2})$/i))) {
    const dow = DOW_INDEX[m[1].toLowerCase()];
    if (dow === undefined) throw new Error(`Dia da semana inválido: ${m[1]}`);
    return { kind: 'weekly', dow, hour: Number(m[2]), minute: Number(m[3]) };
  }
  if ((m = s.match(/^monthly@(\d{1,2})\s+(\d{1,2}):(\d{2})$/))) {
    return { kind: 'monthly', day: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) };
  }

  throw new Error(`Schedule inválido: ${s}`);
}

/**
 * Compute the next scheduled execution STRICTLY AFTER `from`. Pure; uses local
 * time consistently. Monthly days are clamped to the last day of short months
 * (e.g. `monthly@31` fires on Feb 28/29).
 *
 * @param {string} schedule - Schedule string.
 * @param {Date|number|string} [from] - Reference instant (defaults to now).
 * @returns {Date} Next run instant (> from).
 */
function nextRunAt(schedule, from = new Date()) {
  const spec = parseSchedule(schedule);
  const base = from instanceof Date ? from : new Date(from);

  if (spec.kind === 'daily') return nextDaily(spec, base);
  if (spec.kind === 'weekly') return nextWeekly(spec, base);
  return nextMonthly(spec, base);
}

/**
 * Build a local Date; day/month overflow is normalised by the Date constructor.
 * @param {number} year
 * @param {number} monthIndex - 0-based month.
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {Date}
 */
function at(year, monthIndex, day, hour, minute) {
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

/**
 * @param {{hour: number, minute: number}} spec
 * @param {Date} from
 * @returns {Date}
 */
function nextDaily(spec, from) {
  let d = at(from.getFullYear(), from.getMonth(), from.getDate(), spec.hour, spec.minute);
  if (d <= from) {
    d = at(from.getFullYear(), from.getMonth(), from.getDate() + 1, spec.hour, spec.minute);
  }
  return d;
}

/**
 * @param {{dow: number, hour: number, minute: number}} spec
 * @param {Date} from
 * @returns {Date}
 */
function nextWeekly(spec, from) {
  const delta = (spec.dow - from.getDay() + 7) % 7;
  let d = at(from.getFullYear(), from.getMonth(), from.getDate() + delta, spec.hour, spec.minute);
  if (d <= from) {
    d = at(from.getFullYear(), from.getMonth(), from.getDate() + delta + 7, spec.hour, spec.minute);
  }
  return d;
}

/**
 * @param {{day: number, hour: number, minute: number}} spec
 * @param {Date} from
 * @returns {Date}
 */
function nextMonthly(spec, from) {
  const build = (year, monthIndex) => {
    const day = Math.min(spec.day, daysInMonth(year, monthIndex));
    return at(year, monthIndex, day, spec.hour, spec.minute);
  };

  let year = from.getFullYear();
  let month = from.getMonth();
  let d = build(year, month);
  if (d <= from) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    d = build(year, month);
  }
  return d;
}

/**
 * Number of days in a given month.
 * @param {number} year
 * @param {number} monthIndex - 0-based month.
 * @returns {number}
 */
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              TASK HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic task handlers. Each returns `{ ok, summary? , reason? }` and NEVER
 * throws: a missing/failed target module degrades to `{ ok:false, reason }`.
 *
 * Exported (mutable) so tests can inject doubles without hitting the real modules.
 *
 * @type {Object<string, (ctx: {cwd: string}) => Promise<{ok: boolean, summary?: string, reason?: string}>>}
 */
const TASK_HANDLERS = {
  'brain-index': async ({ cwd }) => {
    let brain;
    try {
      brain = require('../brain');
    } catch (_err) {
      return { ok: false, reason: 'brain-module-unavailable' };
    }
    try {
      const r = await new brain.BrainIndexer({ cwd }).index({ incremental: true });
      return { ok: true, summary: `${r.filesIndexed} indexado(s), ${r.chunks} chunk(s)` };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  'brain-digest': async ({ cwd }) => {
    let brain;
    try {
      brain = require('../brain');
    } catch (_err) {
      return { ok: false, reason: 'brain-module-unavailable' };
    }
    try {
      const r = await brain.generateDigest({ cwd });
      const s = r.sections || {};
      return {
        ok: true,
        summary: `digest ${path.basename(r.path)} — ${s.commits || 0} commit(s), ${s.files || 0} arquivo(s)`,
      };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  // core/radar is built by a parallel agent and may not exist yet → graceful.
  'radar-scan': (ctx) => runRadar('scan', ctx),
  'radar-report': (ctx) => runRadar('report', ctx),
};

/**
 * Invoke the radar module via lazy require. Tries a programmatic API first, then
 * falls back to the CLI command; a missing module degrades to `{ ok:false }`.
 *
 * @param {string} sub - `scan` | `report`.
 * @param {{cwd: string}} ctx
 * @returns {Promise<{ok: boolean, summary?: string, reason?: string}>}
 */
async function runRadar(sub, { cwd }) {
  let radar;
  try {
    radar = require('../radar');
  } catch (_err) {
    return { ok: false, reason: 'radar-module-unavailable' };
  }
  try {
    const fnName = sub === 'scan' ? 'runScan' : 'runReport';
    if (typeof radar[fnName] === 'function') {
      const r = await radar[fnName]({ cwd });
      return { ok: true, summary: summarizeRadar(sub, r) };
    }
    if (typeof radar.radarCommand === 'function') {
      const code = await radar.radarCommand([sub]);
      return { ok: code === 0, summary: `radar ${sub} (exit ${code})`, reason: code === 0 ? undefined : `exit ${code}` };
    }
    return { ok: false, reason: 'radar-handler-unavailable' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * @param {string} sub
 * @param {Object} r - Radar result (shape unknown until WSB-5.1 lands).
 * @returns {string}
 */
function summarizeRadar(sub, r) {
  if (r && Array.isArray(r.findings)) return `radar ${sub} — ${r.findings.length} achado(s)`;
  if (r && r.path) return `radar ${sub} — ${path.basename(r.path)}`;
  return `radar ${sub} ok`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              RUN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a routine by name: run its handler, persist state, log, and (when the
 * routine opts in) deliver a Telegram notification. Never throws.
 *
 * @param {string} name - Routine name.
 * @param {Object} [params]
 * @param {string} [params.cwd] - Workspace root.
 * @returns {Promise<{name: string, ok: boolean, summary?: string, reason?: string, ranAt: string}>}
 */
async function runRoutine(name, { cwd = process.cwd() } = {}) {
  const ranAt = new Date().toISOString();
  const routines = loadRoutines({ cwd });
  const routine = routines.find((r) => r.name === name);

  if (!routine) {
    const result = { name, ok: false, reason: 'unknown-routine', ranAt };
    logEvent(cwd, { event: 'run', ...result });
    return result;
  }

  const handler = TASK_HANDLERS[routine.task];
  let outcome;
  if (typeof handler !== 'function') {
    outcome = { ok: false, reason: `no-handler:${routine.task}` };
  } else {
    try {
      outcome = await handler({ cwd });
    } catch (err) {
      outcome = { ok: false, reason: err.message };
    }
  }

  const result = { name, task: routine.task, ok: Boolean(outcome.ok), ranAt };
  if (outcome.summary) result.summary = outcome.summary;
  if (outcome.reason) result.reason = outcome.reason;

  // Persist state (summarised) — survives restart, drives catch-up.
  const state = readState(cwd);
  state[name] = {
    lastRunAt: ranAt,
    lastResult: { ok: result.ok, summary: result.summary || null, reason: result.reason || null },
  };
  writeState(cwd, state);
  logEvent(cwd, { event: 'run', ...result });

  // AC3 — optional Telegram delivery (graceful: no token/pairing → just log).
  if (routine.notify === 'telegram') {
    await notify(cwd, routine, result);
  }

  return result;
}

/**
 * Deliver a routine result to Telegram via the gateway (REUSE of notifyTelegram).
 * Fully guarded — a missing token / no paired chats / missing module only logs.
 *
 * @param {string} cwd - Workspace root.
 * @param {Object} routine - The routine.
 * @param {Object} result - Run result.
 * @returns {Promise<void>}
 */
async function notify(cwd, routine, result) {
  try {
    const { notifyTelegram } = require('../gateway');
    const title = `🧠 Rotina ${routine.name} — ${result.ok ? 'ok' : 'falhou'}`;
    const body = result.ok ? result.summary || 'Concluída.' : `Falhou: ${result.reason || 'motivo desconhecido'}`;
    const delivery = await notifyTelegram({ title, body });
    logEvent(cwd, { event: 'notify', name: routine.name, delivered: delivery && delivery.notified, reason: delivery && delivery.reason });
  } catch (err) {
    logEvent(cwd, { event: 'notify', name: routine.name, delivered: false, reason: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              TICK / DAEMON
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run every routine that is due at `now`. A routine is due when it is enabled and
 * `now >= nextRunAt(schedule, ref)`, where `ref` is its last run (or its creation
 * time when it has never run). CATCH-UP GUARANTEE: at most ONE run per routine per
 * tick, regardless of how many slots elapsed while the daemon was down.
 *
 * @param {Object} [params]
 * @param {string} [params.cwd] - Workspace root.
 * @param {Date} [params.now] - Injectable clock (tests).
 * @returns {Promise<Array<{name: string, due: boolean, result?: Object}>>}
 */
async function runDueRoutines({ cwd = process.cwd(), now = new Date() } = {}) {
  const routines = loadRoutines({ cwd });
  const state = readState(cwd);
  const results = [];

  for (const routine of routines) {
    if (!routine.enabled) {
      results.push({ name: routine.name, due: false });
      continue;
    }

    const prev = state[routine.name];
    const ref = prev && prev.lastRunAt
      ? new Date(prev.lastRunAt)
      : routine.createdAt
        ? new Date(routine.createdAt)
        : now;

    let due = false;
    try {
      due = now >= nextRunAt(routine.schedule, ref);
    } catch (err) {
      logEvent(cwd, { event: 'schedule_error', name: routine.name, reason: err.message });
      due = false;
    }

    if (!due) {
      results.push({ name: routine.name, due: false });
      continue;
    }

    // One catch-up execution; runRoutine stamps lastRunAt=now so the next tick
    // (and any additional missed slots) will not re-fire within this window.
    const result = await runRoutine(routine.name, { cwd });
    results.push({ name: routine.name, due: true, result });
  }

  return results;
}

/**
 * Start the scheduler daemon: an interval tick that runs due routines.
 *
 * @param {Object} [params]
 * @param {string} [params.cwd] - Workspace root.
 * @param {number} [params.intervalMs=60000] - Tick interval.
 * @param {boolean} [params.immediate=true] - Run a catch-up tick immediately.
 * @param {boolean} [params.unref=true] - unref() the timer (tests / non-blocking).
 * @returns {{stop: Function, tick: Function}} Controller.
 */
function startScheduler({ cwd = process.cwd(), intervalMs = DEFAULT_INTERVAL_MS, immediate = true, unref = true } = {}) {
  const tick = async () => {
    try {
      await runDueRoutines({ cwd });
    } catch (err) {
      logEvent(cwd, { event: 'tick_error', reason: err.message });
    }
  };

  if (immediate) {
    tick();
  }

  const timer = setInterval(tick, intervalMs);
  if (unref && timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
    tick,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              STATE / LOG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read `.aios/routines-state.json` (never throws → `{}` on any problem).
 *
 * @param {string} cwd - Workspace root.
 * @returns {Object}
 */
function readState(cwd) {
  try {
    const file = path.join(cwd, STATE_FILE);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_err) {
    return {};
  }
}

/**
 * Write `.aios/routines-state.json` (best-effort).
 *
 * @param {string} cwd - Workspace root.
 * @param {Object} state - State map (name → { lastRunAt, lastResult }).
 */
function writeState(cwd, state) {
  try {
    const file = path.join(cwd, STATE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch (_err) {
    // Best-effort: a state write failure must never break the scheduler.
  }
}

/**
 * Append a JSON line to `.aios/routines/log.jsonl` (best-effort, never throws).
 *
 * @param {string} cwd - Workspace root.
 * @param {Object} event - Serializable event fields.
 */
function logEvent(cwd, event) {
  try {
    const file = path.join(cwd, LOG_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    fs.appendFileSync(file, line, 'utf8');
  } catch (_err) {
    // Logging is best-effort.
  }
}

module.exports = {
  // pure
  nextRunAt,
  parseSchedule,
  // handlers
  TASK_HANDLERS,
  // run
  runRoutine,
  runDueRoutines,
  startScheduler,
  // state
  readState,
  writeState,
  STATE_FILE,
  LOG_FILE,
};
