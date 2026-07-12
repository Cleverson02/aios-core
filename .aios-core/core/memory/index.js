/**
 * AIOS Memory API - Barrel
 *
 * Story: WSB-0.2 - Memory API Unificada
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Single entry point for the unified memory layer:
 * - MemoryQuery   → lexical retrieval across gotchas, decision logs, stories
 * - SessionMemory → record/retrieve autonomous session decisions
 * - GotchasMemory → known-gotchas store with auto-capture (Story 9.4)
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const MemoryQuery = require('./memory-query');
const SessionMemory = require('./session-memory');
const { GotchasMemory } = require('./gotchas-memory');

module.exports = {
  MemoryQuery,
  SessionMemory,
  GotchasMemory,
};
