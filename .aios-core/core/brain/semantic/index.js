/**
 * AIOS Brain — Semantic Layer Barrel
 *
 * Story: WSB-1.3 - Busca Semântica Local (provider plugável)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Single entry point for the local semantic search layer:
 *   - resolveProvider / HashingVectorProvider / ApiEmbeddingProvider → vectorization
 *   - buildVectors / loadVectors                                     → vector store
 *   - semanticSearch / hybridSearch / hybridSearchWithMeta           → search
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const {
  HashingVectorProvider,
  ApiEmbeddingProvider,
  resolveProvider,
} = require('./vector-provider');
const {
  buildVectors,
  loadVectors,
  readChunks,
} = require('./semantic-store');
const {
  semanticSearch,
  hybridSearch,
  hybridSearchWithMeta,
} = require('./hybrid-search');

module.exports = {
  // Providers
  HashingVectorProvider,
  ApiEmbeddingProvider,
  resolveProvider,
  // Store
  buildVectors,
  loadVectors,
  readChunks,
  // Search
  semanticSearch,
  hybridSearch,
  hybridSearchWithMeta,
};
