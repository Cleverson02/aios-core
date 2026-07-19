/**
 * Heartbeat — Autonomy Engine (Story WSB-3.3)
 *
 * A long autonomous run needs a pulse. The Heartbeat attaches to an
 * AutonomousBuildLoop (Story 8.1) and listens to its *real* events. Every N
 * completed subtasks it emits a `heartbeat` (checkpoint marker + optional
 * context-zone self-assessment). When the same subtask fails twice it detects
 * a stuck condition, escalates, and emits `stuck_detected`.
 *
 * Design guarantees:
 * - The Heartbeat NEVER derails the build (AC4): every event handler is wrapped
 *   in try/catch total — a throwing listener or a missing dependency is
 *   swallowed and logged, never re-thrown into the loop.
 * - Zero new dependencies. `budgetManager` and `escalate` are dependency-
 *   injected (defaults resolved lazily so this module loads even before its
 *   siblings exist).
 *
 * Real build-loop events consumed (see `execution/autonomous-build-loop.js`
 * `BuildEvent`):
 *   - `build_started`        → payload `{ storyId, ... }` (captures storyId)
 *   - `subtask_completed`    → payload `{ subtaskId, iteration, duration, filesModified }`
 *   - `iteration_completed`  → payload `{ subtaskId, iteration, success, error }`
 *                              (the genuine PER-ATTEMPT failure signal — fires with
 *                              `success: false` on every failed iteration)
 *   - `subtask_failed`       → payload `{ subtaskId, attempts, error }` (terminal,
 *                              only after maxIterations; NOT used for stuck
 *                              detection since `iteration_completed` already
 *                              captures each failure)
 *
 * Checkpoint strategy (documented, collision-safe):
 * The build loop already persists a checkpoint via `BuildStateManager
 * .completeSubtask()` on every subtask completion. To avoid duplicate/colliding
 * checkpoint entries the Heartbeat writes its OWN marker to
 * `.aios/autonomy/heartbeats.json` and only calls `BuildStateManager
 * .saveCheckpoint()` when the loaded state does NOT already contain the
 * subtask (i.e. when running standalone without the loop's own checkpointing).
 *
 * @module core/autonomy/heartbeat
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/** Pulse every 3 completed subtasks by default. */
const DEFAULT_INTERVAL_SUBTASKS = 3;
/** Same subtask failing this many times → stuck. */
const DEFAULT_STUCK_THRESHOLD = 2;

/** Runtime artifacts live under `.aios/autonomy/` (session-local, gitignored). */
const HEARTBEATS_FILE = path.join('.aios', 'autonomy', 'heartbeats.json');
/** Keep the marker file bounded on very long runs. */
const MAX_MARKERS = 200;

/** Real event names emitted by AutonomousBuildLoop (Story 8.1). */
const BuildLoopEvent = {
  BUILD_STARTED: 'build_started',
  SUBTASK_COMPLETED: 'subtask_completed',
  ITERATION_COMPLETED: 'iteration_completed',
  SUBTASK_FAILED: 'subtask_failed',
};

class Heartbeat extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.intervalSubtasks=3] - Completed subtasks between pulses.
   * @param {string} [options.cwd] - Working directory for artifacts (default cwd).
   * @param {Object|null} [options.budgetManager] - DI ContextBudgetManager instance.
   *   `undefined` → lazily build the real one (null if the module is absent).
   * @param {Function} [options.escalate] - DI escalation function
   *   `({reason, context, cwd}) => Promise`. Defaults to `./escalation`.escalate.
   * @param {number} [options.stuckThreshold=2] - Failures on the same subtask → stuck.
   */
  constructor(options = {}) {
    super();

    this.intervalSubtasks =
      options.intervalSubtasks > 0 ? options.intervalSubtasks : DEFAULT_INTERVAL_SUBTASKS;
    this.stuckThreshold =
      options.stuckThreshold > 0 ? options.stuckThreshold : DEFAULT_STUCK_THRESHOLD;
    this.cwd = options.cwd || process.cwd();

    // budgetManager: honour explicit injection (including null), else lazy default.
    this.budgetManager =
      'budgetManager' in options ? options.budgetManager : this._defaultBudgetManager();

    // escalate: honour explicit injection, else lazy default from ./escalation.
    this.escalateFn =
      typeof options.escalate === 'function' ? options.escalate : this._defaultEscalate();

    // Runtime state.
    this.buildLoop = null;
    this.subtaskCounter = 0;
    this.pulseCounter = 0;
    this.storyId = options.storyId || null;
    this.failuresBySubtask = new Map(); // subtaskId → { attempts, lastError }
    this.escalatedSubtasks = new Set();

    // Bound handler references so detach() can remove exactly what attach() added.
    this._boundHandlers = {
      [BuildLoopEvent.BUILD_STARTED]: (p) => this._onBuildStarted(p),
      [BuildLoopEvent.SUBTASK_COMPLETED]: (p) => this._onSubtaskCompleted(p),
      [BuildLoopEvent.ITERATION_COMPLETED]: (p) => this._onIterationCompleted(p),
      [BuildLoopEvent.SUBTASK_FAILED]: (p) => this._onSubtaskFailed(p),
    };

    this.markerPath = path.join(this.cwd, HEARTBEATS_FILE);
  }

  /**
   * Attach to an AutonomousBuildLoop (or any EventEmitter emitting the same
   * real event names). Registers listeners; idempotent-ish (a second attach
   * without detach will double-register, so callers should detach first).
   *
   * @param {import('events').EventEmitter} buildLoop - The build loop to observe.
   * @returns {Heartbeat} this (for chaining).
   */
  attach(buildLoop) {
    if (!buildLoop || typeof buildLoop.on !== 'function') {
      throw new Error('Heartbeat.attach requires an EventEmitter-like buildLoop');
    }
    this.buildLoop = buildLoop;
    for (const [event, handler] of Object.entries(this._boundHandlers)) {
      buildLoop.on(event, handler);
    }
    return this;
  }

  /**
   * Remove all listeners previously registered via {@link attach}.
   *
   * @returns {Heartbeat} this (for chaining).
   */
  detach() {
    if (this.buildLoop && typeof this.buildLoop.removeListener === 'function') {
      for (const [event, handler] of Object.entries(this._boundHandlers)) {
        this.buildLoop.removeListener(event, handler);
      }
    }
    this.buildLoop = null;
    return this;
  }

  /**
   * Current counters snapshot.
   *
   * @returns {{subtasks: number, pulses: number, failing: number,
   *   escalated: number, storyId: (string|null)}}
   */
  getStats() {
    return {
      subtasks: this.subtaskCounter,
      pulses: this.pulseCounter,
      failing: this.failuresBySubtask.size,
      escalated: this.escalatedSubtasks.size,
      storyId: this.storyId,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //                              EVENT HANDLERS (AC4: try/catch total)
  // ─────────────────────────────────────────────────────────────────────────

  /** @private Capture the story id from the build_started payload. */
  _onBuildStarted(payload = {}) {
    try {
      if (payload && payload.storyId) {
        this.storyId = payload.storyId;
      }
    } catch {
      // A heartbeat must never derail the build (AC4).
    }
  }

  /** @private Count completions and pulse every `intervalSubtasks`. */
  _onSubtaskCompleted(payload = {}) {
    try {
      const subtaskId = payload && payload.subtaskId;
      // A completed subtask is no longer "failing".
      if (subtaskId != null) {
        this.failuresBySubtask.delete(subtaskId);
      }

      this.subtaskCounter += 1;

      if (this.subtaskCounter % this.intervalSubtasks === 0) {
        this._pulse(payload);
      }
    } catch {
      // AC4: swallow — never re-throw into the loop.
    }
  }

  /** @private Per-attempt failure signal → stuck detection. */
  _onIterationCompleted(payload = {}) {
    try {
      // Only failed iterations matter for stuck detection.
      if (!payload || payload.success !== false) {
        return;
      }
      this._registerFailure(payload.subtaskId, payload.error);
    } catch {
      // AC4.
    }
  }

  /**
   * @private Terminal subtask failure (after maxIterations). Documented as NOT
   * driving stuck detection (iteration_completed already counts each attempt),
   * but we surface it as a `subtask_terminal_failure` event for observers.
   */
  _onSubtaskFailed(payload = {}) {
    try {
      this.emit('subtask_terminal_failure', {
        subtaskId: payload && payload.subtaskId,
        attempts: payload && payload.attempts,
        error: payload && payload.error,
        storyId: this.storyId,
      });
    } catch {
      // AC4.
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //                              CORE LOGIC
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @private Register a failed attempt for a subtask and escalate on stuck.
   * Escalates at most once per subtask.
   */
  _registerFailure(subtaskId, error) {
    if (subtaskId == null) {
      return;
    }

    const rec = this.failuresBySubtask.get(subtaskId) || { attempts: 0, lastError: null };
    rec.attempts += 1;
    rec.lastError = error != null ? error : rec.lastError;
    this.failuresBySubtask.set(subtaskId, rec);

    if (rec.attempts >= this.stuckThreshold && !this.escalatedSubtasks.has(subtaskId)) {
      this.escalatedSubtasks.add(subtaskId);

      const context = {
        subtaskId,
        attempts: rec.attempts,
        lastError: rec.lastError,
        storyId: this.storyId,
      };

      // Fire the escalation (async). Swallow any rejection — AC4.
      try {
        const maybePromise = this.escalateFn({ reason: 'stuck', context, cwd: this.cwd });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch(() => {
            /* escalation failure must never derail the build */
          });
        }
      } catch {
        // AC4: even a synchronous throw from escalate is contained.
      }

      // Observability hook for the CLI / dashboards.
      this.emit('stuck_detected', { ...context });
    }
  }

  /**
   * @private Emit a heartbeat pulse: write a marker, best-effort checkpoint,
   * optional context-zone assessment.
   */
  _pulse(payload = {}) {
    this.pulseCounter += 1;
    const timestamp = new Date().toISOString();
    const subtaskId = payload && payload.subtaskId;

    // (a) Own marker + collision-safe BuildStateManager checkpoint.
    const checkpoint = this._checkpoint(subtaskId, timestamp);

    // (b) Context-zone self-assessment (only when a percent signal is present).
    const zone = this._assessZone(payload);

    this.emit('heartbeat', {
      storyId: this.storyId,
      subtasks: this.subtaskCounter,
      pulse: this.pulseCounter,
      subtaskId: subtaskId != null ? subtaskId : null,
      checkpoint,
      zone,
      timestamp,
    });
  }

  /**
   * @private Write the heartbeat marker and, without colliding with the build
   * loop's own checkpoints, attempt a BuildStateManager checkpoint.
   *
   * @returns {{markerWritten: boolean, stateCheckpointed: boolean}}
   */
  _checkpoint(subtaskId, timestamp) {
    const result = { markerWritten: false, stateCheckpointed: false };

    // Own marker — always attempted.
    try {
      result.markerWritten = this._writeMarker({
        timestamp,
        storyId: this.storyId,
        subtasks: this.subtaskCounter,
        subtaskId: subtaskId != null ? subtaskId : null,
      });
    } catch {
      // Marker is advisory; never fatal.
    }

    // BuildStateManager checkpoint (REUSE), collision-safe.
    try {
      if (this.storyId) {
        const { BuildStateManager } = require('../execution/build-state-manager');
        const manager = new BuildStateManager(this.storyId, { rootPath: this.cwd });
        const state = manager.loadState();
        // Only checkpoint if the loop has NOT already recorded this subtask,
        // avoiding duplicate checkpoint entries / completedSubtasks collisions.
        if (
          state &&
          subtaskId != null &&
          Array.isArray(state.completedSubtasks) &&
          !state.completedSubtasks.includes(subtaskId)
        ) {
          manager.saveCheckpoint(subtaskId, { status: 'heartbeat' });
          result.stateCheckpointed = true;
        }
      }
    } catch {
      // No build state (or API absent) → the marker alone is enough.
    }

    return result;
  }

  /**
   * @private Assess the context zone via the budget manager, when a percent
   * signal is available on the payload. Returns null when unavailable (skips).
   *
   * @returns {Object|null} Zone evaluation result or null.
   */
  _assessZone(payload = {}) {
    try {
      if (!this.budgetManager) {
        return null;
      }
      const percentUsed =
        typeof payload.percentUsed === 'number'
          ? payload.percentUsed
          : typeof payload.contextPercent === 'number'
            ? payload.contextPercent
            : undefined;

      if (typeof percentUsed !== 'number') {
        return null; // No signal → skip zone evaluation (documented).
      }

      if (typeof this.budgetManager.evaluate === 'function') {
        return this.budgetManager.evaluate({ percentUsed });
      }
      if (typeof this.budgetManager.calculateZone === 'function') {
        return { zone: this.budgetManager.calculateZone(percentUsed) };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * @private Append a heartbeat marker to `.aios/autonomy/heartbeats.json`.
   *
   * @returns {boolean} Whether the marker was written.
   */
  _writeMarker(marker) {
    const dir = path.dirname(this.markerPath);
    fs.mkdirSync(dir, { recursive: true });

    let doc = { updatedAt: null, heartbeats: [] };
    try {
      if (fs.existsSync(this.markerPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.markerPath, 'utf8'));
        if (parsed && Array.isArray(parsed.heartbeats)) {
          doc = parsed;
        }
      }
    } catch {
      // Corrupt/foreign file → start a fresh document.
      doc = { updatedAt: null, heartbeats: [] };
    }

    doc.heartbeats.push(marker);
    if (doc.heartbeats.length > MAX_MARKERS) {
      doc.heartbeats = doc.heartbeats.slice(-MAX_MARKERS);
    }
    doc.updatedAt = marker.timestamp;
    doc.storyId = this.storyId;

    fs.writeFileSync(this.markerPath, JSON.stringify(doc, null, 2), 'utf8');
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //                              LAZY DI DEFAULTS
  // ─────────────────────────────────────────────────────────────────────────

  /** @private Lazily build a ContextBudgetManager instance (null if absent). */
  _defaultBudgetManager() {
    try {
      const mod = require('./context-budget-manager');
      if (mod && typeof mod.ContextBudgetManager === 'function') {
        return new mod.ContextBudgetManager({ projectRoot: this.cwd });
      }
      return null;
    } catch {
      // Sibling module may not exist yet — that's fine (AC1).
      return null;
    }
  }

  /** @private Lazily resolve the escalation function from ./escalation. */
  _defaultEscalate() {
    return (args) => {
      try {
        const { escalate } = require('./escalation');
        return escalate({ ...args, cwd: (args && args.cwd) || this.cwd });
      } catch {
        // Escalation module missing → no-op (contained by caller's try/catch).
        return Promise.resolve({ notified: false, filePath: null, surface: null });
      }
    };
  }
}

module.exports = {
  Heartbeat,
  // Back-compat aliases so the WSB-3.3 barrel keeps resolving defined symbols.
  HeartbeatMonitor: Heartbeat,
  DEFAULT_INTERVAL_SUBTASKS,
  DEFAULT_INTERVAL: DEFAULT_INTERVAL_SUBTASKS,
  DEFAULT_STUCK_THRESHOLD,
  BuildLoopEvent,
};
