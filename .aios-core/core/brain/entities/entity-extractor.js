#!/usr/bin/env node

/**
 * AIOS Brain — Entity Extractor
 *
 * Story: WSB-1.4 - Grafo de Entidades do Negócio
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Produces entity *candidates* from three complementary sources:
 *
 *   (a) Structural — each workspace root becomes an entity: a `areas`-tier root
 *       is an `area`, a `projects`-tier root is a `project`.
 *   (b) Front-matter — YAML front-matter (`---` … `---`) of markdown chunks with
 *       an `entities:` key (list of strings or `{name, type, aliases, description}`).
 *   (c) Index sections — the `## Entidades` section of `_index.md` files, with
 *       lines shaped `- Nome (tipo): descrição` (tolerant; type defaults to `other`).
 *
 * Candidates are intentionally *not* aggregated here — the graph builder merges
 * them by slug and attaches mention data. Each candidate carries its origin
 * (`originRoot`, `originTier`, `originFile`) so the builder can derive the
 * `belongs-to` relation for entities defined inside an area root.
 *
 * Design constraints: zero new dependencies beyond `js-yaml` (already a project
 * dependency, used elsewhere by WorkspaceManager). Never throws — malformed YAML
 * or unexpected chunk shapes are skipped.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const path = require('path');
const yaml = require('js-yaml');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Extract entity candidates from workspace roots + indexed chunks.
 *
 * @param {Object} params
 * @param {Array<{name: string, path?: string, tier?: string}>} [params.roots] - Workspace roots.
 * @param {Array<{file?: string, root?: string, tier?: string, heading?: string|null, text?: string}>} [params.chunks]
 *        Chunk records (from chunks.json). Optional — without them only the
 *        structural candidates are produced.
 * @returns {Array<{name: string, type: string, aliases: string[], description: string, source: string, originRoot: string|null, originTier: string|null, originFile: string|null, structural: boolean}>}
 */
function extractEntities({ roots = [], chunks = [] } = {}) {
  const candidates = [];

  // (a) Structural — one entity per root.
  for (const root of Array.isArray(roots) ? roots : []) {
    const type = structuralType(root.tier);
    if (!type) continue;
    candidates.push(
      makeCandidate({
        name: root.name,
        type,
        originRoot: root.name,
        originTier: root.tier || null,
        originFile: null,
        source: 'structural',
        structural: true,
      }),
    );
  }

  // (b) + (c) — chunk-derived candidates.
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || typeof chunk.text !== 'string') continue;
    const file = chunk.file || '';
    if (!/\.(md|markdown)$/i.test(file)) continue;

    // (b) Front-matter of markdown chunks that open with a `---` fence.
    if (chunk.text.trimStart().startsWith('---')) {
      for (const c of extractFromFrontMatter(chunk)) candidates.push(c);
    }

    // (c) `## Entidades` section inside `_index.md` files.
    if (path.basename(file).toLowerCase() === '_index.md' && isEntidadesChunk(chunk)) {
      for (const c of extractFromEntidadesSection(chunk)) candidates.push(c);
    }
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FRONT-MATTER (b)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Parse the YAML front-matter block of a chunk and read its `entities:` key.
 *
 * @param {Object} chunk - Chunk record.
 * @returns {Array<Object>} Candidates.
 */
function extractFromFrontMatter(chunk) {
  const block = frontMatterBlock(chunk.text);
  if (!block) return [];

  let parsed;
  try {
    parsed = yaml.load(block);
  } catch (_err) {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entities)) return [];

  const out = [];
  for (const item of parsed.entities) {
    let candidate = null;
    if (typeof item === 'string') {
      candidate = { name: item, type: 'other', aliases: [], description: '' };
    } else if (item && typeof item === 'object' && item.name) {
      candidate = {
        name: item.name,
        type: item.type || 'other',
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        description: typeof item.description === 'string' ? item.description : '',
      };
    }
    if (!candidate || !String(candidate.name).trim()) continue;
    out.push(
      makeCandidate({
        ...candidate,
        originRoot: chunk.root || null,
        originTier: chunk.tier || null,
        originFile: chunk.file || null,
        source: 'front-matter',
        structural: false,
      }),
    );
  }
  return out;
}

/**
 * Return the raw YAML string between the first two `---` fences, or null.
 *
 * @param {string} text - Chunk text.
 * @returns {string|null}
 */
function frontMatterBlock(text) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    start = lines[i].trim() === '---' ? i : -1;
    break;
  }
  if (start === -1) return null;

  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(start + 1, i).join('\n');
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENTIDADES SECTION (c)
// ═══════════════════════════════════════════════════════════════════════════════════

/** Matches `- Nome (tipo): descrição` with optional description. */
const ENTIDADE_LINE = /^\s*[-*]\s+(.+?)\s*\(([^)]+)\)\s*(?::\s*(.*))?$/;

/**
 * Whether a chunk holds an `## Entidades` section.
 *
 * @param {Object} chunk - Chunk record.
 * @returns {boolean}
 */
function isEntidadesChunk(chunk) {
  if (chunk.heading && /^entidades\b/i.test(String(chunk.heading).trim())) return true;
  return /(^|\n)\s*#{1,6}\s*entidades\b/i.test(chunk.text);
}

/**
 * Parse `- Nome (tipo): descrição` bullet lines from an Entidades chunk.
 *
 * @param {Object} chunk - Chunk record.
 * @returns {Array<Object>} Candidates.
 */
function extractFromEntidadesSection(chunk) {
  const out = [];
  for (const line of String(chunk.text).split(/\r?\n/)) {
    const match = ENTIDADE_LINE.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    out.push(
      makeCandidate({
        name,
        type: (match[2] || 'other').trim(),
        aliases: [],
        description: (match[3] || '').trim(),
        originRoot: chunk.root || null,
        originTier: chunk.tier || null,
        originFile: chunk.file || null,
        source: 'index-section',
        structural: false,
      }),
    );
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Map a tier to its structural entity type.
 *
 * @param {string} tier - Root tier.
 * @returns {string|null} 'area' | 'project' | null.
 */
function structuralType(tier) {
  if (tier === 'areas') return 'area';
  if (tier === 'projects') return 'project';
  return null;
}

/**
 * Build a normalised candidate shape with sane defaults.
 *
 * @param {Object} c - Partial candidate.
 * @returns {Object}
 */
function makeCandidate(c) {
  return {
    name: String(c.name).trim(),
    type: String(c.type || 'other').trim().toLowerCase(),
    aliases: Array.isArray(c.aliases) ? c.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
    description: typeof c.description === 'string' ? c.description.trim() : '',
    source: c.source || 'unknown',
    originRoot: c.originRoot || null,
    originTier: c.originTier || null,
    originFile: c.originFile || null,
    structural: Boolean(c.structural),
  };
}

module.exports = {
  extractEntities,
  frontMatterBlock,
  isEntidadesChunk,
  ENTIDADE_LINE,
};
