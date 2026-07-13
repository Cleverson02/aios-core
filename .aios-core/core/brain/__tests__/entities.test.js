/**
 * Tests for the Brain Entity Graph (WSB-1.4).
 *
 * Uses a throwaway PARA-style workspace under the OS temp dir. The real
 * BrainIndexer generates chunks.json from the fixture, then the graph builder
 * runs over that same isolated brainDir (never touches ~/.aiox).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { BrainIndexer } = require('../indexer');
const { EntityStore, slugify } = require('../entities/entity-store');
const { extractEntities } = require('../entities/entity-extractor');
const { buildGraph } = require('../entities/entity-graph');
const { getEntity, listEntities, related, whereIs } = require('../entities/query');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURE
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build a PARA workspace with a marketing area + a produto-x project.
 * @returns {{root: string, brainDir: string, roots: Array<Object>}}
 */
function buildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-entities-'));
  const brainDir = path.join(root, '.brain-store');

  // 01-projects/produto-x — front-matter entity (b) + mentions.
  const produtoX = path.join(root, '01-projects', 'produto-x');
  fs.mkdirSync(produtoX, { recursive: true });
  fs.writeFileSync(
    path.join(produtoX, 'README.md'),
    [
      '---',
      'entities:',
      '  - name: Plataforma X',
      '    type: product',
      '    aliases: [PX]',
      '    description: nosso produto principal',
      '---',
      '# Produto X',
      '',
      'Roadmap da Plataforma X. Precisamos alinhar com o Cliente Acme sobre integração.',
      'A Acme aprovou. Acmeville é outra empresa (não conta).',
      '',
    ].join('\n'),
  );

  // 02-areas/marketing — _index.md with `## Entidades` (c).
  const marketing = path.join(root, '02-areas', 'marketing');
  fs.mkdirSync(path.join(marketing, 'clientes'), { recursive: true });
  fs.writeFileSync(
    path.join(marketing, '_index.md'),
    [
      '# Marketing',
      '',
      'Porta de entrada da área de marketing.',
      '',
      '## Entidades',
      '',
      '- Cliente Acme (client): maior conta do trimestre',
      '- Ana Diretora (person): lidera o time de marketing',
      '',
    ].join('\n'),
  );

  // A marketing doc with front-matter aliasing Cliente Acme → Acme, co-mentioning
  // Plataforma X (drives mentioned-with).
  fs.writeFileSync(
    path.join(marketing, 'clientes', 'acme-brief.md'),
    [
      '---',
      'entities:',
      '  - name: Cliente Acme',
      '    type: client',
      '    aliases: [Acme]',
      '    description: conta estratégica',
      '---',
      '# Brief Acme',
      '',
      'O Cliente Acme pediu uma campanha nova. Acme quer foco em Plataforma X.',
      '',
    ].join('\n'),
  );

  const roots = [
    { name: 'produto-x', path: produtoX, tier: 'projects' },
    { name: 'marketing', path: marketing, tier: 'areas' },
  ];

  return { root, brainDir, roots };
}

/** Index the fixture (writes chunks.json into brainDir). */
async function indexWorkspace(ws) {
  const idx = new BrainIndexer({ cwd: ws.root, brainDir: ws.brainDir, roots: ws.roots });
  await idx.index({ incremental: false });
}

/** Recursively remove a workspace. */
function cleanup(ws) {
  fs.rmSync(ws.root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXTRACTION (a)(b)(c)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('entity-extractor — three sources', () => {
  it('(a) extracts structural entities from roots (area + project)', () => {
    const roots = [
      { name: 'marketing', tier: 'areas' },
      { name: 'produto-x', tier: 'projects' },
    ];
    const candidates = extractEntities({ roots, chunks: [] });
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    expect(byName.marketing.type).toBe('area');
    expect(byName['produto-x'].type).toBe('project');
    expect(byName.marketing.structural).toBe(true);
  });

  it('(b) extracts entities from YAML front-matter (string + object forms)', () => {
    const chunks = [
      {
        file: 'doc.md',
        root: 'marketing',
        tier: 'areas',
        heading: null,
        text: '---\nentities:\n  - Marca Zeta\n  - name: Cliente Acme\n    type: client\n    aliases: [Acme]\n---\n\ncorpo',
      },
    ];
    const candidates = extractEntities({ roots: [], chunks });
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    expect(byName['Marca Zeta']).toBeTruthy();
    expect(byName['Cliente Acme'].type).toBe('client');
    expect(byName['Cliente Acme'].aliases).toContain('Acme');
    expect(byName['Cliente Acme'].originTier).toBe('areas');
  });

  it('(c) extracts entities from a `## Entidades` section of _index.md', () => {
    const chunks = [
      {
        file: path.join('marketing', '_index.md'),
        root: 'marketing',
        tier: 'areas',
        heading: 'Entidades',
        text: 'Entidades\n- Cliente Acme (client): maior conta\n- Ana Diretora (person): lidera',
      },
    ];
    const candidates = extractEntities({ roots: [], chunks });
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    expect(byName['Cliente Acme'].type).toBe('client');
    expect(byName['Cliente Acme'].description).toBe('maior conta');
    expect(byName['Ana Diretora'].type).toBe('person');
  });

  it('ignores a `## Entidades` bullet in a non _index.md file', () => {
    const chunks = [
      {
        file: 'random.md',
        root: 'marketing',
        tier: 'areas',
        heading: 'Entidades',
        text: 'Entidades\n- Cliente Acme (client): maior conta',
      },
    ];
    expect(extractEntities({ roots: [], chunks })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BUILD GRAPH (integration)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('buildGraph — integration over indexed chunks', () => {
  let ws;
  beforeEach(async () => {
    ws = buildWorkspace();
    await indexWorkspace(ws);
  });
  afterEach(() => cleanup(ws));

  it('builds all entities from the three sources with correct types', async () => {
    await buildGraph(ws.brainDir, { roots: ws.roots });
    const byName = Object.fromEntries(listEntities(ws.brainDir).map((e) => [e.name, e]));

    expect(byName.marketing.type).toBe('area'); // (a)
    expect(byName['produto-x'].type).toBe('project'); // (a)
    expect(byName['Plataforma X'].type).toBe('product'); // (b)
    expect(byName['Plataforma X'].aliases).toContain('PX'); // (b)
    expect(byName['Cliente Acme'].type).toBe('client'); // (b)+(c)
    expect(byName['Ana Diretora'].type).toBe('person'); // (c)
  });

  it('scans mentions with word boundaries (no "Acmeville" false positive)', async () => {
    await buildGraph(ws.brainDir, { roots: ws.roots });
    const acme = getEntity(ws.brainDir, 'Cliente Acme');

    const readme = acme.sources.find((s) => s.file === 'README.md');
    // "Cliente Acme" + "A Acme" = 2, and "Acmeville" must NOT be counted.
    expect(readme).toBeTruthy();
    expect(readme.mentions).toBe(2);
  });

  it('derives belongs-to (entity → area of origin)', async () => {
    await buildGraph(ws.brainDir, { roots: ws.roots });
    const acme = getEntity(ws.brainDir, 'Cliente Acme');
    const belongs = acme.relations.filter((r) => r.type === 'belongs-to');
    expect(belongs.some((r) => r.target === 'marketing')).toBe(true);

    // Plataforma X lives in a projects root — no belongs-to.
    const plataforma = getEntity(ws.brainDir, 'Plataforma X');
    expect(plataforma.relations.some((r) => r.type === 'belongs-to')).toBe(false);
  });

  it('derives mentioned-with (co-occurrence in the same file)', async () => {
    await buildGraph(ws.brainDir, { roots: ws.roots });
    const acme = getEntity(ws.brainDir, 'Cliente Acme');
    expect(acme.relations.some((r) => r.type === 'mentioned-with' && r.target === 'plataforma-x')).toBe(true);

    // Reciprocal edge is written too.
    const plataforma = getEntity(ws.brainDir, 'Plataforma X');
    expect(plataforma.relations.some((r) => r.type === 'mentioned-with' && r.target === 'cliente-acme')).toBe(true);
  });

  it('returns build stats', async () => {
    const result = await buildGraph(ws.brainDir, { roots: ws.roots });
    expect(result.entities.length).toBeGreaterThanOrEqual(5);
    expect(result.mentionsScanned).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MERGE: MANUAL + AUTO (AC5)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('buildGraph — manual/auto merge', () => {
  let ws;
  beforeEach(async () => {
    ws = buildWorkspace();
    await indexWorkspace(ws);
  });
  afterEach(() => cleanup(ws));

  it('preserves manual identity while refreshing auto sources on re-scan', async () => {
    await buildGraph(ws.brainDir, { roots: ws.roots });

    // Human curates the entity: edits the description, adds an alias, marks manual.
    const store = new EntityStore({ brainDir: ws.brainDir }).load();
    store.upsert(
      {
        name: 'Cliente Acme',
        type: 'client',
        aliases: ['Acme', 'Acme Corp'],
        description: 'CONTA VIP editada manualmente',
        origin: 'manual',
      },
      { preserveManual: false },
    );
    store.save();

    // Re-scan must not clobber the manual identity fields.
    await buildGraph(ws.brainDir, { roots: ws.roots });
    const acme = getEntity(ws.brainDir, 'Cliente Acme');

    expect(acme.origin).toBe('manual');
    expect(acme.description).toBe('CONTA VIP editada manualmente');
    expect(acme.aliases).toContain('Acme Corp');
    // Auto still refreshed the sources.
    expect(acme.sources.length).toBeGreaterThan(0);
    expect(acme.sources.some((s) => s.file === 'README.md')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              QUERIES
// ═══════════════════════════════════════════════════════════════════════════════════

describe('query — related / whereIs', () => {
  let ws;
  beforeEach(async () => {
    ws = buildWorkspace();
    await indexWorkspace(ws);
    await buildGraph(ws.brainDir, { roots: ws.roots });
  });
  afterEach(() => cleanup(ws));

  it('related() traverses relations (depth 1) in both directions', () => {
    // marketing is only ever a *target* of belongs-to — bidirectional BFS finds
    // the entities that belong to it.
    const neighbours = related(ws.brainDir, 'marketing', { depth: 1 });
    const names = neighbours.map((n) => n.name);
    expect(names).toContain('Cliente Acme');
    expect(neighbours.every((n) => n.depth === 1)).toBe(true);
    expect(neighbours.find((n) => n.name === 'Cliente Acme').relation).toBe('belongs-to');
  });

  it('related() reaches co-mentioned entities', () => {
    const neighbours = related(ws.brainDir, 'Cliente Acme', { depth: 1 });
    expect(neighbours.map((n) => n.name)).toContain('Plataforma X');
  });

  it('whereIs() returns sources ordered by mention count desc', () => {
    const sources = whereIs(ws.brainDir, 'Cliente Acme');
    expect(sources.length).toBeGreaterThan(0);
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i - 1].mentions).toBeGreaterThanOrEqual(sources[i].mentions);
    }
  });

  it('getEntity() resolves by alias (case-insensitive)', () => {
    const byAlias = getEntity(ws.brainDir, 'px');
    expect(byAlias).toBeTruthy();
    expect(byAlias.id).toBe(slugify('Plataforma X'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DEGRADATION (AC7)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('buildGraph — graceful degradation without chunks', () => {
  it('builds a structural-only graph when chunks.json is absent', async () => {
    const ws = buildWorkspace();
    // No indexing → no chunks.json in brainDir.
    const result = await buildGraph(ws.brainDir, { roots: ws.roots });

    const names = result.entities.map((e) => e.name).sort();
    expect(names).toEqual(['marketing', 'produto-x']);
    expect(result.entities.every((e) => e.sources.length === 0)).toBe(true);
    expect(result.entities.every((e) => e.relations.length === 0)).toBe(true);
    expect(result.mentionsScanned).toBe(0);
    cleanup(ws);
  });
});
