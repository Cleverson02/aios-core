/**
 * AIOS Brain — Barrel
 *
 * Story: WSB-1.2 - Brain Indexer (índice léxico com metadados de origem)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Single entry point for the workspace brain:
 * - BrainIndexer  → incremental lexical indexer with origin metadata
 * - brainCommand  → CLI handler for `aios brain index|ask|status`
 * - chunkFile     → file → chunk splitter (markdown / code / text)
 * - buildIndex / searchIndex / tokenize → lexical index primitives
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const { BrainIndexer } = require('./indexer');
const { brainCommand } = require('./cli');
const { chunkFile } = require('./chunker');
const { buildIndex, searchIndex, tokenize } = require('./lexical-search');

module.exports = {
  BrainIndexer,
  brainCommand,
  chunkFile,
  buildIndex,
  searchIndex,
  tokenize,
};
