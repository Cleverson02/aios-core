#!/usr/bin/env node

/**
 * AIOS Radar — Deterministic Collectors
 *
 * Story: WSB-5.1 - Radar de Oportunidades
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Gathers, from the REAL brain sources, everything the deterministic heuristics
 * need — with ZERO LLM and ZERO network. Every source is read behind its own
 * try/catch and degrades to `null` (never throws), so a workspace missing the
 * brain index, entities, digests or telemetry still produces a usable (partial)
 * snapshot instead of an error.
 *
 * Sources (all optional):
 *   - entities   → the business entity graph (WSB-1.4 `entities.json`): each entity
 *                  with its total mention count and typed relations.
 *   - digests    → shared session digests (WSB-1.6 `docs/digests/*.md`), parsed
 *                  LIGHTLY: front-matter (date/story/agent/entities) + the titles
 *                  of the `## Decisões` section (nothing heavier).
 *   - gotchas    → `.aios/gotchas.json` read directly (schema-tolerant), each with
 *                  a normalized `occurrences` count and severity.
 *   - brainStats → per-AREA file counts from the brain index manifest (WSB-1.2),
 *                  plus whether each area carries an `_index.md`.
 *   - activity   → token/cost telemetry snapshot (WSB-4.5) + recently active agents.
 *
 * Design constraints: zero new dependencies (native fs/path + existing js-yaml);
 * every foreign module is consumed through a lazy `require` inside try/catch, so
 * the radar never hard-couples to another squad's module state.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

/** Directory (relative to cwd) holding shared digests. */
const DIGESTS_RELDIR = path.join('docs', 'digests');

/** `.aios/gotchas.json` relative path. */
const GOTCHAS_RELPATH = path.join('.aios', 'gotchas.json');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC — COLLECT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Collect every deterministic source into a single snapshot. Never throws; each
 * source that is missing / unreadable degrades to `null`.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Workspace root (defaults to process.cwd()).
 * @param {string} [options.brainDir] - Override brain persistence dir (tests).
 * @returns {Promise<{entities: (Array|null), digests: (Array|null), gotchas: (Array|null), brainStats: (Object|null), activity: (Object|null)}>}
 */
async function collect({ cwd, brainDir } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();

  const entities = collectEntities(root, brainDir);
  const digests = collectDigests(root);
  const gotchas = collectGotchas(root);
  const brainStats = collectBrainStats(root, brainDir);
  const activity = await collectActivity(root);

  return { entities, digests, gotchas, brainStats, activity };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENTITIES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Collect the business entity graph via the WSB-1.4 EntityStore (lazy). Each
 * entity is flattened to `{id, name, type, mentions, relations, sources}` where
 * `mentions` is the SUM of mentions across all source files.
 *
 * @param {string} cwd - Workspace root.
 * @param {string} [brainDirOverride] - Explicit brain dir (tests).
 * @returns {Array<Object>|null}
 */
function collectEntities(cwd, brainDirOverride) {
  try {
     
    const { EntityStore } = require('../brain/entities/entity-store');
     
    const { BrainIndexer } = require('../brain/indexer');

    const brainDir = brainDirOverride || BrainIndexer.defaultBrainDir(cwd);
    if (!fs.existsSync(path.join(brainDir, 'entities.json'))) return null;

    const store = new EntityStore({ brainDir }).load();
    const list = store.list();
    if (!list.length) return null;

    return list.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      mentions: (Array.isArray(e.sources) ? e.sources : []).reduce(
        (sum, s) => sum + (Number.isFinite(s.mentions) ? s.mentions : 0),
        0,
      ),
      relations: Array.isArray(e.relations) ? e.relations : [],
      sources: Array.isArray(e.sources) ? e.sources : [],
    }));
  } catch (_err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DIGESTS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Light-parse shared digests: front-matter (date/story/agent/entities) plus the
 * bullet titles under the `## Decisões` heading. Heavier sections (files/commits)
 * are intentionally ignored — the radar only needs decisions + metadata.
 *
 * @param {string} cwd - Workspace root.
 * @returns {Array<{file: string, date: (string|null), story: (string|null), agent: (string|null), entities: string[], decisions: string[]}>|null}
 */
function collectDigests(cwd) {
  try {
    const dir = path.join(cwd, DIGESTS_RELDIR);
    if (!fs.existsSync(dir)) return null;

    const files = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .sort();
    if (!files.length) return null;

    const digests = [];
    for (const name of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, name), 'utf8');
        digests.push(parseDigest(name, raw));
      } catch (_err) {
        // Skip unreadable digest.
      }
    }
    return digests.length ? digests : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Parse a single digest markdown into its light shape.
 *
 * @param {string} fileName - Digest file name.
 * @param {string} raw - Raw markdown content.
 * @returns {{file: string, date: (string|null), story: (string|null), agent: (string|null), entities: string[], decisions: string[]}}
 */
function parseDigest(fileName, raw) {
  const { frontMatter, body } = splitFrontMatter(raw);

  const dateFromName = (fileName.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || null;

  return {
    file: fileName,
    date: (frontMatter && frontMatter.date) || dateFromName,
    story: (frontMatter && frontMatter.story) || null,
    agent: (frontMatter && frontMatter.agent) || null,
    entities:
      frontMatter && Array.isArray(frontMatter.entities)
        ? frontMatter.entities.map((e) => String(e))
        : [],
    decisions: extractDecisions(body),
  };
}

/**
 * Split a `---`-delimited YAML front-matter block from the body. Uses js-yaml
 * when available; on any failure returns `{frontMatter: null, body: raw}`.
 *
 * @param {string} raw - Raw markdown.
 * @returns {{frontMatter: (Object|null), body: string}}
 */
function splitFrontMatter(raw) {
  const text = String(raw || '');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontMatter: null, body: text };
  try {
     
    const yaml = require('js-yaml');
    const parsed = yaml.load(match[1]);
    return {
      frontMatter: parsed && typeof parsed === 'object' ? parsed : null,
      body: match[2] || '',
    };
  } catch (_err) {
    return { frontMatter: null, body: match[2] || '' };
  }
}

/**
 * Extract the bullet titles under the `## Decisões` heading (stops at the next
 * `##` heading). Each bullet's `— reason` suffix is trimmed to the title only.
 *
 * @param {string} body - Digest body (front-matter stripped).
 * @returns {string[]}
 */
function extractDecisions(body) {
  const lines = String(body || '').split(/\r?\n/);
  const decisions = [];
  let inSection = false;

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      inSection = /^#{1,6}\s+Decis(õ|o)es/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const title = bullet[1].split(' — ')[0].trim();
      if (title) decisions.push(title);
    }
  }
  return decisions;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              GOTCHAS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Read `.aios/gotchas.json` directly (schema-tolerant). We deliberately avoid
 * GotchasMemory here: the on-disk schema varies across generations and reading
 * raw keeps the collector side-effect-free (no re-serialization) and crash-proof.
 * `occurrences` is normalized from `source.occurrences` / `occurrences` (default 1).
 *
 * @param {string} cwd - Workspace root.
 * @returns {Array<{id: string, title: string, occurrences: number, severity: string, category: string}>|null}
 */
function collectGotchas(cwd) {
  try {
    const file = path.join(cwd, GOTCHAS_RELPATH);
    if (!fs.existsSync(file)) return null;

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = parsed && Array.isArray(parsed.gotchas) ? parsed.gotchas : [];
    if (!list.length) return null;

    return list.map((g, i) => ({
      id: String(g.id || `gotcha-${i}`),
      title: String(g.title || g.reason || 'Gotcha').trim(),
      occurrences: normalizeOccurrences(g),
      severity: String(g.severity || 'info'),
      category: String(g.category || 'general'),
    }));
  } catch (_err) {
    return null;
  }
}

/**
 * Normalize an occurrence count from the several shapes gotchas have shipped in.
 *
 * @param {Object} g - Raw gotcha record.
 * @returns {number}
 */
function normalizeOccurrences(g) {
  const candidate =
    (g.source && Number(g.source.occurrences)) || Number(g.occurrences) || 0;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : 1;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BRAIN STATS (per area)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build per-AREA file statistics from the brain index manifest (WSB-1.2). The
 * indexer's own `stats()` aggregates by root, not by area, so we read the
 * manifest directly to count files per area and flag whether each area carries
 * an `_index.md` (used by the process-gap heuristic). All best-effort.
 *
 * @param {string} cwd - Workspace root.
 * @param {string} [brainDirOverride] - Explicit brain dir (tests).
 * @returns {{brainDir: string, lastIndexed: (string|null), totalFiles: number, areas: Object<string, {files: number, hasIndex: boolean}>}|null}
 */
function collectBrainStats(cwd, brainDirOverride) {
  try {
     
    const { BrainIndexer } = require('../brain/indexer');
    const brainDir = brainDirOverride || BrainIndexer.defaultBrainDir(cwd);
    const manifestPath = path.join(brainDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const files = manifest && manifest.files ? manifest.files : {};

    // Optional chunk store gives per-file relative paths → `_index.md` detection.
    const indexFilesByArea = readIndexFileAreas(brainDir);

    const areas = {};
    let totalFiles = 0;
    for (const info of Object.values(files)) {
      totalFiles++;
      const area = info && info.area ? String(info.area) : null;
      if (!area) continue;
      if (!areas[area]) areas[area] = { files: 0, hasIndex: false };
      areas[area].files++;
      if (indexFilesByArea.has(area)) areas[area].hasIndex = true;
    }

    if (!Object.keys(areas).length) return null;

    return {
      brainDir,
      lastIndexed: (manifest && manifest.lastIndexed) || null,
      totalFiles,
      areas,
    };
  } catch (_err) {
    return null;
  }
}

/**
 * Read the brain chunk store and return the set of areas that own an `_index.md`
 * file. Best-effort: a missing / large / corrupt chunks file yields an empty set
 * (so `hasIndex` conservatively stays false only when we truly cannot tell).
 *
 * @param {string} brainDir - Brain persistence dir.
 * @returns {Set<string>}
 */
function readIndexFileAreas(brainDir) {
  const areas = new Set();
  try {
    const chunksPath = path.join(brainDir, 'chunks.json');
    if (!fs.existsSync(chunksPath)) return areas;
    const parsed = JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
    const chunks = parsed && parsed.chunks ? parsed.chunks : {};
    for (const rec of Object.values(chunks)) {
      if (!rec || !rec.file || !rec.area) continue;
      if (path.basename(String(rec.file)).toLowerCase() === '_index.md') {
        areas.add(String(rec.area));
      }
    }
  } catch (_err) {
    // Ignore — degrade to "unknown".
  }
  return areas;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ACTIVITY (telemetry)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Collect a light telemetry activity snapshot (WSB-4.5): cost/token totals grouped
 * by day plus the recently active agents. Best-effort and fully guarded.
 *
 * @param {string} cwd - Workspace root.
 * @returns {Promise<{totals: Object, byDay: Array<Object>, activeAgents: Array<Object>}|null>}
 */
async function collectActivity(cwd) {
  try {
     
    const telemetry = require('../telemetry');
    const report = await telemetry.aggregate({ cwd, groupBy: 'day' });
    let activeAgents = [];
    try {
      activeAgents = await telemetry.getActiveAgents({ cwd });
    } catch (_err) {
      activeAgents = [];
    }

    const hasData = report && (report.totals.calls > 0 || activeAgents.length > 0);
    if (!hasData) return null;

    return {
      totals: report.totals,
      byDay: report.groups,
      activeAgents,
    };
  } catch (_err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = {
  collect,
  // Exposed for unit tests + reuse:
  collectEntities,
  collectDigests,
  collectGotchas,
  collectBrainStats,
  collectActivity,
  parseDigest,
  extractDecisions,
  splitFrontMatter,
};
