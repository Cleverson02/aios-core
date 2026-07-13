/**
 * AIOS Brain — Entities Barrel
 *
 * Story: WSB-1.4 - Grafo de Entidades do Negócio
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Single entry point for the business entity graph:
 * - EntityStore        → persisted CRUD (entities.json) with manual-merge rule
 * - extractEntities    → candidates from roots + front-matter + `## Entidades`
 * - buildGraph         → extract + mention scan + relations, persisted
 * - getEntity / listEntities / related / whereIs → read-side queries
 * - entitiesCommand    → CLI handler for `aios brain entities`
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const { EntityStore, slugify, normalizeEntity } = require('./entity-store');
const { extractEntities } = require('./entity-extractor');
const { buildGraph } = require('./entity-graph');
const { getEntity, listEntities, related, whereIs } = require('./query');
const { entitiesCommand } = require('./cli-entities');

module.exports = {
  EntityStore,
  slugify,
  normalizeEntity,
  extractEntities,
  buildGraph,
  getEntity,
  listEntities,
  related,
  whereIs,
  entitiesCommand,
};
