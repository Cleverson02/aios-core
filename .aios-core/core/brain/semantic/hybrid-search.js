#!/usr/bin/env node

/**
 * AIOS Brain — Semantic & Hybrid Search
 *
 * Story: WSB-1.3 - Busca Semântica Local (provider plugável)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Two entry points over the persisted brain (chunks.json + index.json +
 * vectors.json), all returning the SAME shape as the lexical search plus a
 * `matchType` discriminator:
 *
 *   { score, file, area, tier, heading, snippet, matchType }
 *
 *   - semanticSearch: cosine similarity of the query vector against every chunk
 *     vector (filtered by tier/area), top-K. matchType 'semantic'.
 *   - hybridSearch:   union of the lexical (reusing the existing `searchIndex`)
 *     and semantic result sets, combined per chunk with configurable weights
 *     (default 0.5 / 0.5); a score absent on one side counts as 0.
 *     matchType 'hybrid'.
 *
 * Graceful degradation (AC6): when `vectors.json` is absent, hybridSearch falls
 * back to a pure lexical result set (matchType 'lexical'). To keep the array
 * return contract clean, the fallback is surfaced two ways:
 *   - `hybridSearch(...)` returns the array and emits a single `console.warn`
 *     (guarded so it fires at most once per process).
 *   - `hybridSearchWithMeta(...)` returns `{ results, degraded, warnings }` for
 *     callers that need to react programmatically.
 * This dual API is a deliberate choice: array-shape parity for the common path,
 * structured metadata for the CLI/integration layer.
 *
 * Design constraints:
 * - Zero new dependencies.
 * - Reuses `searchIndex` (lexical-search) and `loadVectors` (semantic-store).
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const { searchIndex } = require('../lexical-search');
const { resolveProvider } = require('./vector-provider');
const { loadVectors, readChunks } = require('./semantic-store');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const INDEX_FILE = 'index.json';

/** Snippet length returned by search (mirrors the lexical indexer). */
const SNIPPET_CHARS = 200;

/** Default hybrid weights. */
const DEFAULT_WEIGHTS = { lexical: 0.5, semantic: 0.5 };

/** One-shot guard so the fallback warning is not spammed. */
let _warnedNoVectors = false;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Safely read + parse a JSON file. Returns null on any failure.
 *
 * @param {string} filePath - File to read.
 * @returns {Object|null}
 */
function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
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

/**
 * Format a chunk + score into the shared result shape.
 *
 * @param {Object} chunk - Chunk record.
 * @param {number} score - Score in [0,1].
 * @param {string} matchType - 'lexical' | 'semantic' | 'hybrid'.
 * @returns {{score: number, file: string, area: string|null, tier: string|null, heading: string|null, snippet: string, matchType: string}}
 */
function formatResult(chunk, score, matchType) {
  return {
    score: Number(score.toFixed(4)),
    file: chunk.file,
    area: chunk.area != null ? chunk.area : null,
    tier: chunk.tier != null ? chunk.tier : null,
    heading: chunk.heading != null ? chunk.heading : null,
    snippet: makeSnippet(chunk.text),
    matchType,
  };
}

/**
 * Cosine similarity of two L2-normalised vectors (reduces to a dot product).
 *
 * @param {number[]|Float32Array} a - First vector.
 * @param {Float32Array} b - Second vector.
 * @returns {number} Similarity in [-1, 1].
 */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Compute raw semantic scores (id → score) for a query against the vector store,
 * filtered by tier/area. Shared by semanticSearch and hybridSearch.
 *
 * @param {string} query - Query text.
 * @param {Object} vectorData - Decoded vector store from loadVectors.
 * @param {Object} chunks - Chunk map.
 * @param {Object} options - { tier, area, provider, api, hashing }.
 * @returns {Promise<Array<{id: string, score: number}>>} Unsorted positive-score hits.
 */
async function semanticScores(query, vectorData, chunks, options) {
  const { tier, area } = options;
  const provider = resolveProvider(options);
  const [qvec] = await provider.embed([String(query || '')]);

  // Dimensionality must match the store, otherwise cosine is meaningless.
  if (!qvec || qvec.length !== vectorData.dim) return [];

  const hits = [];
  const vectors = vectorData.vectors;
  for (const id of Object.keys(vectors)) {
    const chunk = chunks[id];
    if (!chunk) continue;
    if (tier && chunk.tier !== tier) continue;
    if (area && chunk.area !== area) continue;

    const score = cosine(qvec, vectors[id].v);
    if (score > 0) hits.push({ id, score: score > 1 ? 1 : score });
  }
  return hits;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SEMANTIC SEARCH
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Semantic search: cosine top-K of the query vector against all chunk vectors.
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string} query - Free-text query.
 * @param {Object} [options]
 * @param {number} [options.limit=10] - Maximum results.
 * @param {string} [options.tier] - Restrict to a tier.
 * @param {string} [options.area] - Restrict to an area.
 * @param {{name: string, dim: number, embed: Function}} [options.provider] - Explicit provider (DI).
 * @returns {Promise<Array<{score: number, file: string, area: string|null, tier: string|null, heading: string|null, snippet: string, matchType: string}>>}
 */
async function semanticSearch(brainDir, query, options = {}) {
  const { limit = 10 } = options;
  const vectorData = loadVectors(brainDir);
  if (!vectorData) return [];

  const chunks = readChunks(brainDir);
  const hits = await semanticScores(query, vectorData, chunks, options);

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((h) => formatResult(chunks[h.id], h.score, 'semantic'));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HYBRID SEARCH
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Hybrid search with structured metadata. Combines lexical + semantic scores;
 * degrades to pure lexical when the vector store is missing.
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string} query - Free-text query.
 * @param {Object} [options]
 * @param {number} [options.limit=10] - Maximum results.
 * @param {string} [options.tier] - Restrict to a tier.
 * @param {string} [options.area] - Restrict to an area.
 * @param {{lexical: number, semantic: number}} [options.weights] - Combination weights.
 * @param {{name: string, dim: number, embed: Function}} [options.provider] - Explicit provider (DI).
 * @returns {Promise<{results: Array<Object>, degraded: boolean, warnings: string[]}>}
 */
async function hybridSearchWithMeta(brainDir, query, options = {}) {
  const { limit = 10, tier, area } = options;
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
  const warnings = [];

  const chunks = readChunks(brainDir);
  const index = readJson(path.join(brainDir, INDEX_FILE));

  // Pull a generous candidate pool from each side so the union is meaningful.
  const candidatePool = Math.max(50, limit * 5);

  // Lexical side (reuses the existing inverted-index searcher).
  const lexHits = index ? searchIndex(index, query, { limit: candidatePool, tier, area }) : [];

  // Semantic side — may be unavailable → graceful degradation.
  const vectorData = loadVectors(brainDir);
  if (!vectorData) {
    warnings.push('vectors.json ausente — hybridSearch degradou para busca léxica pura.');
    const results = lexHits
      .map((h) => (chunks[h.chunkId] ? formatResult(chunks[h.chunkId], h.score, 'lexical') : null))
      .filter(Boolean)
      .slice(0, limit);
    return { results, degraded: true, warnings };
  }

  const semHits = await semanticScores(query, vectorData, chunks, options);

  // Combine per chunk id (missing score on either side = 0).
  const combined = {};
  for (const h of lexHits) {
    if (!chunks[h.chunkId]) continue;
    combined[h.chunkId] = combined[h.chunkId] || { lex: 0, sem: 0 };
    combined[h.chunkId].lex = h.score;
  }
  for (const h of semHits) {
    combined[h.id] = combined[h.id] || { lex: 0, sem: 0 };
    combined[h.id].sem = h.score;
  }

  const scored = Object.keys(combined).map((id) => ({
    id,
    score: weights.lexical * combined[id].lex + weights.semantic * combined[id].sem,
  }));
  scored.sort((a, b) => b.score - a.score);

  const results = scored
    .slice(0, limit)
    .map((e) => formatResult(chunks[e.id], e.score, 'hybrid'));

  return { results, degraded: false, warnings };
}

/**
 * Hybrid search returning the plain result array (parity with the lexical API).
 * On fallback it emits a single `console.warn` (guarded once per process); use
 * {@link hybridSearchWithMeta} when you need the warning programmatically.
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string} query - Free-text query.
 * @param {Object} [options] - See {@link hybridSearchWithMeta}.
 * @returns {Promise<Array<{score: number, file: string, area: string|null, tier: string|null, heading: string|null, snippet: string, matchType: string}>>}
 */
async function hybridSearch(brainDir, query, options = {}) {
  const meta = await hybridSearchWithMeta(brainDir, query, options);
  if (meta.degraded && !_warnedNoVectors) {
    _warnedNoVectors = true;
    console.warn(`[brain] ${meta.warnings[0]}`);
  }
  return meta.results;
}

module.exports = {
  semanticSearch,
  hybridSearch,
  hybridSearchWithMeta,
  cosine,
  makeSnippet,
  formatResult,
  DEFAULT_WEIGHTS,
  SNIPPET_CHARS,
};
