'use strict';

/**
 * AIOS Routines — Registry (Story WSB-5.2, AC1).
 *
 * Persists scheduled routines in `.aios/routines.yaml`. A routine is:
 *   { name, task, schedule, notify, enabled, createdAt }
 *
 *   task     ∈ brain-index | brain-digest | radar-scan | radar-report
 *   schedule ∈ daily@HH:MM | weekly@DOW HH:MM | monthly@D HH:MM  (DOW ∈ mon..sun)
 *   notify   ∈ telegram | none
 *
 * On the FIRST load (no file yet) the AC1 defaults are created and persisted:
 *   - brain-index   daily@03:00   enabled:false  notify:none   (nightly re-index, opt-in)
 *   - brain-digest  daily@18:00   enabled:true   notify:none   (daily digest)
 *   - radar-scan    weekly@mon 09:00 enabled:true notify:telegram (weekly opportunity radar)
 *
 * Zero new dependencies: native fs/path + existing js-yaml.
 *
 * @module core/routines/registry
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const yaml = require('js-yaml');

/** Registry file path relative to the workspace root. */
const ROUTINES_FILE = path.join('.aios', 'routines.yaml');

/** Registry schema version. */
const REGISTRY_VERSION = 1;

/** Valid task identifiers. */
const VALID_TASKS = ['brain-index', 'brain-digest', 'radar-scan', 'radar-report'];

/** Valid notify channels. */
const VALID_NOTIFY = ['telegram', 'none'];

/** Weekday tokens accepted in a `weekly@DOW` schedule. */
const VALID_DOW = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// ═══════════════════════════════════════════════════════════════════════════════
//                              PUBLIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load the routines registry. When the file does not exist yet the AC1 defaults
 * are created, persisted and returned (first-use bootstrap).
 *
 * @param {Object} [params]
 * @param {string} [params.cwd] - Workspace root (defaults to process.cwd()).
 * @returns {Array<Object>} The list of routine objects.
 */
function loadRoutines({ cwd = process.cwd() } = {}) {
  const file = path.join(cwd, ROUTINES_FILE);

  if (!fs.existsSync(file)) {
    const defaults = buildDefaults();
    saveRoutines({ cwd, routines: defaults });
    return defaults;
  }

  let parsed;
  try {
    parsed = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    throw new Error(`Falha ao ler ${ROUTINES_FILE}: ${err.message}`);
  }

  const routines = Array.isArray(parsed.routines) ? parsed.routines : [];
  routines.forEach(validateRoutine);
  return routines;
}

/**
 * Persist the routines registry (validates every routine first).
 *
 * @param {Object} params
 * @param {string} [params.cwd] - Workspace root (defaults to process.cwd()).
 * @param {Array<Object>} params.routines - Routine objects to write.
 * @returns {string} Absolute path of the written file.
 */
function saveRoutines({ cwd = process.cwd(), routines } = {}) {
  if (!Array.isArray(routines)) {
    throw new Error('saveRoutines: `routines` deve ser um array.');
  }
  routines.forEach(validateRoutine);

  const file = path.join(cwd, ROUTINES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const doc = { version: REGISTRY_VERSION, routines };
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
  return file;
}

/**
 * Enable or disable a routine by name and persist the change.
 *
 * @param {Object} params
 * @param {string} [params.cwd] - Workspace root (defaults to process.cwd()).
 * @param {string} params.name - Routine name.
 * @param {boolean} params.enabled - Desired enabled state.
 * @returns {Object} The updated routine.
 */
function setEnabled({ cwd = process.cwd(), name, enabled } = {}) {
  const routines = loadRoutines({ cwd });
  const routine = routines.find((r) => r.name === name);
  if (!routine) {
    throw new Error(`Rotina desconhecida: ${name}`);
  }
  routine.enabled = Boolean(enabled);
  saveRoutines({ cwd, routines });
  return routine;
}

/**
 * Look up a routine by name from the current registry.
 *
 * @param {Object} params
 * @param {string} [params.cwd] - Workspace root.
 * @param {string} params.name - Routine name.
 * @returns {Object|null} The routine, or null when absent.
 */
function getRoutine({ cwd = process.cwd(), name } = {}) {
  return loadRoutines({ cwd }).find((r) => r.name === name) || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              DEFAULTS + VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the AC1 default routine set (fresh createdAt timestamps).
 *
 * @returns {Array<Object>}
 */
function buildDefaults() {
  const createdAt = new Date().toISOString();
  return [
    { name: 'brain-index', task: 'brain-index', schedule: 'daily@03:00', notify: 'none', enabled: false, createdAt },
    { name: 'brain-digest', task: 'brain-digest', schedule: 'daily@18:00', notify: 'none', enabled: true, createdAt },
    { name: 'radar-scan', task: 'radar-scan', schedule: 'weekly@mon 09:00', notify: 'telegram', enabled: true, createdAt },
  ];
}

/**
 * Validate a routine object. Throws a clear, actionable error on any problem.
 *
 * @param {Object} routine - Routine to validate.
 * @param {number} [idx] - Index in the list (for error context).
 */
function validateRoutine(routine, idx) {
  const where = routine && routine.name ? `rotina "${routine.name}"` : `rotina #${idx ?? '?'}`;

  if (!routine || typeof routine !== 'object') {
    throw new Error(`Registro inválido em ${where}: esperado um objeto.`);
  }
  if (!routine.name || typeof routine.name !== 'string') {
    throw new Error(`${where}: campo "name" ausente ou inválido.`);
  }
  if (!VALID_TASKS.includes(routine.task)) {
    throw new Error(`${where}: task "${routine.task}" inválida (use ${VALID_TASKS.join(' | ')}).`);
  }
  if (routine.notify !== undefined && !VALID_NOTIFY.includes(routine.notify)) {
    throw new Error(`${where}: notify "${routine.notify}" inválido (use ${VALID_NOTIFY.join(' | ')}).`);
  }
  validateSchedule(routine.schedule, where);
}

/**
 * Light validation of a schedule string. Throws with a clear message when the
 * format or a field range is wrong.
 *
 * @param {string} schedule - Schedule string.
 * @param {string} [where] - Context for the error message.
 * @returns {true} When valid.
 */
function validateSchedule(schedule, where = 'schedule') {
  if (typeof schedule !== 'string' || !schedule.trim()) {
    throw new Error(`${where}: schedule ausente. Use daily@HH:MM | weekly@DOW HH:MM | monthly@D HH:MM.`);
  }
  const s = schedule.trim();

  let m;
  if ((m = s.match(/^daily@(\d{1,2}):(\d{2})$/))) {
    assertTime(Number(m[1]), Number(m[2]), s, where);
    return true;
  }
  if ((m = s.match(/^weekly@([a-z]{3})\s+(\d{1,2}):(\d{2})$/i))) {
    if (!VALID_DOW.includes(m[1].toLowerCase())) {
      throw new Error(`${where}: dia da semana "${m[1]}" inválido (use ${VALID_DOW.join('|')}).`);
    }
    assertTime(Number(m[2]), Number(m[3]), s, where);
    return true;
  }
  if ((m = s.match(/^monthly@(\d{1,2})\s+(\d{1,2}):(\d{2})$/))) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) {
      throw new Error(`${where}: dia do mês "${day}" fora de 1..31 em "${s}".`);
    }
    assertTime(Number(m[2]), Number(m[3]), s, where);
    return true;
  }

  throw new Error(
    `${where}: schedule "${s}" inválido. Use daily@HH:MM | weekly@DOW HH:MM | monthly@D HH:MM.`,
  );
}

/**
 * Assert that hour/minute are within range.
 *
 * @param {number} hour - Hour value.
 * @param {number} minute - Minute value.
 * @param {string} s - Original schedule (for the message).
 * @param {string} where - Context.
 */
function assertTime(hour, minute, s, where) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`${where}: horário fora de faixa em "${s}" (HH 0-23, MM 0-59).`);
  }
}

module.exports = {
  loadRoutines,
  saveRoutines,
  setEnabled,
  getRoutine,
  validateSchedule,
  buildDefaults,
  ROUTINES_FILE,
  VALID_TASKS,
  VALID_NOTIFY,
  VALID_DOW,
};
