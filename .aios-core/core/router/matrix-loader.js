/**
 * Capability Matrix Loader — load, merge, validate (Story WSB-2.1).
 *
 * Loads the core `capability-matrix.yaml` and, when present, shallow-merges a
 * project override from `<projectRoot>/.aios/capability-matrix.yaml`. It then
 * validates the result against the JSON Schema (ajv) and runs semantic checks
 * that the schema alone cannot express (every task_routing target must point to
 * an existing model or an existing policy).
 *
 * Shallow-merge semantics (documented contract):
 *   - `models`         → merged per model id; a project entry REPLACES the core
 *                        entry with the same id (no deep field merge).
 *   - `routing_policies` → merged per policy name (project replaces per key).
 *   - `task_routing`   → merged per category (project route overrides core route).
 *   - `default_policy` → project value wins when provided.
 *   - `version`        → project value wins when provided.
 * A project can therefore add a brand-new model + route it, or re-point an
 * existing category, without touching the core file or any code.
 *
 * Degradation: a corrupt/invalid matrix throws a clear, path-annotated error —
 * it NEVER returns a half-valid object or crashes silently.
 *
 * @module core/router/matrix-loader
 * @version 1.0.0
 * @created Story WSB-2.1 — LLM Router
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const schema = require('./capability-matrix-schema.json');

/** Absolute path to the core (repo-versioned) matrix. */
const CORE_MATRIX_PATH = path.join(__dirname, 'capability-matrix.yaml');

/** Project override path relative to a projectRoot. */
const PROJECT_MATRIX_RELPATH = path.join('.aios', 'capability-matrix.yaml');

/**
 * Cache keyed by resolved project override path (or '<core-only>'). Each entry
 * stores the merged matrix and the mtimeMs of every file it was built from, so
 * a change to either file invalidates the cache.
 * @type {Map<string, { matrix: Object, mtimes: Record<string, number> }>}
 */
const cache = new Map();

/**
 * Read + parse a YAML file into an object.
 *
 * @param {string} filePath - Absolute path to the YAML file.
 * @returns {Object} Parsed object.
 * @throws {Error} On unreadable file or malformed YAML.
 */
function readYaml(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read capability matrix at ${filePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    throw new Error(`Invalid YAML in capability matrix ${filePath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid capability matrix ${filePath}: expected a mapping at the top level`);
  }
  return parsed;
}

/**
 * Shallow-merge a project override onto the core matrix. See module docs for
 * the exact per-section contract.
 *
 * @param {Object} core - Core matrix object.
 * @param {Object} override - Project override object (may be partial).
 * @returns {Object} New merged matrix (inputs are not mutated).
 */
function mergeMatrix(core, override) {
  return {
    version: override.version !== undefined ? override.version : core.version,
    models: { ...core.models, ...(override.models || {}) },
    routing_policies: { ...core.routing_policies, ...(override.routing_policies || {}) },
    task_routing: { ...core.task_routing, ...(override.task_routing || {}) },
    default_policy:
      override.default_policy !== undefined ? override.default_policy : core.default_policy,
  };
}

/**
 * Validate a merged matrix against the JSON Schema. Throws a clear,
 * path-annotated error on the first batch of failures.
 *
 * @param {Object} matrix - Merged matrix object.
 * @param {string} context - File path(s) used for the error message.
 * @throws {Error} On schema violation.
 */
function validateSchema(matrix, context) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  if (!validate(matrix)) {
    const details = (validate.errors || [])
      .map((err) => {
        const field = err.instancePath
          ? err.instancePath.replace(/^\//, '').replace(/\//g, '.')
          : '(root)';
        let reason = err.message || 'invalid';
        if (err.keyword === 'additionalProperties' && err.params && err.params.additionalProperty) {
          reason = `unknown property "${err.params.additionalProperty}"`;
        }
        if (err.keyword === 'enum' && err.params && err.params.allowedValues) {
          reason = `${reason} (${err.params.allowedValues.join(', ')})`;
        }
        return `  - ${field}: ${reason}`;
      })
      .join('\n');

    throw new Error(`Capability matrix validation failed (${context}):\n${details}`);
  }
}

/**
 * Run semantic checks the schema cannot express:
 *   - `default_policy` must reference an existing routing_policy.
 *   - every `task_routing` target must be either an existing model id or
 *     `policy:<name>` where `<name>` is an existing policy (or `default`).
 *
 * @param {Object} matrix - Schema-valid merged matrix.
 * @param {string} context - File path(s) used for the error message.
 * @throws {Error} On the first batch of semantic violations.
 */
function validateSemantics(matrix, context) {
  const modelIds = new Set(Object.keys(matrix.models));
  const policyNames = new Set(Object.keys(matrix.routing_policies));
  const errors = [];

  if (!policyNames.has(matrix.default_policy)) {
    errors.push(
      `  - default_policy: "${matrix.default_policy}" is not a defined policy ` +
        `(available: ${[...policyNames].join(', ') || 'none'})`,
    );
  }

  for (const [category, target] of Object.entries(matrix.task_routing)) {
    if (target.startsWith('policy:')) {
      const name = target.slice('policy:'.length);
      if (name !== 'default' && !policyNames.has(name)) {
        errors.push(
          `  - task_routing.${category}: policy "${name}" is not defined ` +
            `(available: ${[...policyNames].join(', ')})`,
        );
      }
    } else if (!modelIds.has(target)) {
      errors.push(
        `  - task_routing.${category}: "${target}" is neither a defined model ` +
          `nor a "policy:<name>" reference (models: ${[...modelIds].join(', ')})`,
      );
    }
  }

  if (errors.length) {
    throw new Error(`Capability matrix semantic validation failed (${context}):\n${errors.join('\n')}`);
  }
}

/**
 * Load the capability matrix (core + optional project override), validated and
 * cached with mtime-based invalidation.
 *
 * @param {Object} [options]
 * @param {string} [options.projectRoot] - Root to look for `.aios/capability-matrix.yaml`.
 * @param {boolean} [options.noCache=false] - Bypass the cache (always re-read).
 * @returns {Object} The validated, merged matrix.
 * @throws {Error} On read/parse/schema/semantic failure (clear, path-annotated).
 */
function loadMatrix({ projectRoot, noCache = false } = {}) {
  const projectPath = projectRoot
    ? path.resolve(projectRoot, PROJECT_MATRIX_RELPATH)
    : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  const cacheKey = projectExists ? projectPath : '<core-only>';

  // Snapshot current mtimes of every source file involved.
  const mtimes = { [CORE_MATRIX_PATH]: statMtime(CORE_MATRIX_PATH) };
  if (projectExists) {
    mtimes[projectPath] = statMtime(projectPath);
  }

  if (!noCache) {
    const cached = cache.get(cacheKey);
    if (cached && sameMtimes(cached.mtimes, mtimes)) {
      return cached.matrix;
    }
  }

  const core = readYaml(CORE_MATRIX_PATH);
  let matrix = core;
  let context = CORE_MATRIX_PATH;

  if (projectExists) {
    const override = readYaml(projectPath);
    matrix = mergeMatrix(core, override);
    context = `${CORE_MATRIX_PATH} + ${projectPath}`;
  }

  validateSchema(matrix, context);
  validateSemantics(matrix, context);

  cache.set(cacheKey, { matrix, mtimes });
  return matrix;
}

/**
 * Clear the in-memory matrix cache (test/hot-reload helper).
 */
function clearCache() {
  cache.clear();
}

/**
 * mtimeMs of a file, or -1 when it cannot be stat'd.
 * @param {string} filePath - Absolute path.
 * @returns {number}
 */
function statMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Compare two mtime maps for exact equality (same keys, same values).
 * @param {Record<string, number>} a
 * @param {Record<string, number>} b
 * @returns {boolean}
 */
function sameMtimes(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

module.exports = {
  loadMatrix,
  clearCache,
  mergeMatrix,
  CORE_MATRIX_PATH,
  PROJECT_MATRIX_RELPATH,
};
