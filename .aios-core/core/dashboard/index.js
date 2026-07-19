/**
 * AIOX Cortex — Local Observability Dashboard (barrel, Story WSB-4.7).
 *
 * A zero-dependency, local-only HTTP dashboard that OBSERVES the workspace
 * brain (costs, agents, executions, telemetry) and never controls it
 * (Constitution Art. I). Binds exclusively to 127.0.0.1.
 *
 * @module core/dashboard
 */

'use strict';

const { createDashboardServer, DEFAULT_PORT, HOST } = require('./server');
const { dashboardCommand, PID_RELPATH } = require('./cli');

module.exports = {
  createDashboardServer,
  dashboardCommand,
  DEFAULT_PORT,
  HOST,
  PID_RELPATH,
};
