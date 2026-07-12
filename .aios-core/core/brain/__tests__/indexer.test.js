/**
 * Tests for the Brain Indexer.
 *
 * Story: WSB-1.2 - Brain Indexer
 *
 * Uses throwaway workspaces under the OS temp dir with a PARA-style layout and
 * an isolated brainDir (never touches ~/.aiox).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { BrainIndexer } = require('../indexer');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Create a fresh temp workspace with a PARA layout and return its paths.
 * @returns {{root: string, areas: string, resources: string, brainDir: string}}
 */
function buildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-brain-'));
  const areas = path.join(root, 'areas');
  const resources = path.join(root, 'resources');
  const brainDir = path.join(root, '.brain-store');

  // areas/marketing — with _index.md and content docs
  const marketing = path.join(areas, 'marketing');
  fs.mkdirSync(path.join(marketing, 'campanhas'), { recursive: true });
  fs.writeFileSync(
    path.join(marketing, '_index.md'),
    '# Marketing\n\nQuality gates for marketing campaigns. Orquestracao de conteudo.\n',
  );
  fs.writeFileSync(
    path.join(marketing, 'campanhas', 'campanha1.md'),
    '# Campanha 1\n\ncampanhaunica xyzcampanha detalhes.\n',
  );

  // areas/design — another area (for scope tests)
  const design = path.join(areas, 'design');
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(path.join(design, '_index.md'), '# Design\n\nDesign gates system tokens.\n');

  // resources/marca — read-only reference
  const marca = path.join(resources, 'marca');
  fs.mkdirSync(marca, { recursive: true });
  fs.writeFileSync(path.join(marca, 'manual.md'), '# Manual da Marca\n\nManual oficial da marca.\n');

  // --- Denylist bait (must NOT be indexed) ---
  // node_modules dir
  fs.mkdirSync(path.join(marketing, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(marketing, 'node_modules', 'junk.md'), 'junktoken should be ignored');
  // .env dotfile
  fs.writeFileSync(path.join(resources, '.env'), 'API_KEY=envsecrettoken');
  // secret / key in name
  fs.writeFileSync(path.join(resources, 'secret-keys.md'), '# Keys\n\nsecretkeytoken value');

  return { root, areas, resources, brainDir };
}

/**
 * Build an indexer over a workspace using explicit roots + isolated brainDir.
 * @param {{root: string, areas: string, resources: string, brainDir: string}} ws
 * @returns {BrainIndexer}
 */
function makeIndexer(ws) {
  return new BrainIndexer({
    cwd: ws.root,
    brainDir: ws.brainDir,
    roots: [
      { name: 'areas', path: ws.areas, tier: 'areas' },
      { name: 'resources', path: ws.resources, tier: 'resources' },
    ],
  });
}

/** Recursively remove a workspace. */
function cleanup(ws) {
  fs.rmSync(ws.root, { recursive: true, force: true });
}

// Allowed files: marketing/_index.md, marketing/campanhas/campanha1.md,
// design/_index.md, marca/manual.md = 4
const EXPECTED_ALLOWED_FILES = 4;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FULL INDEX
// ═══════════════════════════════════════════════════════════════════════════════════

describe('BrainIndexer — full index', () => {
  let ws;
  beforeEach(() => {
    ws = buildWorkspace();
  });
  afterEach(() => cleanup(ws));

  it('indexes all eligible files and produces chunks', async () => {
    const idx = makeIndexer(ws);
    const result = await idx.index({ incremental: false });

    expect(result.filesScanned).toBe(EXPECTED_ALLOWED_FILES);
    expect(result.filesIndexed).toBe(EXPECTED_ALLOWED_FILES);
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it('persists index/chunks/manifest to the isolated brainDir', async () => {
    const idx = makeIndexer(ws);
    await idx.index({ incremental: false });

    expect(fs.existsSync(path.join(ws.brainDir, 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws.brainDir, 'chunks.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws.brainDir, 'manifest.json'))).toBe(true);
  });

  it('carries correct origin metadata on chunks (area, tier, file, heading)', async () => {
    const idx = makeIndexer(ws);
    await idx.index({ incremental: false });

    const results = await idx.search('orquestracao');
    expect(results.length).toBeGreaterThan(0);
    const hit = results[0];
    expect(hit.area).toBe('marketing');
    expect(hit.tier).toBe('areas');
    expect(hit.file).toBe(path.join('marketing', '_index.md'));
    expect(hit.heading).toBe('Marketing');
    expect(hit.snippet).toContain('Quality gates');
  });

  it('excludes denylisted files (.env, node_modules, key/secret names)', async () => {
    const idx = makeIndexer(ws);
    await idx.index({ incremental: false });

    // None of the bait tokens should be searchable.
    expect(await idx.search('envsecrettoken')).toEqual([]);
    expect(await idx.search('junktoken')).toEqual([]);
    expect(await idx.search('secretkeytoken')).toEqual([]);

    const stats = await idx.stats();
    expect(stats.files).toBe(EXPECTED_ALLOWED_FILES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SCOPED SEARCH
// ═══════════════════════════════════════════════════════════════════════════════════

describe('BrainIndexer — scoped search', () => {
  let ws;
  let idx;
  beforeEach(async () => {
    ws = buildWorkspace();
    idx = makeIndexer(ws);
    await idx.index({ incremental: false });
  });
  afterEach(() => cleanup(ws));

  it('scopes by area', async () => {
    // "gates" appears in both marketing and design _index.md.
    const all = await idx.search('gates');
    const areas = new Set(all.map((r) => r.area));
    expect(areas.has('marketing')).toBe(true);
    expect(areas.has('design')).toBe(true);

    const scoped = await idx.search('gates', { area: 'marketing' });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((r) => r.area === 'marketing')).toBe(true);
  });

  it('scopes by tier', async () => {
    const scoped = await idx.search('manual', { tier: 'resources' });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((r) => r.tier === 'resources')).toBe(true);
  });

  it('exposes stats with per-root file counts', async () => {
    const stats = await idx.stats();
    expect(stats.terms).toBeGreaterThan(0);
    expect(stats.lastIndexed).toBeTruthy();
    const rootNames = stats.roots.map((r) => r.name).sort();
    expect(rootNames).toEqual(['areas', 'resources']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INCREMENTAL + DELETION
// ═══════════════════════════════════════════════════════════════════════════════════

describe('BrainIndexer — incremental', () => {
  let ws;
  beforeEach(() => {
    ws = buildWorkspace();
  });
  afterEach(() => cleanup(ws));

  it('skips unchanged files on re-index and is fast (<5s)', async () => {
    const idx = makeIndexer(ws);
    await idx.index({ incremental: false });

    const second = await idx.index({ incremental: true });
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(EXPECTED_ALLOWED_FILES);
    expect(second.filesScanned).toBe(EXPECTED_ALLOWED_FILES);
    expect(second.durationMs).toBeLessThan(5000);
  });

  it('re-indexes only changed files', async () => {
    const idx = makeIndexer(ws);
    await idx.index({ incremental: false });

    // Modify one file with a bumped mtime.
    const target = path.join(ws.areas, 'design', '_index.md');
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(target, '# Design\n\nDesign gates system tokens UPDATEDWORD.\n');
    fs.utimesSync(target, future, future);

    const third = await idx.index({ incremental: true });
    expect(third.filesIndexed).toBe(1);
    expect(third.filesSkipped).toBe(EXPECTED_ALLOWED_FILES - 1);

    const results = await idx.search('updatedword');
    expect(results.length).toBeGreaterThan(0);
  });

  it('removes deleted files from the index', async () => {
    const idx = makeIndexer(ws);
    await idx.index({ incremental: false });
    expect((await idx.search('campanhaunica')).length).toBeGreaterThan(0);

    fs.rmSync(path.join(ws.areas, 'marketing', 'campanhas', 'campanha1.md'));

    const after = await idx.index({ incremental: true });
    expect(after.filesScanned).toBe(EXPECTED_ALLOWED_FILES - 1);
    expect(await idx.search('campanhaunica')).toEqual([]);

    const stats = await idx.stats();
    expect(stats.files).toBe(EXPECTED_ALLOWED_FILES - 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DEGRADED FALLBACK
// ═══════════════════════════════════════════════════════════════════════════════════

describe('BrainIndexer — graceful degradation', () => {
  it('warns (never throws) when a root is missing', async () => {
    const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-brain-missing-'));
    const idx = new BrainIndexer({
      cwd: brainDir,
      brainDir,
      roots: [{ name: 'ghost', path: path.join(brainDir, 'does-not-exist'), tier: 'areas' }],
    });

    const result = await idx.index({ incremental: false });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.filesScanned).toBe(0);
    fs.rmSync(brainDir, { recursive: true, force: true });
  });

  it('falls back to a single projects root for cwd when no roots given', async () => {
    const ws = buildWorkspace();
    const idx = new BrainIndexer({ cwd: ws.areas, brainDir: ws.brainDir });
    const roots = await idx.resolveRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].tier).toBe('projects');
    expect(roots[0].path).toBe(ws.areas);
    cleanup(ws);
  });
});
