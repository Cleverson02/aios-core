/**
 * Tests for the Brain Hot Index (compact SYNAPSE-loadable snapshot).
 *
 * Story: WSB-1.5 - SYNAPSE L8 (Workspace Knowledge)
 *
 * Uses throwaway workspaces under the OS temp dir with an isolated brainDir
 * (never touches ~/.aiox).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildHotIndex,
  loadHotIndex,
  defaultBrainDir,
  HOT_INDEX_FILE,
  MAX_HOT_INDEX_BYTES,
} = require('../hot-index');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build a temp workspace with a couple of areas (each with _index.md) plus an
 * isolated brainDir. Returns paths + the explicit roots array.
 */
function buildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-hot-'));
  const areas = path.join(root, 'areas');
  const brainDir = path.join(root, '.brain-store');

  const marketing = path.join(areas, 'marketing');
  fs.mkdirSync(path.join(marketing, 'campanhas'), { recursive: true });
  fs.writeFileSync(
    path.join(marketing, '_index.md'),
    '# Marketing\n\nÁrea de campanhas e conteúdo do Cliente Acme.\nOrquestração de campanhas.\n',
  );

  const design = path.join(areas, 'design');
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(path.join(design, '_index.md'), '# Design\n\nDesign system e tokens.\n');

  return {
    root,
    areas,
    brainDir,
    roots: [{ name: 'areas', path: areas, tier: 'areas' }],
  };
}

/**
 * Write an entities.json into the brainDir in the WSB-1.4 store format.
 * @param {string} brainDir
 * @param {Object} entities - id → entity
 */
function writeEntities(brainDir, entities) {
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(
    path.join(brainDir, 'entities.json'),
    JSON.stringify({ version: 1, entities }, null, 2),
  );
}

function cleanup(ws) {
  fs.rmSync(ws.root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BUILD
// ═══════════════════════════════════════════════════════════════════════════════════

describe('buildHotIndex', () => {
  let ws;
  beforeEach(() => {
    ws = buildWorkspace();
  });
  afterEach(() => cleanup(ws));

  it('builds a compact hot-index.json from entities + area _index.md files', async () => {
    writeEntities(ws.brainDir, {
      'cliente-acme': {
        id: 'cliente-acme',
        name: 'Cliente Acme',
        type: 'client',
        aliases: ['Acme', 'ACME Corp'],
        description: 'Principal cliente da agência, contrato anual de marketing.',
        sources: [{ file: 'marketing/_index.md', mentions: 12 }],
        origin: 'manual',
      },
    });

    const result = await buildHotIndex(ws.brainDir, { roots: ws.roots, cwd: ws.root });

    expect(result.entities).toBe(1);
    expect(result.areas).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.trimmed).toBe(false);
    expect(typeof result.durationMs).toBe('number');

    const hot = loadHotIndex(ws.brainDir);
    expect(hot).not.toBeNull();
    expect(hot.version).toBe(1);
    expect(hot.workspace.name).toBe(path.basename(ws.root));

    // Entity projection
    const entity = hot.entities.find((e) => e.id === 'cliente-acme');
    expect(entity).toBeDefined();
    expect(entity.name).toBe('Cliente Acme');
    expect(entity.type).toBe('client');
    expect(entity.aliases).toEqual(expect.arrayContaining(['Acme', 'ACME Corp']));
    expect(entity.topSource).toBe('marketing/_index.md');
    // Private ranking hint must not leak into the persisted payload.
    expect(entity._mentions).toBeUndefined();

    // Area indexes with summaries
    const marketingArea = hot.areaIndexes.find((a) => a.area === 'marketing');
    expect(marketingArea).toBeDefined();
    expect(marketingArea.summary).toContain('Cliente Acme');
    const designArea = hot.areaIndexes.find((a) => a.area === 'design');
    expect(designArea).toBeDefined();
  });

  it('truncates entity descriptions to 200 chars', async () => {
    const longDesc = 'x'.repeat(500);
    writeEntities(ws.brainDir, {
      big: { id: 'big', name: 'Big Entity', type: 'other', description: longDesc, sources: [] },
    });

    await buildHotIndex(ws.brainDir, { roots: ws.roots, cwd: ws.root });
    const hot = loadHotIndex(ws.brainDir);
    const entity = hot.entities.find((e) => e.id === 'big');
    // 200 chars + ellipsis
    expect(entity.description.length).toBeLessThanOrEqual(201);
    expect(entity.description.endsWith('…')).toBe(true);
  });

  it('is structurally valid when entities.json is absent', async () => {
    const result = await buildHotIndex(ws.brainDir, { roots: ws.roots, cwd: ws.root });

    expect(result.entities).toBe(0);
    expect(result.areas).toBe(2);

    const hot = loadHotIndex(ws.brainDir);
    expect(hot).not.toBeNull();
    expect(Array.isArray(hot.entities)).toBe(true);
    expect(hot.entities).toHaveLength(0);
    expect(hot.areaIndexes.length).toBe(2);
    expect(hot.roots).toEqual([
      { name: 'areas', tier: 'areas', path: ws.areas },
    ]);
  });

  it('enforces the 200KB cap and flags trimmed:true (drops descriptions/summaries/entities)', async () => {
    // Inflate: 3000 entities, each with a long description → well over 200KB raw.
    const entities = {};
    for (let i = 0; i < 3000; i++) {
      entities[`entity-${i}`] = {
        id: `entity-${i}`,
        name: `Entity Number ${i}`,
        type: 'other',
        aliases: [`alias-${i}-a`, `alias-${i}-b`],
        description: 'A fairly long description that repeats to inflate the payload. '.repeat(6),
        sources: [{ file: `docs/file-${i}.md`, mentions: i }],
      };
    }
    writeEntities(ws.brainDir, entities);

    const result = await buildHotIndex(ws.brainDir, { roots: ws.roots, cwd: ws.root });

    expect(result.trimmed).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(MAX_HOT_INDEX_BYTES);

    const hot = loadHotIndex(ws.brainDir);
    expect(hot.trimmed).toBe(true);
    // Descriptions were dropped first.
    expect(hot.entities.every((e) => e.description === '')).toBe(true);
    // The serialised payload fits.
    expect(Buffer.byteLength(JSON.stringify(hot))).toBeLessThanOrEqual(MAX_HOT_INDEX_BYTES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              LOAD
// ═══════════════════════════════════════════════════════════════════════════════════

describe('loadHotIndex', () => {
  let ws;
  beforeEach(() => {
    ws = buildWorkspace();
  });
  afterEach(() => cleanup(ws));

  it('returns null when hot-index.json is absent', () => {
    expect(loadHotIndex(ws.brainDir)).toBeNull();
  });

  it('returns null on a corrupt hot-index.json', () => {
    fs.mkdirSync(ws.brainDir, { recursive: true });
    fs.writeFileSync(path.join(ws.brainDir, HOT_INDEX_FILE), '{ not valid json');
    expect(loadHotIndex(ws.brainDir)).toBeNull();
  });

  it('loads a persisted hot index quickly (<10ms)', async () => {
    writeEntities(ws.brainDir, {
      acme: { id: 'acme', name: 'Acme', type: 'client', sources: [{ file: 'a.md', mentions: 3 }] },
    });
    await buildHotIndex(ws.brainDir, { roots: ws.roots, cwd: ws.root });

    const start = process.hrtime.bigint();
    const hot = loadHotIndex(ws.brainDir);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;

    expect(hot).not.toBeNull();
    expect(ms).toBeLessThan(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BRAINDIR HASH PARITY
// ═══════════════════════════════════════════════════════════════════════════════════

describe('defaultBrainDir', () => {
  it('mirrors the indexer hash (short sha256 under ~/.aiox/brain/<hash>)', () => {
    const { BrainIndexer } = require('../indexer');
    const somePath = path.join(os.tmpdir(), 'some', 'workspace');
    expect(defaultBrainDir(somePath)).toBe(BrainIndexer.defaultBrainDir(somePath));
  });
});
