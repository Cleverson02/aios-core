/**
 * Orchestration Entrypoint — Single Consolidated Entry Point (Epic WSB, Fase 0)
 *
 * The AIOS codebase accumulated THREE overlapping orchestrator generations:
 *
 *   1. WorkflowOrchestrator  — YAML-driven multi-agent workflow runner (1st gen).
 *   2. MasterOrchestrator    — ADE (Autonomous Development Engine) pipeline (2nd gen).
 *   3. BobOrchestrator       — Decision-tree router / "Projeto Bob" (3rd gen, active).
 *
 * As the AIOX Cortex (Workspace Brain) modules — Router, Autonomy, Gateway — come
 * online they need a SINGLE, stable orchestration entry point that does not couple
 * them to any historical generation. This module is that facade.
 *
 * Consolidation strategy (Story WSB-0.1):
 *   - Incremento 1 (this file): expose {@link getOrchestrator} returning the
 *     consolidated BobOrchestrator, plus {@link ORCHESTRATOR_GENERATIONS} which
 *     documents all three generations. Historical entrypoints get `@deprecated`
 *     JSDoc but NO behavioral change.
 *   - Incremento 2 (future): migrate internal consumers onto this entrypoint and
 *     remove duplicate paths in a major release.
 *
 * BobOrchestrator is the GENERATION-TARGET. See ADR-WSB-001.
 *
 * @module core/orchestration/entrypoint
 * @version 1.0.0
 * @see docs/architecture/adr-wsb-001-bob-orchestrator-consolidation.md
 */

'use strict';

/**
 * Catalog of the three historical orchestrator generations.
 *
 * Frozen — treat as read-only documentation of the consolidation state.
 * Each entry declares:
 *   - `name`:   Human-readable generation name.
 *   - `module`: Path (relative to this directory) of the implementing module.
 *   - `status`: 'deprecated' | 'active'. Only BOB is 'active'.
 *   - `since`:  ISO date the generation status was recorded (WSB-0.1).
 *
 * @type {Readonly<{WORKFLOW: object, MASTER: object, BOB: object}>}
 */
const ORCHESTRATOR_GENERATIONS = Object.freeze({
  WORKFLOW: Object.freeze({
    name: 'WorkflowOrchestrator',
    module: './workflow-orchestrator',
    status: 'deprecated',
    since: '2026-07-12',
  }),
  MASTER: Object.freeze({
    name: 'MasterOrchestrator',
    module: './master-orchestrator',
    status: 'deprecated',
    since: '2026-07-12',
  }),
  BOB: Object.freeze({
    name: 'BobOrchestrator',
    module: './bob-orchestrator',
    status: 'active',
    since: '2026-07-12',
  }),
});

/**
 * Returns the consolidated orchestrator instance.
 *
 * By default this returns a {@link BobOrchestrator} (the generation-target).
 * For backward compatibility, callers may request a historical generation via
 * `options.generation` ('workflow' | 'master'); doing so emits a deprecation
 * warning (`process.emitWarning`) and returns an instance of the requested
 * legacy generation.
 *
 * @param {Object} [options={}] - Orchestrator options.
 * @param {('bob'|'workflow'|'master')} [options.generation='bob'] - Which
 *   generation to instantiate. Non-'bob' values are deprecated.
 * @param {string} [options.projectRoot=process.cwd()] - Project root passed to
 *   generations that require it (Bob, Master).
 * @param {string} [options.workflowPath] - Workflow YAML path (WorkflowOrchestrator only).
 * @returns {import('./bob-orchestrator').BobOrchestrator|object} Orchestrator instance.
 */
function getOrchestrator(options = {}) {
  const { generation, projectRoot, workflowPath, ...rest } = options;
  const resolvedRoot = projectRoot || process.cwd();

  if (generation === 'workflow') {
    process.emitWarning(
      'WorkflowOrchestrator is deprecated (Epic WSB, Fase 0). ' +
        'Use getOrchestrator() which returns the consolidated BobOrchestrator. ' +
        'See ADR-WSB-001.',
      { type: 'DeprecationWarning', code: 'WSB_ORCH_WORKFLOW' }
    );
    const WorkflowOrchestrator = require('./workflow-orchestrator');
    return new WorkflowOrchestrator(workflowPath, { projectRoot: resolvedRoot, ...rest });
  }

  if (generation === 'master') {
    process.emitWarning(
      'MasterOrchestrator is deprecated (Epic WSB, Fase 0). ' +
        'Use getOrchestrator() which returns the consolidated BobOrchestrator. ' +
        'See ADR-WSB-001.',
      { type: 'DeprecationWarning', code: 'WSB_ORCH_MASTER' }
    );
    const MasterOrchestrator = require('./master-orchestrator');
    return new MasterOrchestrator(resolvedRoot, rest);
  }

  // Default / generation === 'bob': consolidated generation-target.
  const { BobOrchestrator } = require('./bob-orchestrator');
  return new BobOrchestrator(resolvedRoot, rest);
}

module.exports = {
  getOrchestrator,
  ORCHESTRATOR_GENERATIONS,
};
