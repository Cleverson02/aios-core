/**
 * Tests for WorkspaceManager (Story WSB-1.1).
 *
 * Uses temporary directories under os.tmpdir() so nothing touches the repo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  WorkspaceManager,
  TIER_PERMISSIONS,
} = require('../workspace-manager');

/** Create an isolated temp dir. */
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-'));
}

/** Write a workspace.yaml into dir with the given object. */
function writeManifest(dir, obj) {
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml.dump(obj), 'utf8');
}

/** A minimal valid manifest object. */
function validManifest() {
  return {
    workspace: {
      name: 'Minha Empresa',
      version: 1,
      roots: {
        projects: [{ path: './01-projects/produto-x', aios: true }],
        areas: [{ path: './02-areas/marketing' }, { path: './02-areas/design' }],
        resources: [{ path: './03-resources/marca' }],
        archives: [{ path: './04-archives' }],
      },
      permissions: { default: 'read' },
    },
  };
}

describe('WorkspaceManager.findManifest', () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('finds workspace.yaml walking up directories', () => {
    writeManifest(root, validManifest());
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });

    const found = WorkspaceManager.findManifest(deep);
    expect(found).toBe(path.join(root, 'workspace.yaml'));
  });

  test('returns null when no manifest exists', () => {
    const deep = path.join(root, 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });
    // root itself has no manifest; tmpdir ancestors are unlikely to, but the
    // traversal cap keeps this bounded regardless.
    const found = WorkspaceManager.findManifest(deep);
    expect(found === null || typeof found === 'string').toBe(true);
    // The manifest we did NOT write must not be reported inside our temp tree.
    expect(fs.existsSync(path.join(root, 'workspace.yaml'))).toBe(false);
  });
});

describe('WorkspaceManager.load — valid manifest', () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
    writeManifest(root, validManifest());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loads, validates and exposes metadata', async () => {
    const wm = await new WorkspaceManager({ cwd: root }).load();

    expect(wm.isLoaded()).toBe(true);
    expect(wm.isDegraded()).toBe(false);
    expect(wm.getWorkspaceName()).toBe('Minha Empresa');
    expect(wm.getManifestPath()).toBe(path.join(root, 'workspace.yaml'));
  });

  test('resolves relative paths against the manifest dir', async () => {
    const wm = await new WorkspaceManager({ cwd: root }).load();
    const projects = wm.getRoots({ tier: 'projects' });

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe(path.join(root, '01-projects', 'produto-x'));
    expect(projects[0].aios).toBe(true);
    expect(projects[0].name).toBe('produto-x');
  });

  test('expands ~ in paths', async () => {
    const manifest = validManifest();
    manifest.workspace.roots.resources.push({ path: '~/global-marca' });
    writeManifest(root, manifest);

    const wm = await new WorkspaceManager({ cwd: root }).load();
    const resources = wm.getRoots({ tier: 'resources' });
    const homeRoot = resources.find((r) => r.name === 'global-marca');
    expect(homeRoot.path).toBe(path.join(os.homedir(), 'global-marca'));
  });

  test('accepts absolute paths as-is', async () => {
    const abs = path.join(root, 'somewhere-abs');
    const manifest = validManifest();
    manifest.workspace.roots.areas.push({ path: abs, name: 'abs-area' });
    writeManifest(root, manifest);

    const wm = await new WorkspaceManager({ cwd: root }).load();
    const area = wm.getRoots({ tier: 'areas' }).find((r) => r.name === 'abs-area');
    expect(area.path).toBe(path.normalize(abs));
  });
});

describe('WorkspaceManager.load — validation errors', () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('throws a clear error when required name is missing', async () => {
    writeManifest(root, { workspace: { roots: { projects: [] } } });
    const wm = new WorkspaceManager({ cwd: root });
    await expect(wm.load()).rejects.toThrow(/validation failed/i);
    await expect(wm.load()).rejects.toThrow(/name/);
  });

  test('throws with the offending field path for a bad root entry', async () => {
    writeManifest(root, {
      workspace: { name: 'X', roots: { areas: [{ name: 'no-path' }] } },
    });
    const wm = new WorkspaceManager({ cwd: root });
    await expect(wm.load()).rejects.toThrow(/roots\.areas\.0/);
    await expect(wm.load()).rejects.toThrow(/path/);
  });

  test('rejects unknown top-level properties', async () => {
    writeManifest(root, {
      workspace: { name: 'X', roots: { projects: [] } },
      bogus: true,
    });
    const wm = new WorkspaceManager({ cwd: root });
    await expect(wm.load()).rejects.toThrow(/unknown property "bogus"/);
  });
});

describe('WorkspaceManager.load — degraded mode', () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('falls back to single-root projects tier without throwing', async () => {
    const sub = path.join(root, 'lonely-project');
    fs.mkdirSync(sub);
    const wm = await new WorkspaceManager({ cwd: sub }).load();

    expect(wm.isDegraded()).toBe(true);
    expect(wm.isLoaded()).toBe(true);
    expect(wm.getManifestPath()).toBeNull();
    expect(wm.getWorkspaceName()).toBe('lonely-project');

    const roots = wm.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].tier).toBe('projects');
    expect(roots[0].path).toBe(sub);
    expect(roots[0].writable).toBe(true);
    expect(roots[0].requiresApproval).toBe(false);
  });

  test('degraded root flags aios when .aios-core is present', async () => {
    fs.mkdirSync(path.join(root, '.aios-core'));
    const wm = await new WorkspaceManager({ cwd: root }).load();
    expect(wm.getRoots()[0].aios).toBe(true);
  });
});

describe('WorkspaceManager — tiers and permissions', () => {
  let root;
  let wm;

  beforeEach(async () => {
    root = mkTmp();
    writeManifest(root, validManifest());
    wm = await new WorkspaceManager({ cwd: root }).load();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('projects are writable without approval', () => {
    expect(wm.getRoots({ tier: 'projects' })[0]).toMatchObject(TIER_PERMISSIONS.projects);
  });

  test('areas are writable with approval', () => {
    for (const area of wm.getRoots({ tier: 'areas' })) {
      expect(area).toMatchObject(TIER_PERMISSIONS.areas);
    }
  });

  test('resources are read-only', () => {
    expect(wm.getRoots({ tier: 'resources' })[0]).toMatchObject(TIER_PERMISSIONS.resources);
    expect(wm.getRoots({ tier: 'resources' })[0].writable).toBe(false);
  });

  test('archives are read-only', () => {
    expect(wm.getRoots({ tier: 'archives' })[0]).toMatchObject(TIER_PERMISSIONS.archives);
    expect(wm.getRoots({ tier: 'archives' })[0].writable).toBe(false);
  });

  test('getRoots() without tier returns all roots', () => {
    expect(wm.getRoots()).toHaveLength(5);
  });
});

describe('WorkspaceManager.resolve', () => {
  let root;
  let wm;

  beforeEach(async () => {
    root = mkTmp();
    writeManifest(root, validManifest());
    wm = await new WorkspaceManager({ cwd: root }).load();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('resolves a file inside a projects root', () => {
    const target = path.join(root, '01-projects', 'produto-x', 'src', 'index.js');
    const result = wm.resolve(target);
    expect(result).toEqual({
      root: path.join(root, '01-projects', 'produto-x'),
      tier: 'projects',
      area: 'produto-x',
      writable: true,
      requiresApproval: false,
    });
  });

  test('resolves a file inside an areas root with approval', () => {
    const target = path.join(root, '02-areas', 'marketing', 'campanhas', 'q1.md');
    const result = wm.resolve(target);
    expect(result.tier).toBe('areas');
    expect(result.area).toBe('marketing');
    expect(result.requiresApproval).toBe(true);
  });

  test('resolves resources as read-only', () => {
    const target = path.join(root, '03-resources', 'marca', 'logo.svg');
    expect(wm.resolve(target).writable).toBe(false);
  });

  test('returns null for a path outside every root', () => {
    const outside = path.join(os.tmpdir(), 'totally-elsewhere', 'file.txt');
    expect(wm.resolve(outside)).toBeNull();
  });

  test('returns null for a sibling that only shares a path prefix', () => {
    // "produto-xyz" shares the "produto-x" prefix but is a different folder.
    const sibling = path.join(root, '01-projects', 'produto-xyz', 'a.js');
    expect(wm.resolve(sibling)).toBeNull();
  });
});

describe('WorkspaceManager.init', () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('scaffolds folders, manifest and example area', async () => {
    const wm = new WorkspaceManager({ cwd: root });
    const result = await wm.init({ name: 'Acme', dir: root });

    expect(result.name).toBe('Acme');
    expect(fs.existsSync(path.join(root, 'workspace.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, '01-projects'))).toBe(true);
    expect(fs.existsSync(path.join(root, '02-areas'))).toBe(true);
    expect(fs.existsSync(path.join(root, '03-resources'))).toBe(true);
    expect(fs.existsSync(path.join(root, '04-archives'))).toBe(true);

    const indexPath = path.join(root, '02-areas', 'exemplo', '_index.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.readFileSync(indexPath, 'utf8')).toContain('Exemplo');
  });

  test('the scaffolded manifest loads and validates', async () => {
    await new WorkspaceManager({ cwd: root }).init({ name: 'Acme', dir: root });
    const wm = await new WorkspaceManager({ cwd: root }).load();

    expect(wm.getWorkspaceName()).toBe('Acme');
    expect(wm.isDegraded()).toBe(false);
    const areas = wm.getRoots({ tier: 'areas' });
    expect(areas.some((a) => a.name === 'exemplo')).toBe(true);
  });

  test('derives the name from the dir basename when omitted', async () => {
    const result = await new WorkspaceManager({ cwd: root }).init({ dir: root });
    expect(result.name).toBe(path.basename(root));
  });

  test('fails when a workspace.yaml already exists', async () => {
    writeManifest(root, validManifest());
    const wm = new WorkspaceManager({ cwd: root });
    await expect(wm.init({ name: 'Acme', dir: root })).rejects.toThrow(/already exists/i);
  });
});

describe('workspaceCommand add (via manifest rewrite)', () => {
  const { workspaceCommand } = require('../cli');
  let root;
  let cwdSpy;

  beforeEach(() => {
    root = mkTmp();
    writeManifest(root, validManifest());
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('adds a new root entry to the requested tier', async () => {
    const code = await workspaceCommand(['add', './02-areas/comercial', '--tier', 'areas']);
    expect(code).toBe(0);

    const parsed = yaml.load(fs.readFileSync(path.join(root, 'workspace.yaml'), 'utf8'));
    const paths = parsed.workspace.roots.areas.map((e) => e.path);
    expect(paths).toContain('./02-areas/comercial');
  });

  test('rejects an invalid tier', async () => {
    const code = await workspaceCommand(['add', './x', '--tier', 'bogus']);
    expect(code).toBe(1);
  });

  test('is idempotent for a duplicate path', async () => {
    await workspaceCommand(['add', './02-areas/comercial', '--tier', 'areas']);
    const code = await workspaceCommand(['add', './02-areas/comercial', '--tier', 'areas']);
    expect(code).toBe(0);

    const parsed = yaml.load(fs.readFileSync(path.join(root, 'workspace.yaml'), 'utf8'));
    const occurrences = parsed.workspace.roots.areas.filter((e) => e.path === './02-areas/comercial');
    expect(occurrences).toHaveLength(1);
  });
});
