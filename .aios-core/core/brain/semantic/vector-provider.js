#!/usr/bin/env node

/**
 * AIOS Brain — Vector Providers
 *
 * Story: WSB-1.3 - Busca Semântica Local (provider plugável)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Pluggable vectorization layer. Every provider implements the same minimal
 * contract so the semantic store / search can stay agnostic:
 *
 *   VectorProvider = {
 *     name: string,                                  // stable identity (drives cache invalidation)
 *     dim: number,                                   // vector dimensionality
 *     async embed(texts: string[]): Promise<number[][]>  // L2-normalised vectors
 *   }
 *
 * Two providers ship here:
 *   - HashingVectorProvider (default, ZERO deps): dense vectors from character
 *     n-grams (3-5) via classic signed feature hashing. Fully deterministic and
 *     offline — captures fuzzy / morphological similarity (PT/EN singular/plural,
 *     radicals) that a term-exact lexical index misses.
 *   - ApiEmbeddingProvider (OPT-IN only): remote embeddings. It is impossible to
 *     construct via `create()` unless BOTH `AIOX_EMBEDDINGS_PROVIDER` and the
 *     matching API key env var are present. No network call ever happens without
 *     that explicit opt-in — nothing leaves the machine by default.
 *
 * A neural local provider (transformers.js) is intentionally left as a future,
 * optional extension implementing the same contract.
 *
 * Design constraints:
 * - Zero new dependencies (native crypto-free hashing + native fetch).
 * - Deterministic default; never throws on empty / non-string input.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

/** Default hashing vector dimensionality. */
const DEFAULT_DIM = 512;

/** Character n-gram sizes (inclusive range). */
const NGRAM_MIN = 3;
const NGRAM_MAX = 5;

/** FNV-1a 32-bit constants. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Second independent hash seed for the sign function (decorrelates ξ from h). */
const SIGN_SEED = 0x9e3779b1;

/** Map of opt-in provider id → the env var that must hold its API key. */
const API_KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
};

/** Default remote model + dimensionality per provider. */
const API_DEFAULTS = {
  openai: { model: 'text-embedding-3-small', dim: 1536, url: 'https://api.openai.com/v1/embeddings' },
  voyage: { model: 'voyage-3-lite', dim: 512, url: 'https://api.voyageai.com/v1/embeddings' },
};

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HASHING PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * FNV-1a 32-bit hash with a configurable seed.
 *
 * @param {string} str - Input string.
 * @param {number} seed - Initial hash state (allows independent hash families).
 * @returns {number} Unsigned 32-bit hash.
 */
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * Normalise text for n-gram extraction: lowercase, strip punctuation (keeping
 * accented Latin letters + digits), collapse whitespace.
 *
 * @param {string} text - Raw text.
 * @returns {string}
 */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^0-9a-zà-ÿ]+/g, ' ')
    .trim();
}

/**
 * Extract character n-grams (sizes {@link NGRAM_MIN}..{@link NGRAM_MAX}) from a
 * text. Each token is wrapped in boundary markers (`#token#`) so prefixes and
 * suffixes are captured — this is what makes singular/plural and radical
 * variants land on overlapping features.
 *
 * @param {string} text - Raw text.
 * @returns {string[]} Ordered list of n-grams (may repeat).
 */
function charNgrams(text) {
  const clean = normalizeText(text);
  if (!clean) return [];

  const grams = [];
  for (const token of clean.split(' ')) {
    if (!token) continue;
    const padded = `#${token}#`;
    for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
      if (padded.length < n) continue;
      for (let i = 0; i + n <= padded.length; i++) {
        grams.push(padded.slice(i, i + n));
      }
    }
  }
  return grams;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HASHING VECTOR PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic, offline embedding provider. Projects character n-grams into a
 * fixed-size dense vector via signed feature hashing, then L2-normalises.
 */
class HashingVectorProvider {
  /**
   * @param {Object} [options]
   * @param {number} [options.dim=512] - Vector dimensionality.
   */
  constructor(options = {}) {
    this.dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : DEFAULT_DIM;
    this.name = `hashing-ng${NGRAM_MIN}${NGRAM_MAX}-d${this.dim}`;
  }

  /**
   * Embed a batch of texts. Always resolves — empty / non-string inputs yield a
   * zero vector.
   *
   * @param {string[]} texts - Texts to embed.
   * @returns {Promise<number[][]>} L2-normalised vectors.
   */
  async embed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    return list.map((t) => this._embedOne(t));
  }

  /**
   * Embed a single text into an L2-normalised dense vector.
   *
   * @param {string} text - Text to embed.
   * @returns {number[]}
   */
  _embedOne(text) {
    const vec = new Array(this.dim).fill(0);
    for (const gram of charNgrams(text)) {
      const bucket = fnv1a(gram, FNV_OFFSET) % this.dim;
      const sign = fnv1a(gram, SIGN_SEED) & 1 ? 1 : -1;
      vec[bucket] += sign;
    }

    // L2 normalisation → cosine similarity reduces to a dot product downstream.
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    }
    return vec;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              API EMBEDDING PROVIDER (OPT-IN)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * L2-normalise a raw embedding vector in place (defensive: remote providers may
 * or may not return normalised vectors).
 *
 * @param {number[]} vec - Raw vector.
 * @returns {number[]} The same array, normalised.
 */
function l2normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Remote embedding provider — DISABLED by default. It can only be instantiated
 * through {@link ApiEmbeddingProvider.create}, which returns `null` unless the
 * user has explicitly opted in via environment variables.
 */
class ApiEmbeddingProvider {
  /**
   * Direct construction requires an explicit provider id + API key. Prefer
   * {@link ApiEmbeddingProvider.create} which enforces the env opt-in.
   *
   * @param {Object} options
   * @param {string} options.provider - Provider id ('openai' | 'voyage').
   * @param {string} options.apiKey - API key.
   * @param {string} [options.model] - Model override.
   * @param {number} [options.dim] - Dimensionality override.
   */
  constructor(options = {}) {
    const { provider, apiKey } = options;
    if (!provider || !apiKey) {
      throw new Error('ApiEmbeddingProvider requires an explicit provider id and apiKey');
    }
    const defaults = API_DEFAULTS[provider] || {};
    this.providerId = provider;
    this.apiKey = apiKey;
    this.model = options.model || defaults.model;
    this.url = options.url || defaults.url;
    this.dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : defaults.dim || 1536;
    this.name = `api:${provider}:${this.model}`;
  }

  /**
   * Factory gated by explicit env opt-in. Returns `null` (never throws) when the
   * user has not opted in — which is the default. NO network call is performed
   * by this method under any circumstance.
   *
   * @param {Object} [options] - Optional model/dim/url overrides.
   * @returns {ApiEmbeddingProvider|null}
   */
  static create(options = {}) {
    const provider = process.env.AIOX_EMBEDDINGS_PROVIDER;
    if (!provider) return null;

    const keyEnv = API_KEY_ENV[provider];
    if (!keyEnv) return null;

    const apiKey = process.env[keyEnv];
    if (!apiKey) return null;

    return new ApiEmbeddingProvider({ provider, apiKey, ...options });
  }

  /**
   * Embed a batch of texts via the remote HTTP API (native fetch, Node 18+).
   * Vectors are L2-normalised before returning.
   *
   * @param {string[]} texts - Texts to embed.
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (!list.length) return [];

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: list }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API ${this.providerId} failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    return rows.map((row) => l2normalize(Array.from(row.embedding || [])));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PROVIDER RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the effective provider. Priority:
 *   1. An explicit `options.provider` implementing the contract (DI override).
 *   2. {@link ApiEmbeddingProvider} — only if the user opted in via env.
 *   3. {@link HashingVectorProvider} — the offline, zero-dep default.
 *
 * @param {Object} [options]
 * @param {{name: string, dim: number, embed: Function}} [options.provider] - Explicit provider.
 * @param {Object} [options.api] - Overrides forwarded to ApiEmbeddingProvider.create.
 * @param {Object} [options.hashing] - Overrides forwarded to HashingVectorProvider.
 * @returns {{name: string, dim: number, embed: Function}}
 */
function resolveProvider(options = {}) {
  if (options.provider && typeof options.provider.embed === 'function') {
    return options.provider;
  }

  const api = ApiEmbeddingProvider.create(options.api || {});
  if (api) return api;

  return new HashingVectorProvider(options.hashing || {});
}

module.exports = {
  HashingVectorProvider,
  ApiEmbeddingProvider,
  resolveProvider,
  charNgrams,
  normalizeText,
  fnv1a,
  l2normalize,
  DEFAULT_DIM,
  API_KEY_ENV,
};
