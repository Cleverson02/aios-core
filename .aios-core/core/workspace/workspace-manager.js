/**
 * Workspace Manager — workspace.yaml multi-root (PARA model)
 *
 * The workspace manifest is the "mapa-mãe" that the AIOX brain reads first.
 * It declares which roots exist (projects / areas / resources / archives) and
 * what each one means, so agents know what they can read and where they can
 * write. This module locates, loads, validates and resolves that manifest.
 *
 * Tiers → permissions (Article of the convention, guia-estrutura-workspace.md):
 *   projects   → writable, no approval (write via story)
 *   areas      → writable, requires approval (surface decision)
 *   resources  → read-only (humans only)
 *   archives   → read-only (cold indexing)
 *
 * Graceful degradation: with no workspace.yaml, the manager runs in single-root
 * mode using the cwd as the only root (tier `projects`). It NEVER throws just
 * because the manifest is absent.
 *
 * @module core/workspace/workspace-manager
 * @version 1.0.0
 * @created Story WSB-1.1 — Workspace Manager
 * @see docs/proposals/aios-workspace-brain/guia-estrutura-workspace.md
 */

const fs = require('fs');
const fse = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const schema = require('./workspace-schema.json');

const MANIFEST_FILENAME = 'workspace.yaml';
const MAX_TRAVERSAL_LEVELS = 10;
const TEMPLATES_DIR = path.join(__dirname, 'templates');

/**
 * Tier → permission posture. Single source of truth for writable/approval.
 * @type {Record<string, { writable: boolean, requiresApproval: boolean }>}
 */
const TIER_PERMISSIONS = {
  projects: { writable: true, requiresApproval: false },
  areas: { writable: true, requiresApproval: true },
  resources: { writable: false, requiresApproval: false },
  archives: { writable: false, requiresApproval: false },
};

/** Tier order used for scaffolding and deterministic output. */
const TIER_ORDER = ['projects', 'areas', 'resources', 'archives'];

/** Folder names created by `init()`, mapped by tier. */
const TIER_FOLDERS = {
  projects: '01-projects',
  areas: '02-areas',
  resources: '03-resources',
  archives: '04-archives',
};

class WorkspaceManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.cwd=process.cwd()] - Directory to resolve the manifest from.
   */
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = path.resolve(cwd);
    this.manifestPath = null;
    this.manifestDir = null;
    this.manifest = null;
    this.workspaceName = null;
    this.roots = [];
    this.loaded = false;
    this.degraded = false;
  }

  /**
   * Locate the nearest workspace.yaml by walking up the directory tree.
   *
   * @param {string} startDir - Directory to start the search from.
   * @returns {string|null} Absolute path to workspace.yaml, or null if none found.
   */
  static findManifest(startDir) {
    let current = path.resolve(startDir);

    for (let level = 0; level < MAX_TRAVERSAL_LEVELS; level++) {
      const candidate = path.join(current, MANIFEST_FILENAME);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break; // reached filesystem root
      }
      current = parent;
    }

    return null;
  }

  /**
   * Alias for {@link WorkspaceManager.findManifest}. Kept for the AC1 naming.
   *
   * @param {string} startDir - Directory to start the search from.
   * @returns {string|null} Absolute path to workspace.yaml, or null.
   */
  static find(startDir) {
    return WorkspaceManager.findManifest(startDir);
  }

  /**
   * Load and validate the manifest. Falls back to single-root degraded mode
   * when no workspace.yaml is found (never throws for absence).
   *
   * @returns {Promise<WorkspaceManager>} this
   * @throws {Error} When the manifest exists but is malformed or invalid.
   */
  async load() {
    const manifestPath = WorkspaceManager.findManifest(this.cwd);

    if (!manifestPath) {
      this._loadDegraded();
      return this;
    }

    this.manifestPath = manifestPath;
    this.manifestDir = path.dirname(manifestPath);

    let raw;
    try {
      raw = await fse.readFile(manifestPath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read workspace manifest at ${manifestPath}: ${error.message}`);
    }

    let parsed;
    try {
      parsed = yaml.load(raw);
    } catch (error) {
      throw new Error(`Invalid YAML in workspace manifest ${manifestPath}: ${error.message}`);
    }

    this._validate(parsed, manifestPath);

    this.manifest = parsed;
    this.workspaceName = parsed.workspace.name;
    this.roots = this._buildRoots(parsed.workspace.roots, this.manifestDir);
    this.degraded = false;
    this.loaded = true;

    return this;
  }

  /**
   * Configure the degraded single-root mode (no manifest present).
   * @private
   */
  _loadDegraded() {
    const name = path.basename(this.cwd);
    this.manifestPath = null;
    this.manifestDir = null;
    this.manifest = null;
    this.workspaceName = name;
    this.roots = [
      {
        name,
        path: this.cwd,
        tier: 'projects',
        aios: fs.existsSync(path.join(this.cwd, '.aios-core')),
        ...TIER_PERMISSIONS.projects,
      },
    ];
    this.degraded = true;
    this.loaded = true;
  }

  /**
   * Validate parsed manifest against the JSON schema. Throws a clear error
   * (field path + reason) on the first batch of validation failures.
   *
   * @param {unknown} parsed - Parsed manifest object.
   * @param {string} manifestPath - Path used for error context.
   * @private
   */
  _validate(parsed, manifestPath) {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid workspace manifest ${manifestPath}: expected a mapping at the top level`);
    }

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    if (!validate(parsed)) {
      const details = (validate.errors || [])
        .map((err) => {
          const field = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)';
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

      throw new Error(`Workspace manifest validation failed (${manifestPath}):\n${details}`);
    }
  }

  /**
   * Build the flat list of resolved roots from the manifest tiers.
   *
   * @param {Object} rootsByTier - `workspace.roots` object.
   * @param {string} baseDir - Manifest directory used to resolve relative paths.
   * @returns {Array<Object>} Resolved roots.
   * @private
   */
  _buildRoots(rootsByTier, baseDir) {
    const roots = [];

    for (const tier of TIER_ORDER) {
      const entries = rootsByTier[tier];
      if (!Array.isArray(entries)) {
        continue;
      }

      for (const entry of entries) {
        const resolvedPath = this._resolvePath(entry.path, baseDir);
        roots.push({
          name: entry.name || path.basename(resolvedPath),
          path: resolvedPath,
          tier,
          aios: entry.aios === true,
          ...TIER_PERMISSIONS[tier],
        });
      }
    }

    return roots;
  }

  /**
   * Resolve a manifest path value (relative / absolute / ~) to an absolute path.
   *
   * @param {string} value - Raw path from the manifest.
   * @param {string} baseDir - Base directory for relative paths.
   * @returns {string} Absolute path.
   * @private
   */
  _resolvePath(value, baseDir) {
    let p = value;
    if (p === '~') {
      p = os.homedir();
    } else if (p.startsWith('~/') || p.startsWith('~\\')) {
      p = path.join(os.homedir(), p.slice(2));
    }
    if (path.isAbsolute(p)) {
      return path.normalize(p);
    }
    return path.resolve(baseDir, p);
  }

  /**
   * Get the resolved roots, optionally filtered by tier.
   *
   * @param {Object} [options]
   * @param {string} [options.tier] - Restrict to a single tier.
   * @returns {Array<{ name: string, path: string, tier: string, aios: boolean, writable: boolean, requiresApproval: boolean }>}
   */
  getRoots({ tier } = {}) {
    const roots = this.roots.map((r) => ({ ...r }));
    if (tier) {
      return roots.filter((r) => r.tier === tier);
    }
    return roots;
  }

  /**
   * Resolve a file path to its owning root and permission posture.
   *
   * @param {string} filePath - Path to resolve (relative to cwd or absolute).
   * @returns {{ root: string, tier: string, area: string, writable: boolean, requiresApproval: boolean }|null}
   *   Resolution result, or null when the path is outside every root.
   */
  resolve(filePath) {
    const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(this.cwd, filePath);

    let best = null;
    for (const root of this.roots) {
      const relative = path.relative(root.path, absolute);
      const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (!inside) {
        continue;
      }
      // Prefer the most specific (longest) matching root.
      if (!best || root.path.length > best.path.length) {
        best = root;
      }
    }

    if (!best) {
      return null;
    }

    return {
      root: best.path,
      tier: best.tier,
      area: best.name,
      writable: best.writable,
      requiresApproval: best.requiresApproval,
    };
  }

  /**
   * @returns {boolean} Whether load() has run successfully.
   */
  isLoaded() {
    return this.loaded;
  }

  /**
   * @returns {string|null} The workspace name (basename of cwd in degraded mode).
   */
  getWorkspaceName() {
    return this.workspaceName;
  }

  /**
   * @returns {string|null} Absolute path to the manifest, or null in degraded mode.
   */
  getManifestPath() {
    return this.manifestPath;
  }

  /**
   * @returns {boolean} Whether the manager is running in degraded single-root mode.
   */
  isDegraded() {
    return this.degraded;
  }

  /**
   * Scaffold a new workspace: workspace.yaml + PARA folders + example area index.
   *
   * @param {Object} [options]
   * @param {string} [options.name] - Workspace name (defaults to basename of dir).
   * @param {string} [options.dir=this.cwd] - Directory to scaffold into.
   * @returns {Promise<{ manifestPath: string, name: string, createdFolders: string[] }>}
   * @throws {Error} When a workspace.yaml already exists in `dir`.
   */
  async init({ name, dir } = {}) {
    const targetDir = path.resolve(dir || this.cwd);
    const manifestPath = path.join(targetDir, MANIFEST_FILENAME);

    if (fs.existsSync(manifestPath)) {
      throw new Error(`A workspace already exists at ${manifestPath}. Refusing to overwrite.`);
    }

    const workspaceName = name || path.basename(targetDir);

    // PARA folders.
    const createdFolders = [];
    for (const tier of TIER_ORDER) {
      const folder = path.join(targetDir, TIER_FOLDERS[tier]);
      await fse.ensureDir(folder);
      createdFolders.push(folder);
    }

    // Example area with its _index.md.
    const exampleAreaDir = path.join(targetDir, TIER_FOLDERS.areas, 'exemplo');
    await fse.ensureDir(exampleAreaDir);
    const areaTemplate = await fse.readFile(path.join(TEMPLATES_DIR, 'area-index-template.md'), 'utf8');
    await fse.writeFile(
      path.join(exampleAreaDir, '_index.md'),
      areaTemplate.replace(/\{\{AREA_NAME\}\}/g, 'Exemplo'),
      'utf8',
    );

    // Manifest from template.
    const manifestTemplate = await fse.readFile(path.join(TEMPLATES_DIR, 'workspace-template.yaml'), 'utf8');
    await fse.writeFile(manifestPath, manifestTemplate.replace(/\{\{WORKSPACE_NAME\}\}/g, workspaceName), 'utf8');

    return { manifestPath, name: workspaceName, createdFolders };
  }
}

module.exports = {
  WorkspaceManager,
  TIER_PERMISSIONS,
  TIER_ORDER,
  TIER_FOLDERS,
  MANIFEST_FILENAME,
};
