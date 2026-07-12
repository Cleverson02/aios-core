#!/usr/bin/env node

/**
 * AIOS Brain Indexer
 *
 * Story: WSB-1.2 - Brain Indexer (índice léxico com metadados de origem)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Incremental lexical indexer for the workspace. It walks the workspace roots
 * (resolved from WorkspaceManager with graceful fallback), chunks each eligible
 * file and builds a persisted inverted index where every chunk carries its
 * origin metadata: `{root, tier, area, file, heading, mtime}`.
 *
 * Persistence lives outside any versioned folder — by default under
 * `~/.aiox/brain/<short-sha of workspace path>/` — as three JSON files:
 *   - index.json    → the inverted index (postings + doc tiers/areas)
 *   - chunks.json   → chunk metadata + text (for snippets and reuse)
 *   - manifest.json → file → mtime map + version (drives incremental runs)
 *
 * Design constraints:
 * - Zero new dependencies: fast-glob (existing) + native fs/path/os/crypto.
 * - Total graceful degradation: a missing / unreadable root is reported as a
 *   warning in the return value, never thrown.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fg = require('fast-glob');

const { chunkFile } = require('./chunker');
const { buildIndex, searchIndex } = require('./lexical-search');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const MANIFEST_VERSION = 1;

/** Text extensions eligible for indexing. */
const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);

/** Code extensions eligible for indexing. */
const CODE_EXT = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.yaml', '.yml', '.json',
]);

/** Directory names never traversed. */
const DENY_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.aios', '.aiox', '.synapse',
];

/** Hard file-size ceiling (1 MB). Larger files are skipped. */
const MAX_FILE_SIZE = 1024 * 1024;

/** JSON files above this size are skipped (config / lockfile noise). */
const MAX_JSON_SIZE = 50 * 1024;

/** Snippet length returned by search. */
const SNIPPET_CHARS = 200;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BRAIN INDEXER
// ═══════════════════════════════════════════════════════════════════════════════════

class BrainIndexer {
  /**
   * @param {Object} [options]
   * @param {string} [options.cwd] - Workspace root working directory.
   * @param {Array<{name?: string, path: string, tier?: string}>} [options.roots]
   *        Explicit roots (fallback when WorkspaceManager is unavailable).
   * @param {string} [options.brainDir] - Override for the persistence directory.
   */
  constructor(options = {}) {
    this.cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    this.explicitRoots = Array.isArray(options.roots) ? options.roots : null;
    this.brainDir = options.brainDir || BrainIndexer.defaultBrainDir(this.cwd);

    this.indexPath = path.join(this.brainDir, 'index.json');
    this.chunksPath = path.join(this.brainDir, 'chunks.json');
    this.manifestPath = path.join(this.brainDir, 'manifest.json');

    // In-memory state (lazy-loaded on read paths).
    this._index = null;
    this._chunksById = null;
    this._manifest = null;
  }

  /**
   * Compute the default persistence directory for a workspace path.
   *
   * @param {string} workspacePath - Absolute workspace path.
   * @returns {string}
   */
  static defaultBrainDir(workspacePath) {
    const hash = crypto
      .createHash('sha256')
      .update(path.resolve(workspacePath))
      .digest('hex')
      .slice(0, 12);
    return path.join(os.homedir(), '.aiox', 'brain', hash);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              ROOT RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Resolve workspace roots. Order:
   *   1. Explicit `options.roots` — a deliberate dependency-injection override
   *      (used by tests and embedders; keeps resolution deterministic and
   *      independent of the WorkspaceManager module state).
   *   2. WorkspaceManager (consumed via try/catch — the module may be absent or
   *      its `load()` may fail; either case degrades gracefully).
   *   3. A single `projects` root for `cwd`.
   *
   * @returns {Promise<Array<{name: string, path: string, tier: string}>>}
   */
  async resolveRoots() {
    // 1. Explicit roots take precedence when provided.
    if (this.explicitRoots && this.explicitRoots.length) {
      return this.explicitRoots.map((r) => normalizeRoot(r, this.cwd));
    }

    // 2. WorkspaceManager contract (graceful — module may not exist yet).
    try {
      const mod = require('../workspace');
      if (mod && mod.WorkspaceManager) {
        const wm = new mod.WorkspaceManager({ cwd: this.cwd });
        await wm.load();
        const roots = wm.getRoots();
        if (Array.isArray(roots) && roots.length) {
          return roots.map((r) => normalizeRoot(r, this.cwd));
        }
      }
    } catch (_err) {
      // WorkspaceManager unavailable / failed to load — fall through.
    }

    // 3. Degraded single-root mode.
    return [{ name: path.basename(this.cwd), path: this.cwd, tier: 'projects' }];
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              INDEX
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Scan the workspace roots and (re)build the persisted index.
   *
   * @param {Object} [options]
   * @param {boolean} [options.incremental=true] - Skip unchanged files by mtime.
   * @returns {Promise<{filesScanned: number, filesIndexed: number, filesSkipped: number, chunks: number, durationMs: number, warnings: string[]}>}
   */
  async index(options = {}) {
    const incremental = options.incremental !== false;
    const start = Date.now();
    const warnings = [];

    const roots = await this.resolveRoots();
    const prevManifest = incremental ? this._readJson(this.manifestPath) : null;
    const prevChunks = incremental ? this._readChunks() : {};
    const prevByFile = groupChunksByFile(prevChunks);

    const chunksById = {};
    const manifestFiles = {};
    let filesScanned = 0;
    let filesIndexed = 0;
    let filesSkipped = 0;

    for (const root of roots) {
      if (!root.path || !fs.existsSync(root.path)) {
        warnings.push(`Root não encontrada, ignorada: ${root.name} (${root.path})`);
        continue;
      }

      let files;
      try {
        files = fg.sync('**/*', {
          cwd: root.path,
          absolute: true,
          onlyFiles: true,
          dot: false,
          followSymbolicLinks: false,
          suppressErrors: true,
          ignore: DENY_DIRS.map((d) => `**/${d}/**`),
        });
      } catch (err) {
        warnings.push(`Falha ao varrer root ${root.name}: ${err.message}`);
        continue;
      }

      for (const absPath of files) {
        const decision = this._admit(absPath);
        if (!decision.ok) continue;

        filesScanned++;
        const { mtime, size } = decision;
        const rel = path.relative(root.path, absPath);
        const area = deriveArea(rel);

        const prev = prevManifest && prevManifest.files && prevManifest.files[absPath];
        const canReuse =
          incremental && prev && prev.mtime === mtime && prevByFile[absPath];

        let records;
        if (canReuse) {
          records = prevByFile[absPath];
          filesSkipped++;
        } else {
          records = this._chunkFileToRecords(absPath, rel, root, area, mtime);
          if (records === null) {
            warnings.push(`Falha ao ler arquivo, ignorado: ${absPath}`);
            continue;
          }
          filesIndexed++;
        }

        for (const record of records) chunksById[record.id] = record;
        manifestFiles[absPath] = {
          mtime,
          size,
          root: root.name,
          tier: root.tier,
          area,
        };
      }
    }

    // Build + persist the inverted index (deleted files drop out naturally as
    // they were never re-added to chunksById / manifestFiles).
    const chunkList = Object.values(chunksById);
    const invertedIndex = buildIndex(chunkList);
    const manifest = {
      version: MANIFEST_VERSION,
      workspacePath: this.cwd,
      lastIndexed: new Date().toISOString(),
      files: manifestFiles,
    };

    this._persist(invertedIndex, chunksById, manifest);
    this._index = invertedIndex;
    this._chunksById = chunksById;
    this._manifest = manifest;

    return {
      filesScanned,
      filesIndexed,
      filesSkipped,
      chunks: chunkList.length,
      durationMs: Date.now() - start,
      warnings,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              SEARCH
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Search the index. Loads persisted state into memory on demand.
   *
   * @param {string} query - Free-text query.
   * @param {Object} [options]
   * @param {number} [options.limit=10] - Maximum results.
   * @param {string} [options.tier] - Restrict to a tier.
   * @param {string} [options.area] - Restrict to an area.
   * @returns {Promise<Array<{score: number, file: string, area: string|null, tier: string|null, heading: string|null, snippet: string}>>}
   */
  async search(query, options = {}) {
    this._ensureLoaded();
    if (!this._index) return [];

    const { limit = 10, tier, area } = options;
    const hits = searchIndex(this._index, query, { limit, tier, area });

    const results = [];
    for (const hit of hits) {
      const chunk = this._chunksById[hit.chunkId];
      if (!chunk) continue;
      results.push({
        score: Number(hit.score.toFixed(4)),
        file: chunk.file,
        area: chunk.area,
        tier: chunk.tier,
        heading: chunk.heading,
        snippet: makeSnippet(chunk.text),
      });
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              STATS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Report index statistics. Loads persisted state on demand.
   *
   * @returns {Promise<{files: number, chunks: number, terms: number, lastIndexed: string|null, brainDir: string, roots: Array<{name: string, tier: string, files: number}>}>}
   */
  async stats() {
    this._ensureLoaded();
    const manifest = this._manifest || { files: {}, lastIndexed: null };
    const files = Object.values(manifest.files || {});

    const rootMap = new Map();
    for (const info of files) {
      const key = info.root || 'unknown';
      if (!rootMap.has(key)) {
        rootMap.set(key, { name: key, tier: info.tier || null, files: 0 });
      }
      rootMap.get(key).files++;
    }

    return {
      files: files.length,
      chunks: this._chunksById ? Object.keys(this._chunksById).length : 0,
      terms: this._index && this._index.postings ? Object.keys(this._index.postings).length : 0,
      lastIndexed: manifest.lastIndexed || null,
      brainDir: this.brainDir,
      roots: Array.from(rootMap.values()),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              INTERNAL — FILE ADMISSION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Decide whether a file may be indexed, applying the extension allowlist,
   * the security denylist and size limits.
   *
   * @param {string} absPath - Absolute file path.
   * @returns {{ok: boolean, mtime?: number, size?: number}}
   */
  _admit(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    if (!TEXT_EXT.has(ext) && !CODE_EXT.has(ext)) return { ok: false };

    const base = path.basename(absPath).toLowerCase();
    if (isDeniedFile(base)) return { ok: false };

    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (_err) {
      return { ok: false };
    }
    if (!stat.isFile()) return { ok: false };
    if (stat.size > MAX_FILE_SIZE) return { ok: false };
    if (ext === '.json' && stat.size > MAX_JSON_SIZE) return { ok: false };

    return { ok: true, mtime: stat.mtimeMs, size: stat.size };
  }

  /**
   * Read + chunk a file into persisted chunk records with origin metadata.
   *
   * @param {string} absPath - Absolute file path.
   * @param {string} rel - Path relative to its root.
   * @param {{name: string, tier: string}} root - Owning root.
   * @param {string|null} area - Derived area.
   * @param {number} mtime - File mtime (ms).
   * @returns {Array<Object>|null} Records, or null if the file is unreadable.
   */
  _chunkFileToRecords(absPath, rel, root, area, mtime) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (_err) {
      return null;
    }

    const fileHash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 10);
    const chunks = chunkFile(rel, content);

    return chunks.map((chunk, i) => ({
      id: `${fileHash}#${i}`,
      absPath,
      root: root.name,
      tier: root.tier || null,
      area: area || null,
      file: rel,
      heading: chunk.heading || null,
      startLine: chunk.startLine,
      mtime,
      text: chunk.text,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              INTERNAL — PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Write index, chunks and manifest to disk.
   *
   * @param {Object} invertedIndex - Inverted index object.
   * @param {Object} chunksById - Chunk records keyed by id.
   * @param {Object} manifest - Manifest object.
   */
  _persist(invertedIndex, chunksById, manifest) {
    fs.mkdirSync(this.brainDir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(invertedIndex));
    fs.writeFileSync(
      this.chunksPath,
      JSON.stringify({ version: MANIFEST_VERSION, chunks: chunksById }),
    );
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest));
  }

  /**
   * Lazily load persisted state into memory (no-op if already loaded).
   */
  _ensureLoaded() {
    if (this._index && this._chunksById && this._manifest) return;
    this._index = this._readJson(this.indexPath);
    this._chunksById = this._readChunks();
    this._manifest = this._readJson(this.manifestPath);
  }

  /**
   * Read the chunks store, returning the id→record map (or empty object).
   *
   * @returns {Object}
   */
  _readChunks() {
    const data = this._readJson(this.chunksPath);
    return data && data.chunks ? data.chunks : {};
  }

  /**
   * Safely read + parse a JSON file. Returns null on any failure.
   *
   * @param {string} filePath - File to read.
   * @returns {Object|null}
   */
  _readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_err) {
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MODULE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

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

/**
 * Derive an area name from a path relative to its root: the first directory
 * segment, or null when the file sits directly in the root.
 *
 * @param {string} rel - Relative path.
 * @returns {string|null}
 */
function deriveArea(rel) {
  const segments = rel.split(path.sep).filter(Boolean);
  return segments.length > 1 ? segments[0] : null;
}

/**
 * Security denylist check by file base name.
 *
 * @param {string} base - Lowercased base name.
 * @returns {boolean}
 */
function isDeniedFile(base) {
  if (base.startsWith('.env')) return true;
  if (base.endsWith('.pem')) return true;
  if (base.includes('key')) return true;
  if (base.includes('secret')) return true;
  if (/\.min\./.test(base)) return true;
  return false;
}

/**
 * Group chunk records by their source absolute path.
 *
 * @param {Object} chunksById - Chunk records keyed by id.
 * @returns {Object<string, Array<Object>>} absPath → records.
 */
function groupChunksByFile(chunksById) {
  const byFile = {};
  for (const record of Object.values(chunksById || {})) {
    if (!record || !record.absPath) continue;
    if (!byFile[record.absPath]) byFile[record.absPath] = [];
    byFile[record.absPath].push(record);
  }
  return byFile;
}

/**
 * Build a compact single-line snippet from chunk text.
 *
 * @param {string} text - Chunk text.
 * @returns {string}
 */
function makeSnippet(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

module.exports = {
  BrainIndexer,
  TEXT_EXT,
  CODE_EXT,
  DENY_DIRS,
  deriveArea,
  isDeniedFile,
};
