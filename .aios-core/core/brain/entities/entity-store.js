#!/usr/bin/env node

/**
 * AIOS Brain — Entity Store
 *
 * Story: WSB-1.4 - Grafo de Entidades do Negócio
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Persisted CRUD for the business entity graph. Entities live in `entities.json`
 * inside the brainDir (never a versioned folder), alongside the lexical index:
 *
 *   {
 *     version: 1,
 *     entities: {
 *       <id>: {
 *         id,            // slug of the name (stable key)
 *         name,          // human name
 *         type,          // client|product|person|project|brand|area|other
 *         aliases: [],   // alternative spellings scanned for mentions
 *         description,   // short description
 *         sources: [{ file, mentions }],   // where the entity is mentioned
 *         relations: [{ type, target }],   // directional edges (target = id)
 *         origin,        // 'auto' (extracted) | 'manual' (human-curated)
 *         updatedAt      // ISO timestamp
 *       }
 *     }
 *   }
 *
 * Merge rule (AC5): a `manual` entity is authoritative on its identity fields
 * (name/type/aliases/description). An `auto` re-build may only refresh `sources`
 * and *add* relations — it never overwrites a manual identity. Relations are
 * unioned so manually created links (`link`) survive a re-scan.
 *
 * Relations are directional and typed (a → b, type). `link()` therefore writes a
 * single edge; callers wanting a reciprocal edge must call it twice. The graph
 * builder writes both directions for `mentioned-with` deliberately.
 *
 * Design constraints: zero new dependencies (native fs/path only).
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;

/** Canonical entity types. Anything else is normalised to `other`. */
const ENTITY_TYPES = new Set([
  'client',
  'product',
  'person',
  'project',
  'brand',
  'area',
  'other',
]);

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SLUG + NORMALISATION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Derive a stable slug id from a name: lowercased, accents kept, non-word runs
 * collapsed to a single dash, edges trimmed.
 *
 * @param {string} name - Entity name (or any string).
 * @returns {string} Slug (may be empty for blank input).
 */
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalise an arbitrary entity-like object into the canonical persisted shape.
 *
 * @param {Object} entity - Partial entity.
 * @returns {Object} Canonical entity.
 */
function normalizeEntity(entity) {
  const src = entity || {};
  const name = String(src.name || src.id || '').trim();
  const id = src.id ? String(src.id) : slugify(name);

  return {
    id,
    name: name || id,
    type: normalizeType(src.type),
    aliases: uniqStrings(src.aliases),
    description: typeof src.description === 'string' ? src.description.trim() : '',
    sources: normalizeSources(src.sources),
    relations: normalizeRelations(src.relations),
    origin: src.origin === 'manual' ? 'manual' : 'auto',
    updatedAt: src.updatedAt || new Date().toISOString(),
  };
}

/**
 * Coerce a type to the canonical set, defaulting to `other`.
 *
 * @param {string} type - Raw type.
 * @returns {string}
 */
function normalizeType(type) {
  const t = String(type || '').trim().toLowerCase();
  return ENTITY_TYPES.has(t) ? t : 'other';
}

/**
 * De-duplicate a list of strings (case-insensitive), preserving first spelling.
 *
 * @param {Array<string>} list - Raw list.
 * @returns {string[]}
 */
function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Normalise + de-duplicate sources by file, keeping the highest mention count.
 *
 * @param {Array<{file: string, mentions: number}>} sources - Raw sources.
 * @returns {Array<{file: string, mentions: number}>}
 */
function normalizeSources(sources) {
  const byFile = new Map();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || !s.file) continue;
    const mentions = Number.isFinite(s.mentions) ? s.mentions : 0;
    const prev = byFile.get(s.file);
    byFile.set(s.file, prev == null ? mentions : Math.max(prev, mentions));
  }
  return Array.from(byFile.entries())
    .map(([file, mentions]) => ({ file, mentions }))
    .sort((a, b) => b.mentions - a.mentions);
}

/**
 * Normalise + de-duplicate relations by `type::target`.
 *
 * @param {Array<{type: string, target: string}>} relations - Raw relations.
 * @returns {Array<{type: string, target: string}>}
 */
function normalizeRelations(relations) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(relations) ? relations : []) {
    if (!r || !r.type || !r.target) continue;
    const key = `${r.type}::${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: String(r.type), target: String(r.target) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENTITY STORE
// ═══════════════════════════════════════════════════════════════════════════════════

class EntityStore {
  /**
   * @param {Object} options
   * @param {string} options.brainDir - Persistence directory (holds entities.json).
   */
  constructor({ brainDir } = {}) {
    if (!brainDir) throw new Error('EntityStore requires a brainDir');
    this.brainDir = brainDir;
    this.entitiesPath = path.join(brainDir, 'entities.json');
    this._data = null;
  }

  /**
   * Load persisted entities into memory (idempotent). Missing / corrupt files
   * degrade to an empty store rather than throwing.
   *
   * @returns {EntityStore} this
   */
  load() {
    if (this._data) return this;
    this._data = { version: STORE_VERSION, entities: {} };
    try {
      if (fs.existsSync(this.entitiesPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.entitiesPath, 'utf8'));
        if (parsed && parsed.entities && typeof parsed.entities === 'object') {
          for (const raw of Object.values(parsed.entities)) {
            const entity = normalizeEntity(raw);
            this._data.entities[entity.id] = entity;
          }
        }
      }
    } catch (_err) {
      // Corrupt store — start empty (graceful degradation).
      this._data = { version: STORE_VERSION, entities: {} };
    }
    return this;
  }

  /**
   * Persist the in-memory store to disk (creates brainDir if needed).
   *
   * @returns {EntityStore} this
   */
  save() {
    this.load();
    fs.mkdirSync(this.brainDir, { recursive: true });
    fs.writeFileSync(
      this.entitiesPath,
      JSON.stringify({ version: STORE_VERSION, entities: this._data.entities }, null, 2),
    );
    return this;
  }

  /**
   * Resolve an entity by id, name or alias (all case-insensitive).
   *
   * @param {string} idOrNameOrAlias - Lookup key.
   * @returns {Object|null} The entity, or null when not found.
   */
  get(idOrNameOrAlias) {
    this.load();
    if (idOrNameOrAlias == null) return null;
    const q = String(idOrNameOrAlias).trim().toLowerCase();
    if (!q) return null;

    const entities = this._data.entities;
    if (entities[q]) return entities[q];

    const slug = slugify(q);
    if (slug && entities[slug]) return entities[slug];

    for (const entity of Object.values(entities)) {
      if (entity.name && entity.name.toLowerCase() === q) return entity;
      if (entity.aliases.some((a) => a.toLowerCase() === q)) return entity;
    }
    return null;
  }

  /**
   * Insert or merge an entity.
   *
   * - New id → inserted as-is (normalised).
   * - Existing `manual` id with `preserveManual` → identity fields kept, only
   *   `sources` refreshed and relations unioned (AC5).
   * - Otherwise → incoming replaces the stored record (aliases/relations unioned
   *   to avoid losing information on an auto re-merge).
   *
   * @param {Object} entity - Entity to upsert.
   * @param {Object} [options]
   * @param {boolean} [options.preserveManual=false] - Respect manual identity.
   * @returns {Object} The stored entity.
   */
  upsert(entity, { preserveManual = false } = {}) {
    this.load();
    const incoming = normalizeEntity(entity);
    const existing = this._data.entities[incoming.id];

    if (!existing) {
      this._data.entities[incoming.id] = incoming;
      return incoming;
    }

    let merged;
    if (preserveManual && existing.origin === 'manual') {
      // Manual identity is authoritative; auto only refreshes sources and adds links.
      merged = {
        ...existing,
        sources: incoming.sources,
        relations: normalizeRelations([...existing.relations, ...incoming.relations]),
        updatedAt: new Date().toISOString(),
      };
    } else {
      merged = {
        ...existing,
        name: incoming.name || existing.name,
        type: incoming.type !== 'other' ? incoming.type : existing.type,
        aliases: uniqStrings([...existing.aliases, ...incoming.aliases]),
        description: incoming.description || existing.description,
        sources: incoming.sources.length ? incoming.sources : existing.sources,
        relations: normalizeRelations([...existing.relations, ...incoming.relations]),
        origin: incoming.origin === 'manual' ? 'manual' : existing.origin,
        updatedAt: new Date().toISOString(),
      };
    }

    this._data.entities[incoming.id] = merged;
    return merged;
  }

  /**
   * Remove an entity (resolved by id/name/alias). Also drops dangling relations
   * pointing at it from other entities.
   *
   * @param {string} idOrNameOrAlias - Entity to remove.
   * @returns {boolean} Whether an entity was removed.
   */
  remove(idOrNameOrAlias) {
    this.load();
    const target = this.get(idOrNameOrAlias);
    if (!target) return false;

    delete this._data.entities[target.id];
    for (const entity of Object.values(this._data.entities)) {
      entity.relations = entity.relations.filter((r) => r.target !== target.id);
    }
    return true;
  }

  /**
   * List entities, optionally filtered by type, sorted by name.
   *
   * @param {Object} [options]
   * @param {string} [options.type] - Restrict to a type.
   * @returns {Object[]} Entities.
   */
  list({ type } = {}) {
    this.load();
    let list = Object.values(this._data.entities);
    if (type) {
      const t = normalizeType(type);
      list = list.filter((e) => e.type === t);
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create a directional, typed relation `a → b`. Resolves both endpoints by
   * id/name/alias. Idempotent (deduped).
   *
   * @param {string} a - Source entity (id/name/alias).
   * @param {string} b - Target entity (id/name/alias).
   * @param {string} relType - Relation type (e.g. 'belongs-to', 'uses').
   * @returns {Object|null} The updated source entity, or null when an endpoint is missing.
   */
  link(a, b, relType) {
    this.load();
    const from = this.get(a);
    const to = this.get(b);
    if (!from || !to || !relType) return null;

    from.relations = normalizeRelations([...from.relations, { type: relType, target: to.id }]);
    from.updatedAt = new Date().toISOString();
    return from;
  }
}

module.exports = {
  EntityStore,
  slugify,
  normalizeEntity,
  normalizeType,
  normalizeRelations,
  ENTITY_TYPES,
  STORE_VERSION,
};
