/**
 * AIOX Cortex — Installation Smoke Test
 *
 * Story: WSB-5.3 — Empacotamento e Distribuição do Cortex
 *
 * Exercises a REAL programmatic install of `.aios-core` into a throwaway tmp
 * directory and asserts that the AIOX Cortex ships and boots end-to-end:
 *   - all Cortex module directories land in the destination;
 *   - the workspace + brain barrels load from the destination without error;
 *   - WorkspaceManager.init scaffolds a workspace in tmp;
 *   - BrainIndexer.index (with explicit roots + tmp brainDir) builds an index.
 *
 * Also verifies the additive `project.cortex-modules` health check (AC4/AC5).
 *
 * Node module resolution note: the installed modules depend on packages
 * (fs-extra, js-yaml, fast-glob, ...) resolved by walking up from the module
 * file. We symlink the repo's node_modules into the tmp root so requires from
 * the DESTINATION resolve the same dependency tree the package ships against.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  installAiosCore,
} = require('../../packages/installer/src/installer/aios-core-installer');
const CortexModulesCheck = require('../../.aios-core/core/health-check/checks/project/cortex-modules');

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

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('AIOX Cortex — installation smoke test (WSB-5.3)', () => {
  let tmpDir;
  let targetAiosCoreCore;
  let workspaceDir;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-smoke-'));

    // Real install into the tmp target.
    const result = await installAiosCore({ targetDir: tmpDir });
    expect(result.success).toBe(true);

    // Let the installed modules resolve the shipped dependency tree.
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

    targetAiosCoreCore = path.join(tmpDir, '.aios-core', 'core');
    workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir);
  }, 30000);

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installs all Cortex module directories into the destination', () => {
    for (const mod of CORTEX_MODULES) {
      const modPath = path.join(targetAiosCoreCore, mod);
      expect(fs.existsSync(modPath)).toBe(true);
      expect(fs.statSync(modPath).isDirectory()).toBe(true);
    }
  });

  it('loads the workspace and brain barrels from the destination', () => {
    const wsMod = require(path.join(targetAiosCoreCore, 'workspace'));
    const brainMod = require(path.join(targetAiosCoreCore, 'brain'));

    expect(typeof wsMod.WorkspaceManager).toBe('function');
    expect(typeof brainMod.BrainIndexer).toBe('function');
  });

  it('scaffolds a workspace via WorkspaceManager.init in the destination', async () => {
    const { WorkspaceManager } = require(path.join(targetAiosCoreCore, 'workspace'));
    const wm = new WorkspaceManager({ cwd: workspaceDir });

    const initResult = await wm.init({ name: 'cortex-smoke' });

    expect(fs.existsSync(initResult.manifestPath)).toBe(true);
    expect(path.basename(initResult.manifestPath)).toBe('workspace.yaml');
    expect(initResult.createdFolders.length).toBeGreaterThan(0);
  });

  it('builds a brain index via BrainIndexer.index with explicit roots', async () => {
    const { BrainIndexer } = require(path.join(targetAiosCoreCore, 'brain'));

    // Seed a document so the index has something to chunk.
    fs.writeFileSync(
      path.join(workspaceDir, 'note.md'),
      '# Cortex Smoke\n\nWorkspace brain indexing smoke content.\n',
      'utf8',
    );

    const brainDir = path.join(tmpDir, 'brain-store');
    const indexer = new BrainIndexer({
      cwd: workspaceDir,
      roots: [{ name: 'ws', path: workspaceDir, tier: 'projects' }],
      brainDir,
    });

    const stats = await indexer.index();

    expect(stats.filesScanned).toBeGreaterThan(0);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(brainDir, 'index.json'))).toBe(true);
  });
});

describe('project.cortex-modules health check (WSB-5.3 AC4)', () => {
  it('passes when all Cortex modules are present and reports LOW severity', async () => {
    const check = new CortexModulesCheck();

    expect(check.id).toBe('project.cortex-modules');
    expect(check.severity).toBe('LOW');

    const result = await check.execute({ projectRoot: REPO_ROOT });

    // Additive/informational: never fails or errors.
    expect(['pass', 'warning']).toContain(result.status);
    expect(result.details).toBeTruthy();
    expect(result.details.state).toHaveProperty('workspaceInitialized');
    expect(result.details.state).toHaveProperty('brainIndexPresent');
    expect(result.details.state).toHaveProperty('providersAvailable');
  });

  it('reports workspaceInitialized=true when a workspace.yaml exists at the root', async () => {
    const check = new CortexModulesCheck();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-check-'));
    try {
      fs.writeFileSync(path.join(tmp, 'workspace.yaml'), 'name: probe\n', 'utf8');
      const result = await check.execute({ projectRoot: tmp });
      expect(result.details.state.workspaceInitialized).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
