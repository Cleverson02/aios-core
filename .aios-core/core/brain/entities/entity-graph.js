#!/usr/bin/env node

/**
 * AIOS Brain — Entity Graph Builder
 *
 * Story: WSB-1.4 - Grafo de Entidades do Negócio
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Builds the entity graph by combining extraction (roots + chunks) with a
 * mention scan over the indexed chunk text:
 *
 *   1. Extract candidates (structural + front-matter + `## Entidades`).
 *   2. Aggregate candidates by slug into entities (union aliases, fill type /
 *      description, remember the area roots they were defined in).
 *   3. Scan every chunk's text for each entity's name + aliases (case-insensitive,
 *      word-boundary, terms < 3 chars ignored) → `sources: [{file, mentions}]`.
 *   4. Derive relations:
 *        - `belongs-to`  entity defined inside an area root → that area entity.
 *        - `mentioned-with`  two entities mentioned in the SAME file (both ≥ 1).
 *   5. Persist through the EntityStore, respecting the manual-merge rule (AC5).
 *
 * Graceful degradation (AC7): with no chunks.json (and no injected chunks) the
 * graph is still built from the structural roots alone — no sources, no mentions.
 *
 * Design constraints: zero new dependencies. WorkspaceManager is consumed via
 * try/catch (same contract as the indexer); explicit `roots` / `chunks` act as a
 * deterministic dependency-injection override for tests and embedders.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const { EntityStore, slugify } = require('./entity-store');
const { extractEntities } = require('./entity-extractor');

/** Names shorter than this are never scanned for mentions (too noisy). */
const MIN_MENTION_LENGTH = 3;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build (or re-build) the entity graph for a brainDir and persist it.
 *
 * @param {string} brainDir - Persistence directory (holds chunks.json / entities.json).
 * @param {Object} [options]
 * @param {Array<{name: string, path?: string, tier?: string}>} [options.roots]
 *        Explicit roots (DI override). Falls back to WorkspaceManager, then cwd.
 * @param {Array<Object>|Object} [options.chunks] - Chunk records (array or the
 *        `chunks.json` id→record map). When omitted, chunks.json is read from brainDir.
 * @param {string} [options.cwd] - Working directory for root resolution.
 * @returns {Promise<{entities: Object[], mentionsScanned: number, durationMs: number}>}
 */
async function buildGraph(brainDir, options = {}) {
  const start = Date.now();
  if (!brainDir) throw new Error('buildGraph requires a brainDir');

  const chunkList = toChunkList(
    options.chunks != null ? options.chunks : readChunksJson(brainDir),
  );
  const roots = options.roots
    ? options.roots
    : await resolveRoots({ cwd: options.cwd || process.cwd() });

  // 1 + 2 — extract and aggregate candidates by slug.
  const candidates = extractEntities({ roots, chunks: chunkList });
  const { entities, areaRootsById } = aggregate(candidates);

  // 3 — mention scan.
  scanMentions(entities, chunkList);

  // 4 — relations.
  addBelongsTo(entities, areaRootsById);
  addMentionedWith(entities);

  // 5 — persist respecting manual identities.
  const store = new EntityStore({ brainDir });
  store.load();
  for (const entity of Object.values(entities)) {
    store.upsert(entity, { preserveManual: true });
  }
  store.save();

  return {
    entities: store.list(),
    mentionsScanned: chunkList.length,
    durationMs: Date.now() - start,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              AGGREGATION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Merge candidates sharing a slug into entity records and remember, per entity,
 * the set of area roots it was (non-structurally) defined in.
 *
 * @param {Array<Object>} candidates - Extractor candidates.
 * @returns {{entities: Object<string, Object>, areaRootsById: Object<string, Set<string>>}}
 */
function aggregate(candidates) {
  const entities = {};
  const areaRootsById = {};

  for (const c of candidates) {
    const id = slugify(c.name);
    if (!id) continue;

    if (!entities[id]) {
      entities[id] = {
        id,
        name: c.name,
        type: c.type || 'other',
        aliases: [...c.aliases],
        description: c.description || '',
        sources: [],
        relations: [],
        origin: 'auto',
      };
    } else {
      const e = entities[id];
      // Prefer a specific type over the generic `other`.
      if (e.type === 'other' && c.type && c.type !== 'other') e.type = c.type;
      if (!e.description && c.description) e.description = c.description;
      mergeAliasList(e.aliases, c.aliases);
    }

    // Track area roots for the belongs-to relation (only for entities *defined*
    // inside an area root, i.e. non-structural candidates).
    if (!c.structural && c.originTier === 'areas' && c.originRoot) {
      if (!areaRootsById[id]) areaRootsById[id] = new Set();
      areaRootsById[id].add(c.originRoot);
    }
  }

  return { entities, areaRootsById };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MENTION SCAN
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Populate each entity's `sources` by scanning chunk text for name + aliases.
 * Counts are aggregated per source file. Overlapping matches are avoided by a
 * single longest-first alternation regex, so `Acme` inside `Cliente Acme` is not
 * double-counted.
 *
 * @param {Object<string, Object>} entities - Entities by id (mutated).
 * @param {Array<Object>} chunkList - Chunk records.
 */
function scanMentions(entities, chunkList) {
  for (const entity of Object.values(entities)) {
    const regex = buildTermRegex([entity.name, ...entity.aliases]);
    if (!regex) continue;

    const byFile = new Map();
    for (const chunk of chunkList) {
      if (!chunk || typeof chunk.text !== 'string' || !chunk.file) continue;
      const count = countMatches(regex, chunk.text);
      if (count > 0) byFile.set(chunk.file, (byFile.get(chunk.file) || 0) + count);
    }

    entity.sources = Array.from(byFile.entries())
      .map(([file, mentions]) => ({ file, mentions }))
      .sort((a, b) => b.mentions - a.mentions);
  }
}

/**
 * Build a case-insensitive, word-boundary alternation regex from terms, longest
 * first (so multi-word names win over their sub-words). Terms shorter than
 * {@link MIN_MENTION_LENGTH} are dropped. Returns null when nothing qualifies.
 *
 * @param {string[]} terms - Candidate terms (name + aliases).
 * @returns {RegExp|null}
 */
function buildTermRegex(terms) {
  const usable = Array.from(
    new Set(
      terms
        .map((t) => String(t || '').trim())
        .filter((t) => t.length >= MIN_MENTION_LENGTH),
    ),
  ).sort((a, b) => b.length - a.length);

  if (!usable.length) return null;
  const alternation = usable.map(escapeRegex).join('|');
  // \b is unreliable next to accented letters; use explicit boundaries around
  // Latin word characters instead.
  return new RegExp(`(?<![a-z0-9à-ÿ_])(?:${alternation})(?![a-z0-9à-ÿ_])`, 'gi');
}

/**
 * Count non-overlapping matches of a global regex within text.
 *
 * @param {RegExp} regex - Global regex.
 * @param {string} text - Text to scan.
 * @returns {number}
 */
function countMatches(regex, text) {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(text) !== null) count++;
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RELATIONS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Add `belongs-to` edges from each entity to the area entity of every area root
 * it was defined in (skipping self-links and missing targets).
 *
 * @param {Object<string, Object>} entities - Entities by id (mutated).
 * @param {Object<string, Set<string>>} areaRootsById - Area roots per entity id.
 */
function addBelongsTo(entities, areaRootsById) {
  for (const [id, rootNames] of Object.entries(areaRootsById)) {
    const entity = entities[id];
    if (!entity) continue;
    for (const rootName of rootNames) {
      const targetId = slugify(rootName);
      if (!targetId || targetId === id || !entities[targetId]) continue;
      addRelation(entity, 'belongs-to', targetId);
    }
  }
}

/**
 * Add `mentioned-with` edges between every pair of entities co-mentioned in the
 * same source file (both directions, deduped).
 *
 * @param {Object<string, Object>} entities - Entities by id (mutated).
 */
function addMentionedWith(entities) {
  const fileToIds = new Map();
  for (const entity of Object.values(entities)) {
    for (const source of entity.sources) {
      if (source.mentions < 1) continue;
      if (!fileToIds.has(source.file)) fileToIds.set(source.file, new Set());
      fileToIds.get(source.file).add(entity.id);
    }
  }

  for (const ids of fileToIds.values()) {
    const list = Array.from(ids);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addRelation(entities[list[i]], 'mentioned-with', list[j]);
        addRelation(entities[list[j]], 'mentioned-with', list[i]);
      }
    }
  }
}

/**
 * Add a directional relation to an entity, avoiding duplicates.
 *
 * @param {Object} entity - Entity (mutated).
 * @param {string} type - Relation type.
 * @param {string} target - Target entity id.
 */
function addRelation(entity, type, target) {
  if (!entity) return;
  if (entity.relations.some((r) => r.type === type && r.target === target)) return;
  entity.relations.push({ type, target });
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INPUT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Read chunks.json from a brainDir, returning the id→record map (or {} on any
 * failure — degrades to a structural-only graph).
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {Object}
 */
function readChunksJson(brainDir) {
  try {
    const file = path.join(brainDir, 'chunks.json');
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.chunks ? parsed.chunks : {};
  } catch (_err) {
    return {};
  }
}

/**
 * Normalise a chunks input (array or id→record map) to a flat array.
 *
 * @param {Array<Object>|Object} chunks - Chunks input.
 * @returns {Array<Object>}
 */
function toChunkList(chunks) {
  if (Array.isArray(chunks)) return chunks;
  if (chunks && typeof chunks === 'object') return Object.values(chunks);
  return [];
}

/**
 * Resolve workspace roots via WorkspaceManager (graceful), falling back to a
 * single `projects` root for cwd. Mirrors the indexer contract.
 *
 * @param {Object} params
 * @param {string} params.cwd - Working directory.
 * @returns {Promise<Array<{name: string, path: string, tier: string}>>}
 */
async function resolveRoots({ cwd }) {
  try {
    const mod = require('../../workspace');
    if (mod && mod.WorkspaceManager) {
      const wm = new mod.WorkspaceManager({ cwd });
      await wm.load();
      const roots = wm.getRoots();
      if (Array.isArray(roots) && roots.length) {
        return roots.map((r) => ({ name: r.name, path: r.path, tier: r.tier }));
      }
    }
  } catch (_err) {
    // WorkspaceManager unavailable / failed — fall through.
  }
  return [{ name: path.basename(cwd), path: cwd, tier: 'projects' }];
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SMALL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Merge new aliases into an existing list (case-insensitive, in place).
 *
 * @param {string[]} target - Existing aliases (mutated).
 * @param {string[]} incoming - Aliases to add.
 */
function mergeAliasList(target, incoming) {
  const seen = new Set(target.map((a) => a.toLowerCase()));
  for (const alias of incoming) {
    const value = String(alias || '').trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    target.push(value);
  }
}

/**
 * Escape a string for use inside a RegExp.
 *
 * @param {string} str - Raw string.
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  buildGraph,
  readChunksJson,
  MIN_MENTION_LENGTH,
};
