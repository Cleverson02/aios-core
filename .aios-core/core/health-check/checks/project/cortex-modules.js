/**
 * AIOX Cortex Modules Check
 *
 * Verifies the AIOX Cortex (Workspace Brain) modules are present in the
 * installation and reports runtime state (workspace scaffolded, brain index
 * built, providers available). Purely additive and informational: it never
 * reports CRITICAL/HIGH and therefore can never bring `aios doctor` down.
 *
 * @module @synkra/aios-core/health-check/checks/project/cortex-modules
 * @version 1.0.0
 * @story WSB-5.3 - Empacotamento e Distribuição do Cortex
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BaseCheck, CheckSeverity, CheckDomain } = require('../../base-check');

/**
 * Core module directories shipped by the AIOX Cortex.
 * These live as siblings of the health-check module inside `.aios-core/core/`.
 */
const CORTEX_MODULES = [
  'workspace',
  'brain',
  'router',
  'autonomy',
  'gateway',
  'providers',
  'telemetry',
  'dashboard',
  'guide',
];

/**
 * AIOX Cortex modules presence + state check.
 *
 * @class CortexModulesCheck
 * @extends BaseCheck
 */
class CortexModulesCheck extends BaseCheck {
  constructor() {
    super({
      id: 'project.cortex-modules',
      name: 'AIOX Cortex Modules',
      description: 'Verifies AIOX Cortex modules are installed and reports Cortex runtime state',
      domain: CheckDomain.PROJECT,
      // LOW: additive/informational — never brings doctor down.
      severity: CheckSeverity.LOW,
      timeout: 2000,
      cacheable: true,
      healingTier: 0,
      tags: ['aiox', 'cortex', 'workspace', 'brain', 'modules'],
    });
  }

  /**
   * Resolve the `.aios-core/core/` directory that ships the Cortex modules.
   * Resolved relative to this check's own location so it inspects the ACTUAL
   * installed framework, not the user's working directory.
   * @returns {string} Absolute path to `.aios-core/core`.
   */
  getCoreDir() {
    // __dirname = .aios-core/core/health-check/checks/project
    return path.resolve(__dirname, '..', '..', '..');
  }

  /**
   * Inspect Cortex runtime state (best-effort, read-only, side-effect free).
   * @param {string} projectRoot - The user's project/workspace root.
   * @returns {Object} State flags for workspace, brain index, and providers.
   */
  inspectState(projectRoot) {
    const state = {
      workspace: false,
      brainIndex: false,
      providersAvailable: 0,
    };

    // workspace.yaml scaffolded by `aios workspace init`.
    try {
      state.workspace = fs.existsSync(path.join(projectRoot, 'workspace.yaml'));
    } catch {
      // ignore
    }

    // Brain index persisted under ~/.aiox/brain/<hash>/index.json
    // (hash = sha256(resolve(workspacePath)).slice(0,12) — mirrors BrainIndexer).
    try {
      const hash = crypto
        .createHash('sha256')
        .update(path.resolve(projectRoot))
        .digest('hex')
        .slice(0, 12);
      const indexPath = path.join(os.homedir(), '.aiox', 'brain', hash, 'index.json');
      state.brainIndex = fs.existsSync(indexPath);
    } catch {
      // ignore
    }

    // Providers availability cache written by `aios providers status`.
    try {
      const cachePath = path.join(projectRoot, '.aios', 'providers-status.json');
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (parsed && parsed.providers && typeof parsed.providers === 'object') {
          state.providersAvailable = Object.values(parsed.providers).filter(
            (p) => p && p.available === true,
          ).length;
        }
      }
    } catch {
      // ignore
    }

    return state;
  }

  /**
   * Execute the check
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Check result
   */
  async execute(context) {
    const projectRoot = context.projectRoot || process.cwd();
    const coreDir = this.getCoreDir();

    const present = [];
    const missing = [];

    for (const mod of CORTEX_MODULES) {
      const modPath = path.join(coreDir, mod);
      try {
        if (fs.statSync(modPath).isDirectory()) {
          present.push(mod);
        } else {
          missing.push(mod);
        }
      } catch {
        missing.push(mod);
      }
    }

    const state = this.inspectState(projectRoot);
    const stateDetails = {
      workspaceInitialized: state.workspace,
      brainIndexPresent: state.brainIndex,
      providersAvailable: state.providersAvailable,
    };

    if (missing.length > 0) {
      return this.warning(
        `AIOX Cortex incomplete: ${present.length}/${CORTEX_MODULES.length} modules present (missing: ${missing.join(', ')})`,
        {
          recommendation: 'Reinstall or update AIOS to restore the missing Cortex modules',
          details: { present, missing, state: stateDetails },
        },
      );
    }

    // All modules present — report state as informational context.
    const hints = [];
    if (!state.workspace) hints.push('run `aios workspace init` to scaffold a workspace');
    if (!state.brainIndex) hints.push('run `aios brain index` to build the brain index');
    if (state.providersAvailable === 0) {
      hints.push('run `aios setup` to configure at least one LLM provider');
    }

    // NOTE: BaseCheck.pass(message, details) takes the details object directly
    // (unlike warning()/fail() which take an options object with a `.details`).
    return this.pass(`AIOX Cortex ready: all ${CORTEX_MODULES.length} modules present`, {
      present,
      state: stateDetails,
      nextSteps: hints,
    });
  }
}

module.exports = CortexModulesCheck;
