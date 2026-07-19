/**
 * Context Budget Manager — Autonomy Engine (Story WSB-3.1)
 *
 * Maps context usage onto three actionable zones and decides what the long-run
 * autonomy engine should do next:
 *
 *   GREEN  (< yellow% used)         → continue: plenty of window left.
 *   YELLOW (>= yellow, < red% used) → compress: shrink the accumulated epic
 *                                     context via the EpicContextAccumulator
 *                                     (REUSE, Story 12.4).
 *   RED    (>= red% used)           → handoff: prepare a handoff packet /
 *                                     fresh window (WSB-3.2).
 *
 * The class is an EventEmitter so callers can react to zone changes in real
 * time (`zone_changed`, `compress_triggered`, `handoff_recommended`). Every
 * zone transition is appended to `.aios/autonomy/zone-log.json` so long
 * sessions leave an auditable trail.
 *
 * REUSE / decisions (IDS):
 * - `synapse/context/context-tracker` (SYN-3) owns the real SYNAPSE brackets
 *   (FRESH/MODERATE/DEPLETED/CRITICAL). `zoneFromBracket` maps those onto zones
 *   using the tracker's real thresholds — see the mapping table below.
 * - `orchestration/epic-context-accumulator` (Story 12.4) performs the
 *   yellow-zone compression. It is required lazily so a missing module degrades
 *   gracefully (AC5) instead of breaking the autonomy loop at import time.
 *
 * Zero new dependencies; pure fs/path + existing core modules.
 *
 * @module core/autonomy/context-budget-manager
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * Zone names, ordered from healthiest to most critical.
 * @readonly
 * @enum {string}
 */
const Zone = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  RED: 'RED',
};

/**
 * Action recommended for each zone.
 * @readonly
 * @enum {string}
 */
const ZONE_ACTIONS = {
  [Zone.GREEN]: 'continue',
  [Zone.YELLOW]: 'compress',
  [Zone.RED]: 'handoff',
};

/**
 * Human-readable recommendation per zone.
 * @readonly
 */
const ZONE_RECOMMENDATIONS = {
  [Zone.GREEN]: 'Context healthy — continue execution.',
  [Zone.YELLOW]: 'Context filling — compress accumulated epic context before continuing.',
  [Zone.RED]: 'Context near limit — prepare handoff packet and spawn a fresh window.',
};

/**
 * Default zone thresholds, expressed as percent of context USED.
 * @readonly
 */
const DEFAULT_THRESHOLDS = {
  yellow: 60, // >= 60% used → YELLOW
  red: 80, // >= 80% used → RED
};

/** Events emitted by ContextBudgetManager. */
const Events = {
  ZONE_CHANGED: 'zone_changed',
  COMPRESS_TRIGGERED: 'compress_triggered',
  HANDOFF_RECOMMENDED: 'handoff_recommended',
};

/** Runtime artifacts live under `.aios/autonomy/` (session-local, gitignored). */
const AUTONOMY_DIR = path.join('.aios', 'autonomy');
const ZONE_LOG = 'zone-log.json';

/**
 * SYNAPSE bracket → zone mapping (AC3).
 *
 * The SYNAPSE context-tracker (SYN-3) expresses brackets as a function of
 * context *remaining* (0–100). Zones here are a function of context *used*
 * (used = 100 − remaining). Converting each bracket's real remaining-range to a
 * used-range and applying the default zone thresholds (yellow=60, red=80):
 *
 *   Bracket   remaining% (real)   used% (=100−remaining)   default zone
 *   ────────  ─────────────────   ──────────────────────   ────────────
 *   FRESH     [60, 100]           [0, 40]                  GREEN  (used < 60 throughout)
 *   MODERATE  [40, 60)            (40, 60]                 GREEN  (bulk < 60; touches the
 *                                                          YELLOW edge only at used=60)
 *   DEPLETED  [25, 40)            (60, 75]                 YELLOW (60 <= used < 80 throughout;
 *                                                          never reaches red=80)
 *   CRITICAL  [0, 25)             (75, 100]                RED    (spans the YELLOW→RED edge but
 *                                                          the tracker raises handoffWarning
 *                                                          here, so it maps to the handoff zone)
 *
 * Numbers are taken directly from context-tracker `calculateBracket`
 * (>=60 FRESH, >=40 MODERATE, >=25 DEPLETED, else CRITICAL). Unknown brackets
 * map to RED — the conservative choice, mirroring the tracker treating unknown
 * input as CRITICAL.
 * @readonly
 */
const BRACKET_TO_ZONE = {
  FRESH: Zone.GREEN,
  MODERATE: Zone.GREEN,
  DEPLETED: Zone.YELLOW,
  CRITICAL: Zone.RED,
};

/**
 * Resolve a zone from the percentage of context used.
 *
 * Boundaries: `< yellow` → GREEN; `>= yellow && < red` → YELLOW; `>= red` → RED.
 *
 * @param {number} percentUsed - Percent of the window consumed (0–100).
 * @param {{yellow?: number, red?: number}} [thresholds]
 * @returns {string} Zone.GREEN | Zone.YELLOW | Zone.RED
 */
function calculateZone(percentUsed, thresholds = {}) {
  const { yellow = DEFAULT_THRESHOLDS.yellow, red = DEFAULT_THRESHOLDS.red } = thresholds;

  if (typeof percentUsed !== 'number' || Number.isNaN(percentUsed)) {
    // Unknown usage → assume the worst so the engine prepares a handoff.
    return Zone.RED;
  }
  if (percentUsed >= red) {
    return Zone.RED;
  }
  if (percentUsed >= yellow) {
    return Zone.YELLOW;
  }
  return Zone.GREEN;
}

/**
 * Context Budget Manager.
 *
 * @extends EventEmitter
 * @fires ContextBudgetManager#zone_changed
 * @fires ContextBudgetManager#compress_triggered
 * @fires ContextBudgetManager#handoff_recommended
 */
class ContextBudgetManager extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.cwd] - Root for the zone log (default `process.cwd()`).
   * @param {{yellow?: number, red?: number}} [options.thresholds] - Zone thresholds
   *   as percent of context USED. Defaults to `{ yellow: 60, red: 80 }`.
   */
  constructor({ cwd, thresholds = { yellow: 60, red: 80 } } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.thresholds = {
      yellow: thresholds.yellow != null ? thresholds.yellow : DEFAULT_THRESHOLDS.yellow,
      red: thresholds.red != null ? thresholds.red : DEFAULT_THRESHOLDS.red,
    };

    this.logPath = path.join(this.cwd, AUTONOMY_DIR, ZONE_LOG);

    /**
     * Per-story last-known state: storyId → { zone, percentUsed, bracket, epicId }.
     * @type {Map<string, {zone: string, percentUsed: (number|null), bracket: (string|null), epicId: (string|null)}>}
     */
    this.states = new Map();
  }

  /**
   * Resolve a zone from the percentage of context used.
   *
   * @param {number} percentUsed - Percent of the window consumed (0–100).
   * @returns {string} Zone.GREEN | Zone.YELLOW | Zone.RED
   */
  zoneFor(percentUsed) {
    return calculateZone(percentUsed, this.thresholds);
  }

  /**
   * Map a SYNAPSE context bracket onto a zone (AC3).
   *
   * See {@link BRACKET_TO_ZONE} for the derivation from the real
   * context-tracker thresholds. Unknown brackets map to RED.
   *
   * @param {string} bracket - 'FRESH' | 'MODERATE' | 'DEPLETED' | 'CRITICAL'.
   * @returns {string} Zone.GREEN | Zone.YELLOW | Zone.RED
   */
  zoneFromBracket(bracket) {
    const key = typeof bracket === 'string' ? bracket.toUpperCase() : '';
    return BRACKET_TO_ZONE[key] || Zone.RED;
  }

  /**
   * Evaluate current context usage and decide the next action.
   *
   * Accepts either a direct `percentUsed` (wins when provided) or a SYNAPSE
   * `bracket`. Emits `zone_changed` when the zone differs from the last
   * evaluated zone for this `storyId`, and `compress_triggered` /
   * `handoff_recommended` according to the resolved action. Zone transitions
   * are appended to `.aios/autonomy/zone-log.json` (AC4).
   *
   * @param {Object} input
   * @param {number} [input.percentUsed] - Percent of window consumed (0–100).
   * @param {string} [input.bracket] - SYNAPSE bracket (used when percentUsed absent).
   * @param {string} [input.storyId] - Story being executed (state key + log stamp).
   * @param {string} [input.epicId] - Epic identifier (carried for compression).
   * @returns {{ zone: string, action: string, recommendation: string }}
   */
  evaluate({ percentUsed, bracket, storyId, epicId } = {}) {
    const hasPercent = typeof percentUsed === 'number' && !Number.isNaN(percentUsed);
    const zone = hasPercent ? this.zoneFor(percentUsed) : this.zoneFromBracket(bracket);
    const action = ZONE_ACTIONS[zone];
    const recommendation = ZONE_RECOMMENDATIONS[zone];

    const key = this._stateKey(storyId);
    const prev = this.states.get(key) || null;
    const from = prev ? prev.zone : null;
    const loggedPercent = hasPercent ? percentUsed : null;

    // Persist the new per-story state before emitting so listeners see it.
    this.states.set(key, {
      zone,
      percentUsed: loggedPercent,
      bracket: bracket || null,
      epicId: epicId || null,
    });

    if (from !== zone) {
      this._logTransition({ storyId: storyId || null, from, to: zone, percentUsed: loggedPercent });
      /**
       * Zone changed for a story.
       * @event ContextBudgetManager#zone_changed
       */
      this.emit(Events.ZONE_CHANGED, {
        storyId: storyId || null,
        epicId: epicId || null,
        from,
        to: zone,
        percentUsed: loggedPercent,
        bracket: bracket || null,
      });
    }

    if (action === 'compress') {
      /** @event ContextBudgetManager#compress_triggered */
      this.emit(Events.COMPRESS_TRIGGERED, {
        storyId: storyId || null,
        epicId: epicId || null,
        zone,
        percentUsed: loggedPercent,
      });
    } else if (action === 'handoff') {
      /** @event ContextBudgetManager#handoff_recommended */
      this.emit(Events.HANDOFF_RECOMMENDED, {
        storyId: storyId || null,
        epicId: epicId || null,
        zone,
        percentUsed: loggedPercent,
      });
    }

    return { zone, action, recommendation };
  }

  /**
   * Yellow-zone compression (AC2): rebuild the accumulated epic context through
   * the existing EpicContextAccumulator (REUSE, Story 12.4).
   *
   * Degrades gracefully (AC5): if the accumulator module is unavailable or
   * throws, returns `null` after a `console.warn` — it never throws.
   *
   * @param {Object} params
   * @param {string} params.epicId - Epic identifier.
   * @param {string} params.storyId - Story being executed (drives the story index).
   * @param {number} [params.storyN] - Explicit 0-based story index (overrides lookup).
   * @param {string[]} [params.filesToModify] - Files Story N will touch (overlap upgrades).
   * @param {string} [params.executor] - Story N executor (match upgrades).
   * @returns {Promise<{compressedContext: string, level: string, estimatedTokens: number}|null>}
   */
  async compress({ epicId, storyId, storyN, filesToModify = [], executor = null } = {}) {
    let accumulatorModule;
    try {
      // Lazy require so a missing module degrades gracefully instead of
      // breaking the autonomy loop at import time.
      accumulatorModule = require('../orchestration/epic-context-accumulator');
    } catch (err) {
      console.warn(
        `[ContextBudgetManager] compress unavailable — EpicContextAccumulator not loadable: ${err.message}`,
      );
      return null;
    }

    try {
      const { EpicContextAccumulator, estimateTokens, CompressionLevel, TOKEN_LIMIT } =
        accumulatorModule;

      const sessionState = await this._acquireSessionState();
      const accumulator = new EpicContextAccumulator(sessionState);

      const index = typeof storyN === 'number' ? storyN : this._resolveStoryIndex(sessionState, storyId);
      const compressedContext = accumulator.buildAccumulatedContext(epicId, index, {
        filesToModify,
        executor,
      });

      const estimatedTokens = estimateTokens(compressedContext);
      const level = this._describeLevel(estimatedTokens, TOKEN_LIMIT, CompressionLevel);

      return { compressedContext, level, estimatedTokens };
    } catch (err) {
      console.warn(`[ContextBudgetManager] compress failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Last-known zone/percent for a story (AC1/AC6 support).
   *
   * @param {string} [storyId]
   * @returns {{zone: string, percentUsed: (number|null), bracket: (string|null), epicId: (string|null)}|null}
   */
  getState(storyId) {
    return this.states.get(this._stateKey(storyId)) || null;
  }

  /**
   * Read the persisted zone-log array (most recent last).
   *
   * @param {{limit?: number}} [options]
   * @returns {Object[]} Parsed log entries.
   */
  getZoneLog({ limit = 100 } = {}) {
    const entries = this._readLog();
    return entries.slice(-limit);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //                              PRIVATE
  // ─────────────────────────────────────────────────────────────────────────

  /** @private */
  _stateKey(storyId) {
    return storyId || '__default__';
  }

  /**
   * Best-effort SessionState load for the accumulator. Never throws — a missing
   * or unreadable state file yields an instance whose `.state` is null, which
   * the accumulator handles by returning an empty context.
   * @private
   * @returns {Promise<Object|null>}
   */
  async _acquireSessionState() {
    try {
      const { SessionState } = require('../orchestration/session-state');
      const sessionState = new SessionState(this.cwd);
      try {
        await sessionState.loadSessionState();
      } catch {
        // No/invalid state file — accumulator tolerates a null .state.
      }
      return sessionState;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the 0-based story index for the accumulator. Falls back to the
   * count of completed stories when the story cannot be located.
   * @private
   */
  _resolveStoryIndex(sessionState, storyId) {
    const done = sessionState?.state?.session_state?.progress?.stories_done || [];
    if (storyId) {
      const idx = done.findIndex((s) => (typeof s === 'string' ? s : s && s.id) === storyId);
      if (idx >= 0) {
        return idx;
      }
    }
    return done.length;
  }

  /**
   * Describe the compression outcome relative to the accumulator's real token
   * budget, using the module's exported CompressionLevel values.
   * @private
   */
  _describeLevel(estimatedTokens, tokenLimit, CompressionLevel) {
    const limit = typeof tokenLimit === 'number' && tokenLimit > 0 ? tokenLimit : 8000;
    const levels = CompressionLevel || {
      FULL_DETAIL: 'full_detail',
      METADATA_PLUS_FILES: 'metadata_plus_files',
      METADATA_ONLY: 'metadata_only',
    };
    if (estimatedTokens <= limit * 0.5) {
      return levels.FULL_DETAIL;
    }
    if (estimatedTokens <= limit) {
      return levels.METADATA_PLUS_FILES;
    }
    return levels.METADATA_ONLY;
  }

  /**
   * Append a transition to `.aios/autonomy/zone-log.json` (a JSON array).
   * Logging is advisory and must never break the run.
   * @private
   */
  _logTransition({ storyId, from, to, percentUsed }) {
    const entry = {
      timestamp: new Date().toISOString(),
      storyId: storyId || null,
      from,
      to,
      percentUsed: percentUsed != null ? percentUsed : null,
    };

    try {
      const entries = this._readLog();
      entries.push(entry);
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.writeFileSync(this.logPath, JSON.stringify(entries, null, 2), 'utf8');
    } catch {
      // Never let logging break the autonomy loop.
    }
  }

  /**
   * Read the zone-log array, tolerating a missing or corrupt file.
   * @private
   * @returns {Object[]}
   */
  _readLog() {
    try {
      if (!fs.existsSync(this.logPath)) {
        return [];
      }
      const raw = fs.readFileSync(this.logPath, 'utf8').trim();
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

module.exports = {
  ContextBudgetManager,
  calculateZone,
  Zone,
  ZONE_ACTIONS,
  ZONE_RECOMMENDATIONS,
  DEFAULT_THRESHOLDS,
  BRACKET_TO_ZONE,
  Events,
  AUTONOMY_DIR,
};
