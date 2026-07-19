'use strict';

/**
 * AIOS Gateway — Escalation watcher (Story WSB-4.1, AC4).
 *
 * Polls `.aios/autonomy/escalations/` for new escalation records (`*.md` written
 * by core/autonomy/escalation.js) and invokes `onEscalation` once per new file.
 * A record that already has a sibling `<id>.decision.json` is considered handled
 * and is skipped.
 *
 * WHY POLLING (setInterval + readdir + mtime) INSTEAD OF chokidar/fs.watch:
 * escalations arrive at human cadence (seconds/minutes), the directory is tiny,
 * and a 5s readdir costs effectively nothing. Pulling in a native filesystem
 * watcher dependency would violate the gateway's zero-deps principle and buy no
 * practical latency benefit. `fs.watch` is intentionally avoided too — it is
 * unreliable/inconsistent across platforms for this "did a new file appear" need.
 *
 * @module core/gateway/escalation-watcher
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

/** Escalation records + decisions directory (matches core/autonomy/escalation.js). */
const ESCALATIONS_SUBDIR = path.join('.aios', 'autonomy', 'escalations');

/** Default poll interval. */
const DEFAULT_INTERVAL_MS = 5000;

/**
 * Watch for new escalation records.
 *
 * @param {Object} params
 * @param {string} [params.cwd] - Workspace root (defaults to process.cwd()).
 * @param {Function} params.onEscalation - `async ({id, name, path, content}) => void`.
 * @param {number} [params.intervalMs=5000] - Poll interval.
 * @returns {{stop: Function, scanNow: Function}} Controller.
 */
function watchEscalations({ cwd = process.cwd(), onEscalation, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const dir = path.join(cwd, ESCALATIONS_SUBDIR);
  const seen = new Set();

  const scan = async () => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_err) {
      // Directory not created yet → nothing to do this tick.
      return;
    }

    // Order by mtime ascending so escalations surface in creation order.
    const records = entries
      .filter((f) => f.endsWith('.md'))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        } catch (_err) {
          mtimeMs = 0;
        }
        return { name, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const { name } of records) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name); // dedup: mark before emitting so a slow handler never double-fires

      const id = name.replace(/\.md$/, '');
      if (fs.existsSync(path.join(dir, `${id}.decision.json`))) {
        continue; // already decided → do not notify
      }

      let content = '';
      try {
        content = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (_err) {
        content = '';
      }

      try {
        if (typeof onEscalation === 'function') {
          await onEscalation({ id, name, path: path.join(dir, name), content });
        }
      } catch (_err) {
        // A handler error must never crash the watcher loop.
      }
    }
  };

  // Prime immediately so pending escalations surface on startup...
  scan();
  // ...then poll on the interval. unref() so the watcher never blocks exit.
  const timer = setInterval(scan, intervalMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
    scanNow: scan,
  };
}

module.exports = {
  watchEscalations,
  ESCALATIONS_SUBDIR,
};
