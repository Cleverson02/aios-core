/**
 * @fileoverview Telemetry barrel — deterministic token & cost ledger (Story WSB-4.5).
 *
 * Single import surface for the local telemetry subsystem:
 *   - `recordUsage` / `recordAgentActivity` / `estimateTokens` (ledger)
 *   - `aggregate` / `getActiveAgents` (report)
 *   - `costsCommand` (`aios costs` CLI)
 *
 * @module core/telemetry
 * @version 1.0.0
 */

const ledger = require('./ledger');
const report = require('./report');
const cli = require('./cli');

module.exports = {
  // ledger
  recordUsage: ledger.recordUsage,
  recordAgentActivity: ledger.recordAgentActivity,
  estimateTokens: ledger.estimateTokens,
  computeCost: ledger.computeCost,
  getPricing: ledger.getPricing,
  TELEMETRY_RELDIR: ledger.TELEMETRY_RELDIR,
  USAGE_FILE: ledger.USAGE_FILE,
  ACTIVITY_FILE: ledger.ACTIVITY_FILE,
  // report
  aggregate: report.aggregate,
  getActiveAgents: report.getActiveAgents,
  parseSince: report.parseSince,
  GROUP_KEYS: report.GROUP_KEYS,
  // cli
  costsCommand: cli.costsCommand,
};
