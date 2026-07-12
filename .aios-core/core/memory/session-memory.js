#!/usr/bin/env node

/**
 * AIOS Session Memory
 *
 * Story: WSB-0.2 - Memory API Unificada
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Records and retrieves autonomous decisions made during a working session.
 * Persists to .aios/session-memory.json and, when that store is absent,
 * degrades gracefully by extracting decision titles from decision logs (.ai/).
 *
 * Consumers:
 * - execution/context-injector.js → SessionMemory#getDecisions({limit})
 *
 * Design constraints:
 * - Zero new dependencies (fs, path only).
 * - Read path never throws; a missing store yields an empty result.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  sessionMemoryPath: '.aios/session-memory.json',
  sessionStatePath: '.aios/session-state.json',
  decisionLogsDir: '.ai',
};

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SESSION MEMORY CLASS
// ═══════════════════════════════════════════════════════════════════════════════════

class SessionMemory {
  /**
   * Create a new SessionMemory instance
   *
   * @param {Object} [options] - Configuration options
   * @param {string} [options.projectRoot] - Project root path (defaults to cwd)
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.storePath = path.join(this.projectRoot, CONFIG.sessionMemoryPath);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              PUBLIC METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Record an autonomous decision, appending it to the session store.
   *
   * @param {Object} entry - Decision entry
   * @param {string} entry.decision - What was decided
   * @param {string} [entry.reason] - Why it was decided
   * @param {Object|string} [entry.context] - Additional context
   * @returns {Promise<{decision: string, reason: string|null, context: *, timestamp: string}>}
   */
  async recordDecision({ decision, reason = null, context = null } = {}) {
    const record = {
      decision: decision || '',
      reason: reason || null,
      context: context || null,
      timestamp: new Date().toISOString(),
    };

    const existing = this._readStore();
    existing.push(record);
    this._writeStore(existing);

    return record;
  }

  /**
   * Get recorded decisions, most recent first.
   *
   * Falls back to decision-log titles (.ai/*.md) when the session store is
   * absent, and to an empty array when neither source exists.
   *
   * @param {Object} [options] - Query options
   * @param {number} [options.limit=10] - Maximum number of decisions
   * @returns {Promise<Array<{decision: string, reason: string|null, timestamp: string}>>}
   */
  async getDecisions({ limit = 10 } = {}) {
    let decisions = this._readStore();

    if (decisions.length === 0) {
      decisions = this._decisionsFromLogs();
    }

    const normalized = decisions.map((d) => ({
      decision: d.decision || d.content || '',
      reason: d.reason || null,
      timestamp: d.timestamp || null,
    }));

    normalized.sort((a, b) => this._timeValue(b.timestamp) - this._timeValue(a.timestamp));
    return normalized.slice(0, Math.max(0, limit));
  }

  /**
   * Get a summary of the current session.
   *
   * @returns {Promise<{decisionCount: number, lastDecision: (string|null), sessionStart: (string|null)}>}
   */
  async getSessionSummary() {
    const decisions = await this.getDecisions({ limit: Number.MAX_SAFE_INTEGER });

    if (decisions.length === 0) {
      return {
        decisionCount: 0,
        lastDecision: null,
        // Fall back to the ambient session-state store if available.
        sessionStart: this._sessionStateStart(),
      };
    }

    // decisions are sorted most-recent-first
    const lastDecision = decisions[0].decision || null;
    const sessionStart =
      decisions[decisions.length - 1].timestamp || this._sessionStateStart();

    return {
      decisionCount: decisions.length,
      lastDecision,
      sessionStart,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Read the session store, always returning an array.
   * @private
   * @returns {Array}
   */
  _readStore() {
    try {
      if (!fs.existsSync(this.storePath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Persist the session store, creating the .aios directory if needed.
   * @private
   * @param {Array} entries
   */
  _writeStore(entries) {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storePath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch {
      // Write failures are non-fatal for the session (graceful degradation)
    }
  }

  /**
   * Derive decisions from decision-log markdown titles (.ai/*.md).
   * @private
   * @returns {Array<{decision: string, reason: null, timestamp: string}>}
   */
  _decisionsFromLogs() {
    const dir = path.join(this.projectRoot, CONFIG.decisionLogsDir);
    const results = [];

    try {
      if (!fs.existsSync(dir)) {
        return [];
      }
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .map((name) => path.join(dir, name));

      for (const file of files) {
        try {
          const raw = fs.readFileSync(file, 'utf-8');
          const title = this._firstHeader(raw) || path.basename(file, '.md');
          const stat = fs.statSync(file);
          results.push({
            decision: title,
            reason: null,
            timestamp: stat.mtime.toISOString(),
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      return [];
    }

    return results;
  }

  /**
   * Read a session-start timestamp from .aios/session-state.json when present.
   * Only reads optional fields; missing/absent values degrade to null.
   * @private
   * @returns {string|null}
   */
  _sessionStateStart() {
    try {
      const statePath = path.join(this.projectRoot, CONFIG.sessionStatePath);
      if (!fs.existsSync(statePath)) {
        return null;
      }
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const session = state && state.currentSession;
      if (session && typeof session === 'object') {
        return session.startedAt || session.start || session.timestamp || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract the first markdown header from content.
   * @private
   * @param {string} raw
   * @returns {string|null}
   */
  _firstHeader(raw) {
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^#{1,6}\s+(.*)$/);
      if (match && match[1].trim()) {
        return match[1].trim();
      }
    }
    return null;
  }

  /**
   * Convert a timestamp to a comparable numeric value (0 if invalid).
   * @private
   * @param {string|null} timestamp
   * @returns {number}
   */
  _timeValue(timestamp) {
    if (!timestamp) {
      return 0;
    }
    const value = new Date(timestamp).getTime();
    return Number.isNaN(value) ? 0 : value;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = SessionMemory;
