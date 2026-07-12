#!/usr/bin/env node

/**
 * AIOS Brain — Semantic Vector Store
 *
 * Story: WSB-1.3 - Busca Semântica Local (provider plugável)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Builds and persists per-chunk embeddings alongside the lexical index, in the
 * same brainDir, as `vectors.json`:
 *
 *   {
 *     version: 1,
 *     provider: <provider.name>,      // drives cache invalidation on provider change
 *     dim: <provider.dim>,
 *     vectors: { <chunkId>: { v: <base64 Float32Array>, mtime: <number> } }
 *   }
 *
 * The build is INCREMENTAL: a chunk's vector is re-used when its `mtime` is
 * unchanged AND the store was written by the same provider; otherwise it is
 * (re)embedded. Chunk ids that no longer exist in `chunks.json` are dropped.
 *
 * Vectors are stored as base64-encoded Float32 to keep the JSON compact and to
 * round-trip losslessly through `loadVectors`.
 *
 * Design constraints:
 * - Zero new dependencies (native fs/path + Buffer base64).
 * - Reads the WSB-1.2 `chunks.json` contract; never mutates it.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const { resolveProvider } = require('./vector-provider');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const VECTORS_VERSION = 1;

/** File name inside brainDir. */
const VECTORS_FILE = 'vectors.json';
const CHUNKS_FILE = 'chunks.json';

/** Embedding batch size (texts per provider.embed call). */
const EMBED_BATCH = 64;

/** Max characters of `heading + text` fed to the embedder per chunk. */
const MAX_EMBED_CHARS = 2000;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SERIALISATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Encode a numeric vector as a base64 Float32 string.
 *
 * @param {number[]|Float32Array} arr - Vector.
 * @returns {string} Base64.
 */
function encodeVector(arr) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/**
 * Decode a base64 Float32 string back into a Float32Array. The bytes are copied
 * into a fresh, exactly-sized ArrayBuffer to avoid any pooled-buffer aliasing.
 *
 * @param {string} b64 - Base64 string.
 * @returns {Float32Array}
 */
function decodeVector(b64) {
  const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

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
 * Read the WSB-1.2 chunk store, returning the id→record map (or empty object).
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {Object<string, Object>}
 */
function readChunks(brainDir) {
  const data = readJson(path.join(brainDir, CHUNKS_FILE));
  return data && data.chunks ? data.chunks : {};
}

/**
 * Build the text fed to the embedder for a chunk: heading + body, truncated.
 *
 * @param {{heading?: string, text?: string}} chunk - Chunk record.
 * @returns {string}
 */
function embedTextForChunk(chunk) {
  const heading = chunk && chunk.heading ? String(chunk.heading) : '';
  const body = chunk && chunk.text ? String(chunk.text) : '';
  return `${heading}\n${body}`.slice(0, MAX_EMBED_CHARS);
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BUILD
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build (or incrementally update) the persisted vector store from `chunks.json`.
 *
 * @param {string} brainDir - Persistence directory (holds chunks.json / vectors.json).
 * @param {Object} [options]
 * @param {{name: string, dim: number, embed: Function}} [options.provider] - Explicit provider (DI).
 * @param {Object} [options.api] - Overrides for the opt-in API provider.
 * @param {Object} [options.hashing] - Overrides for the hashing provider.
 * @returns {Promise<{embedded: number, reused: number, removed: number, durationMs: number, provider: string, dim: number}>}
 */
async function buildVectors(brainDir, options = {}) {
  const start = Date.now();
  const provider = resolveProvider(options);
  const chunks = readChunks(brainDir);

  // Prior store (raw base64) — used both for cache re-use and removal accounting.
  const previous = readJson(path.join(brainDir, VECTORS_FILE));
  const prevVectors = previous && previous.vectors ? previous.vectors : {};
  const sameProvider =
    !!previous && previous.provider === provider.name && previous.dim === provider.dim;

  const out = {};
  const pending = [];
  let reused = 0;

  for (const id of Object.keys(chunks)) {
    const chunk = chunks[id];
    const prev = sameProvider ? prevVectors[id] : null;
    if (prev && prev.mtime === chunk.mtime) {
      out[id] = { v: prev.v, mtime: prev.mtime };
      reused++;
    } else {
      pending.push(id);
    }
  }

  // Embed the (new / changed) chunks in batches.
  let embedded = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batchIds = pending.slice(i, i + EMBED_BATCH);
    const texts = batchIds.map((id) => embedTextForChunk(chunks[id]));
    const vectors = await provider.embed(texts);
    for (let j = 0; j < batchIds.length; j++) {
      const id = batchIds[j];
      out[id] = { v: encodeVector(vectors[j] || []), mtime: chunks[id].mtime };
      embedded++;
    }
  }

  // Chunk ids present before but gone now.
  const removed = Object.keys(prevVectors).filter((id) => !(id in chunks)).length;

  const payload = {
    version: VECTORS_VERSION,
    provider: provider.name,
    dim: provider.dim,
    vectors: out,
  };
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, VECTORS_FILE), JSON.stringify(payload));

  return {
    embedded,
    reused,
    removed,
    durationMs: Date.now() - start,
    provider: provider.name,
    dim: provider.dim,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              LOAD
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Load the persisted vector store with vectors decoded to Float32Array.
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {{version: number, provider: string, dim: number, vectors: Object<string, {v: Float32Array, mtime: number}>}|null}
 */
function loadVectors(brainDir) {
  const raw = readJson(path.join(brainDir, VECTORS_FILE));
  if (!raw || !raw.vectors) return null;

  const vectors = {};
  for (const id of Object.keys(raw.vectors)) {
    const entry = raw.vectors[id];
    vectors[id] = { v: decodeVector(entry.v), mtime: entry.mtime };
  }
  return { version: raw.version, provider: raw.provider, dim: raw.dim, vectors };
}

module.exports = {
  buildVectors,
  loadVectors,
  readChunks,
  encodeVector,
  decodeVector,
  embedTextForChunk,
  VECTORS_VERSION,
  VECTORS_FILE,
  EMBED_BATCH,
  MAX_EMBED_CHARS,
};
