/**
 * AIOS Autonomy Engine — barrel (Fase 3 WSB).
 *
 * WSB-3.1 Context Budget Manager (zonas verde/amarela/vermelha)
 * WSB-3.2 Handoff Packet + Fresh Window Spawner
 * WSB-3.3 Heartbeat + escalação por surface-criteria
 *
 * @module core/autonomy
 */

'use strict';

const {
  ContextBudgetManager,
  calculateZone,
  Zone,
  ZONE_ACTIONS,
  DEFAULT_THRESHOLDS,
  AUTONOMY_DIR,
} = require('./context-budget-manager');
const {
  generateHandoffPacket,
  loadHandoffPacket,
  loadLatestHandoffPacket,
  renderMarkdown,
  HANDOFF_DIR,
  PACKET_SCHEMA_VERSION,
} = require('./handoff-packet');
const { spawnFreshWindow, buildContinuationPrompt } = require('./fresh-window');
const {
  Heartbeat,
  HeartbeatMonitor,
  DEFAULT_INTERVAL,
  DEFAULT_STUCK_THRESHOLD,
} = require('./heartbeat');
const { escalate } = require('./escalation');
const { runCommand } = require('./cli');

module.exports = {
  // WSB-3.1
  ContextBudgetManager,
  calculateZone,
  Zone,
  ZONE_ACTIONS,
  DEFAULT_THRESHOLDS,
  AUTONOMY_DIR,
  // WSB-3.2
  generateHandoffPacket,
  loadHandoffPacket,
  loadLatestHandoffPacket,
  spawnFreshWindow,
  buildContinuationPrompt,
  renderMarkdown,
  HANDOFF_DIR,
  PACKET_SCHEMA_VERSION,
  // WSB-3.3
  Heartbeat,
  HeartbeatMonitor,
  DEFAULT_INTERVAL,
  DEFAULT_STUCK_THRESHOLD,
  escalate,
  // CLI
  runCommand,
};
