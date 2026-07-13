#!/usr/bin/env node

/**
 * AIOS Brain — Entity Queries
 *
 * Story: WSB-1.4 - Grafo de Entidades do Negócio
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Read-side helpers over the persisted entity graph:
 *
 *   - getEntity(brainDir, nameOrAlias)          → resolve a single entity
 *   - listEntities(brainDir, {type})            → all entities (optional filter)
 *   - related(brainDir, nameOrId, {depth})      → BFS over relations
 *   - whereIs(brainDir, nameOrId)               → source files by mention count
 *
 * `related` traverses the relation graph treating each stored (directional) edge
 * as navigable in *both* directions, so querying an area returns the entities
 * that belong to it and vice-versa. Each returned neighbour is labelled with the
 * relation type of the edge it was reached through and its BFS depth.
 *
 * Design constraints: zero new dependencies.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const { EntityStore } = require('./entity-store');

/**
 * Build a loaded store for a brainDir.
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {EntityStore}
 */
function loadStore(brainDir) {
  return new EntityStore({ brainDir }).load();
}

/**
 * Resolve a single entity by id / name / alias.
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string} nameOrAlias - Lookup key.
 * @returns {Object|null}
 */
function getEntity(brainDir, nameOrAlias) {
  return loadStore(brainDir).get(nameOrAlias);
}

/**
 * List entities, optionally filtered by type.
 *
 * @param {string} brainDir - Persistence directory.
 * @param {Object} [options]
 * @param {string} [options.type] - Restrict to a type.
 * @returns {Object[]}
 */
function listEntities(brainDir, { type } = {}) {
  return loadStore(brainDir).list({ type });
}

/**
 * Return an entity's source files ordered by mention count (desc).
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string} nameOrId - Lookup key.
 * @returns {Array<{file: string, mentions: number}>}
 */
function whereIs(brainDir, nameOrId) {
  const entity = getEntity(brainDir, nameOrId);
  if (!entity) return [];
  return [...entity.sources].sort((a, b) => b.mentions - a.mentions);
}

/**
 * Breadth-first traversal over the relation graph from a starting entity.
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string} nameOrId - Starting entity (id/name/alias).
 * @param {Object} [options]
 * @param {number} [options.depth=1] - Maximum hop distance.
 * @returns {Array<{id: string, name: string, type: string, relation: string, depth: number}>}
 *          Neighbours (excluding the start), nearest first.
 */
function related(brainDir, nameOrId, { depth = 1 } = {}) {
  const store = loadStore(brainDir);
  const start = store.get(nameOrId);
  if (!start) return [];

  const byId = new Map(store.list().map((e) => [e.id, e]));
  const adjacency = buildAdjacency(byId);

  const visited = new Set([start.id]);
  const results = [];
  let frontier = [{ id: start.id, relation: null }];

  for (let level = 1; level <= depth; level++) {
    const next = [];
    for (const node of frontier) {
      for (const edge of adjacency.get(node.id) || []) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        const entity = byId.get(edge.target);
        if (!entity) continue;
        results.push({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          relation: edge.type,
          depth: level,
        });
        next.push({ id: entity.id, relation: edge.type });
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  return results;
}

/**
 * Build an undirected adjacency map from stored (directional) relations.
 *
 * @param {Map<string, Object>} byId - Entities keyed by id.
 * @returns {Map<string, Array<{target: string, type: string}>>}
 */
function buildAdjacency(byId) {
  const adjacency = new Map();
  const push = (from, target, type) => {
    if (!byId.has(from) || !byId.has(target)) return;
    if (!adjacency.has(from)) adjacency.set(from, []);
    const edges = adjacency.get(from);
    if (!edges.some((e) => e.target === target && e.type === type)) {
      edges.push({ target, type });
    }
  };

  for (const entity of byId.values()) {
    for (const relation of entity.relations) {
      push(entity.id, relation.target, relation.type);
      push(relation.target, entity.id, relation.type);
    }
  }
  return adjacency;
}

module.exports = {
  getEntity,
  listEntities,
  related,
  whereIs,
};
