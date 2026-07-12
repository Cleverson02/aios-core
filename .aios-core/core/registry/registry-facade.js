/**
 * Registry Facade
 *
 * Unified read-only facade over the three coexisting AIOS registries:
 *
 *   1. service-registry  (core/registry/registry-loader.js)   → workers/services
 *   2. entity-registry    (core/ids/registry-loader.js)         → IDS entities
 *   3. workflow-registry  (workflow-intelligence/registry/...)  → workflow patterns
 *
 * Provides a single `search()` API returning a normalized shape
 * `{ source, id, type, title, score, ref }`, plus per-source convenience
 * getters. Each underlying registry is loaded lazily on first use behind a
 * try/catch; a registry that fails to load is simply treated as an
 * unavailable source (no throw, graceful degradation).
 *
 * This module is purely additive — it does not modify or wrap any existing
 * consumer of the three registries.
 *
 * @module registry-facade
 * @version 1.0.0
 * @story WSB-0.3 - Registry Facade (unified search over the 3 registries)
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Valid source identifiers accepted by {@link RegistryFacade#search}.
 * @type {string[]}
 */
const SOURCES = ['services', 'entities', 'workflows'];

/**
 * IDS entity types used to enumerate the entity registry through its public
 * query API (the entity loader exposes no public "get all" / "get by id").
 * @type {string[]}
 */
const ENTITY_TYPES = ['task', 'template', 'script', 'module', 'agent', 'checklist', 'data'];

/**
 * Default relative locations of the three registry data files, resolved
 * against the facade's `projectRoot`.
 */
const PATHS = {
  services: '.aios-core/core/registry/service-registry.json',
  entities: '.aios-core/data/entity-registry.yaml',
  workflows: '.aios-core/data/workflow-patterns.yaml',
};

/**
 * Tokenize a free-text query into lowercase word tokens (length >= 2).
 * @param {string} query - Raw search query.
 * @returns {string[]} Normalized tokens.
 */
function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
}

/**
 * Score a candidate against a query across weighted text fields.
 *
 * The same scoring function is applied to every source so that results from
 * different registries can be ranked together on a comparable scale.
 *
 * @param {string} queryLower - Lowercased full query.
 * @param {string[]} tokens - Query tokens.
 * @param {Array<{text: *, weight: number}>} fields - Weighted searchable fields.
 * @returns {number} Relevance score (0 = no match).
 */
function scoreFields(queryLower, tokens, fields) {
  let score = 0;

  for (const field of fields) {
    if (!field || field.text == null) continue;
    const text = String(field.text).toLowerCase();
    if (!text) continue;
    const weight = field.weight;

    if (text === queryLower) {
      score += weight * 3; // exact match
    } else if (text.startsWith(queryLower)) {
      score += weight * 2; // prefix match
    } else if (queryLower && text.includes(queryLower)) {
      score += weight; // substring match on full query
    }

    // Partial multi-token overlap (weighted lower to favour full-query hits)
    if (tokens.length > 1) {
      for (const tok of tokens) {
        if (text.includes(tok)) score += weight * 0.25;
      }
    }
  }

  return score;
}

/**
 * RegistryFacade — unified, read-only access over the three registries.
 */
class RegistryFacade {
  /**
   * @param {Object} [options] - Facade options.
   * @param {string} [options.projectRoot] - Root used to resolve registry
   *   data files. Defaults to `process.cwd()`.
   */
  constructor({ projectRoot } = {}) {
    this.projectRoot = projectRoot || process.cwd();

    // Lazy-loaded registry instances (null once a load attempt failed).
    this._instances = { services: undefined, entities: undefined, workflows: undefined };

    // Availability flags, populated after each load attempt.
    this._available = { services: false, entities: false, workflows: false };
  }

  /**
   * Resolve an absolute path to a registry data file.
   * @param {'services'|'entities'|'workflows'} source
   * @returns {string} Absolute file path.
   */
  _pathFor(source) {
    return path.join(this.projectRoot, PATHS[source]);
  }

  /**
   * Lazily load the service registry. Marks the source unavailable (without
   * throwing) if the file is missing or fails to load.
   * @returns {Promise<Object|null>} ServiceRegistry instance or null.
   */
  async _services() {
    if (this._instances.services !== undefined) return this._instances.services;

    try {
      const registryPath = this._pathFor('services');
      if (!fs.existsSync(registryPath)) throw new Error('service-registry.json not found');

       
      const { ServiceRegistry } = require('./registry-loader');
      const instance = new ServiceRegistry({ registryPath });
      await instance.load();

      this._instances.services = instance;
      this._available.services = true;
    } catch {
      this._instances.services = null;
      this._available.services = false;
    }

    return this._instances.services;
  }

  /**
   * Lazily load the IDS entity registry. A missing file is treated as an
   * unavailable source (the underlying loader would otherwise return an empty
   * registry silently).
   * @returns {Object|null} RegistryLoader instance or null.
   */
  _entities() {
    if (this._instances.entities !== undefined) return this._instances.entities;

    try {
      const registryPath = this._pathFor('entities');
      if (!fs.existsSync(registryPath)) throw new Error('entity-registry.yaml not found');

       
      const { RegistryLoader } = require('../ids/registry-loader');
      const instance = new RegistryLoader(registryPath);
      instance.load();

      this._instances.entities = instance;
      this._available.entities = true;
    } catch {
      this._instances.entities = null;
      this._available.entities = false;
    }

    return this._instances.entities;
  }

  /**
   * Lazily load the workflow registry.
   * @returns {Object|null} WorkflowRegistry instance or null.
   */
  _workflows() {
    if (this._instances.workflows !== undefined) return this._instances.workflows;

    try {
      const patternsPath = this._pathFor('workflows');
      if (!fs.existsSync(patternsPath)) throw new Error('workflow-patterns.yaml not found');

       
      const { WorkflowRegistry } = require('../../workflow-intelligence/registry/workflow-registry');
      const instance = new WorkflowRegistry({ patternsPath });
      instance.loadWorkflows();

      this._instances.workflows = instance;
      this._available.workflows = true;
    } catch {
      this._instances.workflows = null;
      this._available.workflows = false;
    }

    return this._instances.workflows;
  }

  /**
   * Enumerate every entity via the public `queryByType` API (the entity
   * loader exposes no public getById / getAll).
   * @param {Object} loader - RegistryLoader instance.
   * @returns {Array<Object>} All entities across the known types.
   */
  _allEntities(loader) {
    const all = [];
    const seen = new Set();
    for (const type of ENTITY_TYPES) {
      for (const entity of loader.queryByType(type)) {
        if (!seen.has(entity.id)) {
          seen.add(entity.id);
          all.push(entity);
        }
      }
    }
    return all;
  }

  // ---------------------------------------------------------------------------
  // Unified search
  // ---------------------------------------------------------------------------

  /**
   * Search across the requested registries and return a unified, ranked list.
   *
   * @param {string} query - Free-text query.
   * @param {Object} [options]
   * @param {string[]} [options.sources=['services','entities','workflows']] -
   *   Which registries to query. Unknown source names are ignored.
   * @param {number} [options.limit=20] - Max results returned overall.
   * @returns {Promise<Array<{source: string, id: string, type: string,
   *   title: string, score: number, ref: Object}>>} Results ordered by
   *   descending score. `ref` is the original registry object.
   */
  async search(query, { sources = SOURCES, limit = 20 } = {}) {
    const queryLower = String(query || '').toLowerCase();
    const tokens = tokenize(query);
    const requested = sources.filter((s) => SOURCES.includes(s));

    let results = [];

    if (requested.includes('services')) {
      results = results.concat(await this._searchServices(queryLower, tokens));
    }
    if (requested.includes('entities')) {
      results = results.concat(this._searchEntities(queryLower, tokens));
    }
    if (requested.includes('workflows')) {
      results = results.concat(this._searchWorkflows(queryLower, tokens));
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(0, limit));
  }

  /**
   * Search the service registry.
   * @param {string} queryLower
   * @param {string[]} tokens
   * @returns {Promise<Array<Object>>} Normalized results.
   */
  async _searchServices(queryLower, tokens) {
    const registry = await this._services();
    if (!registry) return [];

    let workers;
    try {
      workers = await registry.getAll();
    } catch {
      return [];
    }

    const out = [];
    for (const worker of workers) {
      const score = scoreFields(queryLower, tokens, [
        { text: worker.id, weight: 10 },
        { text: worker.name, weight: 8 },
        { text: (worker.tags || []).join(' '), weight: 5 },
        { text: worker.description, weight: 2 },
      ]);
      if (score > 0) {
        out.push({
          source: 'services',
          id: worker.id,
          type: worker.category || 'service',
          title: worker.name || worker.id,
          score,
          ref: worker,
        });
      }
    }
    return out;
  }

  /**
   * Search the IDS entity registry.
   * @param {string} queryLower
   * @param {string[]} tokens
   * @returns {Array<Object>} Normalized results.
   */
  _searchEntities(queryLower, tokens) {
    const loader = this._entities();
    if (!loader) return [];

    // Gather candidates through the intended public query APIs, then union.
    const candidates = new Map();
    const collect = (list) => {
      for (const entity of list) {
        if (!candidates.has(entity.id)) candidates.set(entity.id, entity);
      }
    };

    try {
      collect(loader.queryByKeywords(tokens));
      if (queryLower) collect(loader.queryByPurpose(queryLower));
      // Also match on id / path substrings for coverage.
      collect(this._allEntities(loader).filter(
        (e) => (e.id && e.id.toLowerCase().includes(queryLower))
          || (e.path && e.path.toLowerCase().includes(queryLower)),
      ));
    } catch {
      return [];
    }

    const out = [];
    for (const entity of candidates.values()) {
      const score = scoreFields(queryLower, tokens, [
        { text: entity.id, weight: 10 },
        { text: (entity.keywords || []).join(' '), weight: 6 },
        { text: entity.purpose, weight: 4 },
        { text: entity.path, weight: 1 },
      ]);
      if (score > 0) {
        out.push({
          source: 'entities',
          id: entity.id,
          type: entity.type || 'entity',
          title: entity.purpose || entity.id,
          score,
          ref: entity,
        });
      }
    }
    return out;
  }

  /**
   * Search the workflow registry.
   * @param {string} queryLower
   * @param {string[]} tokens
   * @returns {Array<Object>} Normalized results.
   */
  _searchWorkflows(queryLower, tokens) {
    const registry = this._workflows();
    if (!registry) return [];

    let names;
    try {
      names = registry.getWorkflowNames();
    } catch {
      return [];
    }

    const out = [];
    for (const name of names) {
      const workflow = registry.getWorkflow(name);
      if (!workflow) continue;
      const score = scoreFields(queryLower, tokens, [
        { text: name, weight: 10 },
        { text: workflow.description, weight: 5 },
        { text: (workflow.key_commands || []).join(' '), weight: 3 },
        { text: (workflow.agent_sequence || []).join(' '), weight: 2 },
      ]);
      if (score > 0) {
        out.push({
          source: 'workflows',
          id: name,
          type: 'workflow',
          title: workflow.description || name,
          score,
          ref: workflow,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Convenience getters
  // ---------------------------------------------------------------------------

  /**
   * Get a single service/worker by id.
   * @param {string} id - Worker id.
   * @returns {Promise<Object|null>} Original worker object or null.
   */
  async getService(id) {
    const registry = await this._services();
    if (!registry || !id) return null;
    try {
      return await registry.getById(id);
    } catch {
      return null;
    }
  }

  /**
   * Get a single entity by id. Uses the public `queryByType` enumeration since
   * the entity loader exposes no public getById.
   * @param {string} id - Entity id.
   * @returns {Promise<Object|null>} Original entity object or null.
   */
  async getEntity(id) {
    const loader = this._entities();
    if (!loader || !id) return null;
    try {
      return this._allEntities(loader).find((e) => e.id === id) || null;
    } catch {
      return null;
    }
  }

  /**
   * Get a single workflow pattern by name.
   * @param {string} id - Workflow name.
   * @returns {Promise<Object|null>} Original workflow object or null.
   */
  async getWorkflow(id) {
    const registry = this._workflows();
    if (!registry || !id) return null;
    try {
      return registry.getWorkflow(id);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /**
   * List the sources that have loaded successfully so far.
   *
   * Availability is determined lazily: a source only reports available after a
   * successful load has been attempted (e.g. via {@link RegistryFacade#search}
   * or a convenience getter). Call {@link RegistryFacade#warmup} to eagerly
   * probe all three.
   *
   * @returns {string[]} Available source identifiers.
   */
  getAvailableSources() {
    return SOURCES.filter((s) => this._available[s]);
  }

  /**
   * Eagerly attempt to load all three registries, then report availability.
   * @returns {Promise<string[]>} Available source identifiers.
   */
  async warmup() {
    await this._services();
    this._entities();
    this._workflows();
    return this.getAvailableSources();
  }
}

module.exports = RegistryFacade;
