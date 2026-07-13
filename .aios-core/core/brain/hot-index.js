#!/usr/bin/env node

/**
 * AIOS Brain — Hot Index (compact, SYNAPSE-loadable knowledge snapshot)
 *
 * Story: WSB-1.5 - SYNAPSE L8 (Workspace Knowledge)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * The full lexical/semantic brain (index.json / chunks.json / vectors.json) is
 * tens of MB — far too heavy to read inside the SYNAPSE hook, which spawns a
 * fresh process on every prompt under a hard 100ms/15ms budget. This module
 * distils the brain into a compact `hot-index.json` (capped at ~200KB) that the
 * L8 layer can `readFileSync` + `JSON.parse` in well under 10ms:
 *
 *   {
 *     version: 1,
 *     builtAt,                                   // ISO timestamp
 *     workspace: { name },
 *     roots:      [{ name, tier, path }],        // where documents live
 *     entities:   [{ id, name, type, aliases, description, topSource }],
 *     areaIndexes:[{ area, path, summary }],     // first lines of each _index.md
 *     trimmed?:   true                           // set when the 200KB cap kicked in
 *   }
 *
 * Sources:
 *   - entities.json (WSB-1.4)  → read via EntityStore (graceful when absent)
 *   - each area's `_index.md`  → first ~15 lines, truncated to 800 chars
 *
 * Design constraints:
 * - Zero new dependencies (fast-glob is already used by the indexer).
 * - Never reads chunks.json / vectors.json — that stays in `aios brain ask`.
 * - Total graceful degradation: missing entities / roots degrade to an empty
 *   (but structurally valid) hot index rather than throwing.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// NOTE: fast-glob and the EntityStore are lazy-required inside the build path
// only. This keeps the STATIC require graph of this module limited to fs/os/path
// so the SYNAPSE L8 layer can require it purely for loadHotIndex() without paying
// the cost of loading fast-glob on every prompt.

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const HOT_INDEX_VERSION = 1;

/** Compact hot-index file name (lives in the brainDir next to index.json). */
const HOT_INDEX_FILE = 'hot-index.json';

/** Hard cap for the serialised hot index (200KB). */
const MAX_HOT_INDEX_BYTES = 200 * 1024;

/** Per-entity description ceiling (chars). */
const DESCRIPTION_TRUNC = 200;

/** Per-area summary line ceiling and char ceiling. */
const SUMMARY_MAX_LINES = 15;
const SUMMARY_TRUNC = 800;

/** Directory names never traversed when discovering `_index.md` files. */
const DENY_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.aios', '.aiox', '.synapse',
];

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC API — BUILD
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build (and persist) the compact hot index for a workspace.
 *
 * @param {string} brainDir - Persistence directory (holds hot-index.json).
 * @param {Object} [options]
 * @param {Array<{name?: string, path: string, tier?: string}>} [options.roots]
 *        Explicit roots (dependency-injection override, mirrors the indexer).
 * @param {string} [options.cwd] - Workspace cwd (used for WorkspaceManager +
 *        the fallback workspace name). Defaults to `process.cwd()`.
 * @returns {Promise<{entities: number, areas: number, bytes: number, durationMs: number, trimmed: boolean}>}
 */
async function buildHotIndex(brainDir, options = {}) {
  const start = Date.now();
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  const { roots, workspaceName } = await resolveRoots(options.roots, cwd);
  const entities = readEntities(brainDir);
  const areaIndexes = collectAreaIndexes(roots);

  let hot = {
    version: HOT_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    workspace: { name: workspaceName },
    roots: roots.map((r) => ({ name: r.name, tier: r.tier, path: r.path })),
    entities,
    areaIndexes,
  };

  // Enforce the 200KB cap with a documented, deterministic trim order.
  const capped = enforceCap(hot);
  hot = capped.hot;

  const serialised = JSON.stringify(hot);
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, HOT_INDEX_FILE), serialised);

  return {
    entities: hot.entities.length,
    areas: hot.areaIndexes.length,
    bytes: Buffer.byteLength(serialised),
    durationMs: Date.now() - start,
    trimmed: capped.trimmed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC API — LOAD
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Load the compact hot index. A single readFileSync + JSON.parse — designed to
 * run in <10ms so the L8 layer stays inside its 15ms budget.
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {Object|null} The hot index object, or null when absent / unreadable.
 */
function loadHotIndex(brainDir) {
  try {
    const filePath = path.join(brainDir, HOT_INDEX_FILE);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ROOT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Resolve workspace roots + name. Mirrors the indexer's resolution order:
 *   1. Explicit `roots` (deterministic DI override, used by tests/embedders).
 *   2. WorkspaceManager (graceful — module may be absent or fail to load).
 *   3. A single `projects` root for `cwd`.
 *
 * @param {Array<{name?: string, path: string, tier?: string}>|undefined} explicitRoots
 * @param {string} cwd - Workspace cwd.
 * @returns {Promise<{roots: Array<{name: string, path: string, tier: string}>, workspaceName: string}>}
 */
async function resolveRoots(explicitRoots, cwd) {
  if (Array.isArray(explicitRoots) && explicitRoots.length) {
    return {
      roots: explicitRoots.map((r) => normalizeRoot(r, cwd)),
      workspaceName: path.basename(cwd),
    };
  }

  try {
    const mod = require('../workspace');
    if (mod && mod.WorkspaceManager) {
      const wm = new mod.WorkspaceManager({ cwd });
      await wm.load();
      const wmRoots = wm.getRoots();
      if (Array.isArray(wmRoots) && wmRoots.length) {
        return {
          roots: wmRoots.map((r) => normalizeRoot(r, cwd)),
          workspaceName: wm.getWorkspaceName() || path.basename(cwd),
        };
      }
    }
  } catch (_err) {
    // WorkspaceManager unavailable / failed to load — fall through.
  }

  return {
    roots: [{ name: path.basename(cwd), path: cwd, tier: 'projects' }],
    workspaceName: path.basename(cwd),
  };
}

/**
 * Normalise a root descriptor to `{name, path, tier}` with an absolute path.
 *
 * @param {Object} root - Raw root descriptor.
 * @param {string} cwd - Workspace cwd (base for relative paths).
 * @returns {{name: string, path: string, tier: string}}
 */
function normalizeRoot(root, cwd) {
  const abs = path.isAbsolute(root.path) ? root.path : path.resolve(cwd, root.path || '.');
  return {
    name: root.name || path.basename(abs),
    path: abs,
    tier: root.tier || 'projects',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENTITIES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Read entities.json via the EntityStore and project into the compact shape.
 * Absent / corrupt stores degrade to an empty list (EntityStore is graceful).
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {Array<{id: string, name: string, type: string, aliases: string[], description: string, topSource: string|null, _mentions: number}>}
 */
function readEntities(brainDir) {
  let list;
  try {
    const { EntityStore } = require('./entities/entity-store');
    list = new EntityStore({ brainDir }).load().list();
  } catch (_err) {
    return [];
  }

  return list.map((e) => {
    const sources = Array.isArray(e.sources) ? e.sources : [];
    const topSource = sources.length ? sources[0].file : null;
    const mentions = sources.reduce((sum, s) => sum + (Number(s.mentions) || 0), 0);
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      aliases: Array.isArray(e.aliases) ? e.aliases : [],
      description: truncate(e.description || '', DESCRIPTION_TRUNC),
      topSource,
      // Private ranking hint for cap-trimming; stripped before persistence.
      _mentions: mentions,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              AREA INDEXES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Discover every `_index.md` under the roots and capture a short summary
 * (first ~15 lines, truncated to 800 chars) with its area name + location.
 *
 * @param {Array<{name: string, path: string, tier: string}>} roots
 * @returns {Array<{area: string, path: string, summary: string}>}
 */
function collectAreaIndexes(roots) {
  const fg = require('fast-glob');
  const areas = [];
  const seen = new Set();

  for (const root of roots) {
    if (!root.path || !fs.existsSync(root.path)) continue;

    let files;
    try {
      files = fg.sync('**/_index.md', {
        cwd: root.path,
        absolute: true,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: DENY_DIRS.map((d) => `**/${d}/**`),
      });
    } catch (_err) {
      continue;
    }

    for (const abs of files) {
      if (seen.has(abs)) continue;
      seen.add(abs);

      const rel = path.relative(root.path, abs);
      const area = deriveArea(rel, root.name);
      const summary = summariseIndex(abs);
      if (summary == null) continue;

      areas.push({
        area,
        path: path.dirname(rel) === '.' ? root.name : path.join(root.name, path.dirname(rel)),
        summary,
      });
    }
  }

  return areas;
}

/**
 * Area name for an `_index.md`: its immediate parent directory, or the root
 * name when the file sits directly in the root.
 *
 * @param {string} rel - `_index.md` path relative to its root.
 * @param {string} rootName - Owning root name (fallback).
 * @returns {string}
 */
function deriveArea(rel, rootName) {
  const dir = path.dirname(rel);
  if (dir === '.' || dir === '') return rootName;
  return path.basename(dir);
}

/**
 * Read + summarise an `_index.md`: first N lines, collapsed and truncated.
 * Returns null when the file cannot be read.
 *
 * @param {string} absPath - Absolute `_index.md` path.
 * @returns {string|null}
 */
function summariseIndex(absPath) {
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (_err) {
    return null;
  }
  const head = content
    .split(/\r?\n/)
    .slice(0, SUMMARY_MAX_LINES)
    .join('\n')
    .trim();
  return truncate(head, SUMMARY_TRUNC);
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              200KB CAP ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Enforce the 200KB serialisation cap. Trim order (each step re-measures and
 * stops as soon as the payload fits) — documented per AC1:
 *   1. entity descriptions  → dropped to ''
 *   2. area summaries        → dropped to ''
 *   3. least-mentioned entities → removed one at a time (ascending `_mentions`)
 *
 * The private `_mentions` ranking hint is always stripped before returning.
 *
 * @param {Object} hot - The assembled (un-trimmed) hot index.
 * @returns {{hot: Object, trimmed: boolean}}
 */
function enforceCap(hot) {
  let trimmed = false;

  if (bytesOf(hot) > MAX_HOT_INDEX_BYTES) {
    trimmed = true;
    // 1. Drop descriptions.
    for (const e of hot.entities) e.description = '';
  }

  if (bytesOf(hot) > MAX_HOT_INDEX_BYTES) {
    trimmed = true;
    // 2. Drop area summaries.
    for (const a of hot.areaIndexes) a.summary = '';
  }

  if (bytesOf(hot) > MAX_HOT_INDEX_BYTES) {
    trimmed = true;
    // 3. Remove least-mentioned entities until it fits (keep at least the top one).
    const ranked = [...hot.entities].sort((a, b) => (a._mentions || 0) - (b._mentions || 0));
    for (const victim of ranked) {
      if (bytesOf(hot) <= MAX_HOT_INDEX_BYTES) break;
      hot.entities = hot.entities.filter((e) => e !== victim);
    }
  }

  // Strip the private ranking hint from the persisted payload.
  hot.entities = hot.entities.map(({ _mentions, ...rest }) => rest);
  if (trimmed) hot.trimmed = true;

  return { hot, trimmed };
}

/**
 * Serialised byte length of an object (UTF-8).
 *
 * @param {Object} obj
 * @returns {number}
 */
function bytesOf(obj) {
  return Buffer.byteLength(JSON.stringify(obj));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MODULE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Truncate a string to `max` chars, appending an ellipsis when cut.
 *
 * @param {string} value - Input.
 * @param {number} max - Max chars.
 * @returns {string}
 */
function truncate(value, max) {
  const str = String(value || '').trim();
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/**
 * Compute the default persistence directory for a workspace path. This mirrors
 * `BrainIndexer.defaultBrainDir` deliberately (short sha256 of the resolved
 * workspace path under ~/.aiox/brain/<hash>) so the L8 layer can locate the
 * hot index WITHOUT requiring brain/indexer.js (which would pay that module's
 * load cost inside the per-prompt hook). Kept in sync with the indexer.
 *
 * @param {string} workspacePath - Absolute workspace path.
 * @returns {string}
 */
function defaultBrainDir(workspacePath) {
  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 12);
  return path.join(os.homedir(), '.aiox', 'brain', hash);
}

module.exports = {
  buildHotIndex,
  loadHotIndex,
  defaultBrainDir,
  HOT_INDEX_FILE,
  HOT_INDEX_VERSION,
  MAX_HOT_INDEX_BYTES,
};
