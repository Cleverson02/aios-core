#!/usr/bin/env node

/**
 * AIOS Brain Lexical Search
 *
 * Story: WSB-1.2 - Brain Indexer (índice léxico com metadados de origem)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * In-memory inverted index with a simple TF-based scorer. The index is a plain
 * serialisable object so it can be persisted to / loaded from JSON without any
 * transformation.
 *
 * Scoring: base weight = (1 + termFrequency), boosted x2 when the term occurs
 * in the chunk heading and x1.5 when it occurs in the file name. Final scores
 * are normalised to the 0-1 range (top result = 1).
 *
 * Design constraints:
 * - Zero dependencies.
 * - Bilingual (PT + EN) minimal embedded stopword list.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const INDEX_VERSION = 1;

/** Minimum token length considered for indexing / querying. */
const MIN_TOKEN_LENGTH = 2;

/** Minimal Portuguese + English stopword list. */
const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
  'with', 'as', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
  'this', 'that', 'these', 'those', 'from', 'into', 'we', 'you', 'they', 'not',
  // Portuguese
  'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'e', 'ou', 'que', 'se', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com',
  'sem', 'ao', 'aos', 'sua', 'seu', 'suas', 'seus', 'como', 'mais', 'ja', 'nao',
  'foi', 'ser', 'sao', 'esta', 'este', 'esse', 'essa', 'isso', 'aqui',
]);

// ═══════════════════════════════════════════════════════════════════════════════════
//                              TOKENISATION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Lowercase, split on non-word boundaries (keeping accented Latin letters),
 * drop stopwords and sub-minimal tokens.
 *
 * @param {string} text - Text to tokenise.
 * @returns {string[]} Ordered list of tokens (may contain duplicates).
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.toLowerCase().match(/[a-z0-9à-ÿ_]+/g);
  if (!matches) return [];
  return matches.filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INDEX BUILD
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build an inverted index from an array of chunk records.
 *
 * Each chunk should provide: `id` (string|number, defaults to array position),
 * `text`, and optionally `heading`, `file`, `tier`, `area`. Heading and file
 * name tokens are flagged per posting so the scorer can apply boosts.
 *
 * @param {Array<{id?: string|number, text?: string, heading?: string, file?: string, tier?: string, area?: string}>} chunks
 * @returns {{version: number, postings: Object, docs: Object, chunkCount: number}}
 */
function buildIndex(chunks) {
  const postings = {}; // term -> { chunkId: { tf, h, f } }
  const docs = {}; // chunkId -> { tier, area }
  const list = Array.isArray(chunks) ? chunks : [];

  for (let i = 0; i < list.length; i++) {
    const chunk = list[i] || {};
    const id = chunk.id != null ? String(chunk.id) : String(i);
    docs[id] = { tier: chunk.tier || null, area: chunk.area || null };

    const headingTokens = new Set(tokenize(chunk.heading));
    const fileTokens = new Set(tokenize(chunk.file));

    // Term frequency across the chunk body.
    const tf = {};
    for (const term of tokenize(chunk.text)) tf[term] = (tf[term] || 0) + 1;
    // Ensure heading/file-only terms are searchable too.
    for (const term of headingTokens) if (!(term in tf)) tf[term] = 0;
    for (const term of fileTokens) if (!(term in tf)) tf[term] = 0;

    for (const term of Object.keys(tf)) {
      if (!postings[term]) postings[term] = {};
      postings[term][id] = {
        tf: tf[term],
        h: headingTokens.has(term),
        f: fileTokens.has(term),
      };
    }
  }

  return { version: INDEX_VERSION, postings, docs, chunkCount: list.length };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SEARCH
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Search an inverted index built by {@link buildIndex}.
 *
 * @param {{postings: Object, docs: Object}} index - Index to query.
 * @param {string} query - Free-text query.
 * @param {Object} [options] - Query options.
 * @param {number} [options.limit=10] - Maximum results.
 * @param {string} [options.tier] - Restrict to a tier.
 * @param {string} [options.area] - Restrict to an area.
 * @returns {Array<{chunkId: string|number, score: number}>} Sorted desc, score 0-1.
 */
function searchIndex(index, query, options = {}) {
  const { limit = 10, tier, area } = options;
  if (!index || !index.postings) return [];

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const scores = {};
  const docs = index.docs || {};

  for (const term of queryTokens) {
    const posting = index.postings[term];
    if (!posting) continue;

    for (const chunkId of Object.keys(posting)) {
      const meta = docs[chunkId] || {};
      if (tier && meta.tier !== tier) continue;
      if (area && meta.area !== area) continue;

      const info = posting[chunkId];
      let weight = 1 + (info.tf || 0); // simple TF base
      if (info.h) weight *= 2; // heading boost
      if (info.f) weight *= 1.5; // file-name boost

      scores[chunkId] = (scores[chunkId] || 0) + weight;
    }
  }

  const entries = Object.keys(scores).map((id) => ({ id, raw: scores[id] }));
  if (!entries.length) return [];

  const max = entries.reduce((m, e) => (e.raw > m ? e.raw : m), 0);
  const results = entries.map((e) => ({
    chunkId: coerceId(e.id),
    score: max > 0 ? e.raw / max : 0,
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Restore a numeric id that was coerced to string during indexing.
 *
 * @param {string} id - Serialised chunk id.
 * @returns {string|number}
 */
function coerceId(id) {
  return /^\d+$/.test(id) ? Number(id) : id;
}

module.exports = {
  tokenize,
  buildIndex,
  searchIndex,
  STOPWORDS,
  INDEX_VERSION,
  MIN_TOKEN_LENGTH,
};
