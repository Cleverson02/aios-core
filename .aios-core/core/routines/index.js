'use strict';

/**
 * AIOS Routines — Barrel (Story WSB-5.2).
 *
 * Scheduled routines: keep the workspace brain fresh (nightly re-index, daily
 * digest) and surface opportunities (weekly radar), with optional Telegram
 * delivery — a *client of the CLI* (Constitution Art. I). Zero LLM tokens, zero
 * new dependencies, full graceful degradation.
 *
 * Public surface:
 *   - loadRoutines / saveRoutines / setEnabled / getRoutine → registry.
 *   - nextRunAt / parseSchedule                             → pure schedule math.
 *   - TASK_HANDLERS / runRoutine / runDueRoutines / startScheduler → execution.
 *   - routinesCommand                                       → `aios routines …`.
 *
 * @module core/routines
 * @author @dev (Dex)
 * @version 1.0.0
 */

const registry = require('./registry');
const scheduler = require('./scheduler');
const cli = require('./cli');

module.exports = {
  // registry
  loadRoutines: registry.loadRoutines,
  saveRoutines: registry.saveRoutines,
  setEnabled: registry.setEnabled,
  getRoutine: registry.getRoutine,
  validateSchedule: registry.validateSchedule,
  buildDefaults: registry.buildDefaults,
  // scheduler
  nextRunAt: scheduler.nextRunAt,
  parseSchedule: scheduler.parseSchedule,
  TASK_HANDLERS: scheduler.TASK_HANDLERS,
  runRoutine: scheduler.runRoutine,
  runDueRoutines: scheduler.runDueRoutines,
  startScheduler: scheduler.startScheduler,
  readState: scheduler.readState,
  // cli
  routinesCommand: cli.routinesCommand,
  isDaemonRunning: cli.isDaemonRunning,
};
