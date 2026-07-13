/**
 * L8 Workspace Knowledge Processor Tests
 *
 * Tests entity/area matching against the prompt, hint emission, graceful
 * degradation (no hot index, no match), defensive bracket gating, the
 * context-tracker integration (which brackets actually run L8), and the
 * <15ms performance contract with a realistic hot index.
 *
 * @story WSB-1.5 - SYNAPSE L8 (Workspace Knowledge)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LayerProcessor = require('../../.aios-core/core/synapse/layers/layer-processor');
const L8WorkspaceKnowledgeProcessor = require('../../.aios-core/core/synapse/layers/l8-workspace-knowledge');
const { buildHotIndex } = require('../../.aios-core/core/brain/hot-index');
const { getActiveLayers } = require('../../.aios-core/core/synapse/context/context-tracker');

jest.setTimeout(30000);

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build a temp workspace + brainDir with a hot index for the given entities.
 * @param {Object} entities - id → entity (WSB-1.4 store shape)
 * @returns {Promise<{root: string, brainDir: string}>}
 */
async function buildFixture(entities) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-l8-'));
  const areas = path.join(root, 'areas');
  const brainDir = path.join(root, '.brain-store');

  const marketing = path.join(areas, 'marketing');
  fs.mkdirSync(marketing, { recursive: true });
  fs.writeFileSync(
    path.join(marketing, '_index.md'),
    '# Marketing\n\nCampanhas e conteúdo. Onde ficam os planos de campanha.\n',
  );

  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(
    path.join(brainDir, 'entities.json'),
    JSON.stringify({ version: 1, entities }, null, 2),
  );

  await buildHotIndex(brainDir, {
    roots: [{ name: 'areas', path: areas, tier: 'areas' }],
    cwd: root,
  });

  return { root, brainDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Build a process() context bound to a brainDir. */
function ctx(prompt, brainDir, extra = {}) {
  return {
    prompt,
    session: {},
    config: { brainDir, synapsePath: '/fake/.synapse', manifest: {} },
    previousLayers: [],
    ...extra,
  };
}

const ACME = {
  'cliente-acme': {
    id: 'cliente-acme',
    name: 'Cliente Acme',
    type: 'client',
    aliases: ['Acme', 'ACME Corp'],
    description: 'Principal cliente da agência.',
    sources: [{ file: 'marketing/_index.md', mentions: 9 }],
    origin: 'manual',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONSTRUCTOR
// ═══════════════════════════════════════════════════════════════════════════════════

describe('L8WorkspaceKnowledgeProcessor — constructor', () => {
  const processor = new L8WorkspaceKnowledgeProcessor();

  test('extends LayerProcessor', () => {
    expect(processor).toBeInstanceOf(LayerProcessor);
  });
  test('name is workspace-knowledge', () => {
    expect(processor.name).toBe('workspace-knowledge');
  });
  test('layer is 8', () => {
    expect(processor.layer).toBe(8);
  });
  test('timeout is 15ms', () => {
    expect(processor.timeout).toBe(15);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MATCHING
// ═══════════════════════════════════════════════════════════════════════════════════

describe('L8WorkspaceKnowledgeProcessor — process()', () => {
  let fixture;
  let processor;

  beforeEach(async () => {
    processor = new L8WorkspaceKnowledgeProcessor();
    fixture = await buildFixture(ACME);
  });
  afterEach(() => cleanup(fixture.root));

  test('emits an entity hint when the prompt mentions an entity name', () => {
    const result = processor.process(ctx('atualiza a campanha do Cliente Acme', fixture.brainDir));

    expect(result).not.toBeNull();
    expect(result.metadata.source).toBe('hot-index');
    expect(result.metadata.layer).toBe(8);
    expect(result.metadata.matched.entities).toBeGreaterThanOrEqual(1);

    const entityRule = result.rules.find((r) => r.startsWith('Entidade: Cliente Acme'));
    expect(entityRule).toBeDefined();
    expect(entityRule).toContain('(client)');
    expect(entityRule).toContain('fonte: marketing/_index.md');
  });

  test('matches an entity by alias', () => {
    const result = processor.process(ctx('preciso do relatório da Acme', fixture.brainDir));
    expect(result).not.toBeNull();
    expect(result.rules.some((r) => r.includes('Cliente Acme'))).toBe(true);
  });

  test('emits an area pointer when the prompt mentions an area name', () => {
    const result = processor.process(ctx('quero rever a área de marketing', fixture.brainDir));

    expect(result).not.toBeNull();
    expect(result.metadata.matched.areas).toBeGreaterThanOrEqual(1);
    const areaRule = result.rules.find((r) => r.startsWith('Área marketing'));
    expect(areaRule).toBeDefined();
    expect(areaRule).toContain('documentos em');
  });

  test('returns null when the prompt matches nothing', () => {
    const result = processor.process(ctx('qual a previsão do tempo amanhã', fixture.brainDir));
    expect(result).toBeNull();
  });

  test('returns null when the prompt is empty', () => {
    const result = processor.process(ctx('', fixture.brainDir));
    expect(result).toBeNull();
  });

  test('caps entity hints at 5 and area hints at 3', async () => {
    const many = {};
    for (let i = 0; i < 8; i++) {
      many[`ent-${i}`] = {
        id: `ent-${i}`,
        name: `Entidade Alpha${i}`,
        type: 'other',
        aliases: [`alpha${i}`],
        description: `desc ${i}`,
        sources: [{ file: `f${i}.md`, mentions: i }],
      };
    }
    const f = await buildFixture(many);
    // Prompt mentions all names.
    const prompt = Array.from({ length: 8 }, (_, i) => `alpha${i}`).join(' ');
    const result = processor.process(ctx(prompt, f.brainDir));
    expect(result).not.toBeNull();
    expect(result.metadata.matched.entities).toBeLessThanOrEqual(5);
    expect(result.rules.filter((r) => r.startsWith('Entidade:')).length).toBeLessThanOrEqual(5);
    cleanup(f.root);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              GRACEFUL DEGRADATION
// ═══════════════════════════════════════════════════════════════════════════════════

describe('L8WorkspaceKnowledgeProcessor — graceful degradation', () => {
  const processor = new L8WorkspaceKnowledgeProcessor();

  test('returns null when there is no hot-index.json', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-l8-empty-'));
    const result = processor.process(ctx('atualiza a campanha do Cliente Acme', emptyDir));
    expect(result).toBeNull();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  test('never throws via _safeProcess and returns null on missing prompt', () => {
    const result = processor._safeProcess({ config: {} });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BRACKET / BUDGET INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════════

describe('L8WorkspaceKnowledgeProcessor — bracket integration', () => {
  test('context-tracker activates L8 only in loose brackets (FRESH/MODERATE)', () => {
    expect(getActiveLayers('FRESH').layers).toContain(8);
    expect(getActiveLayers('MODERATE').layers).toContain(8);
    expect(getActiveLayers('DEPLETED').layers).not.toContain(8);
    expect(getActiveLayers('CRITICAL').layers).not.toContain(8);
  });

  test('defensive gate: returns null if a tight bracket is passed in context', async () => {
    const processor = new L8WorkspaceKnowledgeProcessor();
    const fixture = await buildFixture(ACME);

    const tight = processor.process(
      ctx('atualiza a campanha do Cliente Acme', fixture.brainDir, { bracket: 'CRITICAL' }),
    );
    expect(tight).toBeNull();

    // Same prompt with a loose bracket still emits.
    const loose = processor.process(
      ctx('atualiza a campanha do Cliente Acme', fixture.brainDir, { bracket: 'FRESH' }),
    );
    expect(loose).not.toBeNull();

    cleanup(fixture.root);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PERFORMANCE (<15ms)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('L8WorkspaceKnowledgeProcessor — performance', () => {
  test('full process() (load + match + emit) runs < 15ms with ~100 entities', async () => {
    const entities = {};
    for (let i = 0; i < 100; i++) {
      entities[`ent-${i}`] = {
        id: `ent-${i}`,
        name: `Entidade Numero ${i}`,
        type: 'other',
        aliases: [`alias${i}`],
        description: `Descrição curta da entidade ${i}.`,
        sources: [{ file: `docs/file-${i}.md`, mentions: i }],
      };
    }
    // Ensure at least one match.
    entities['cliente-acme'] = ACME['cliente-acme'];

    const fixture = await buildFixture(entities);
    const processor = new L8WorkspaceKnowledgeProcessor();
    const context = ctx('atualiza a campanha do Cliente Acme', fixture.brainDir);

    // Warm require caches, then measure a fresh call.
    processor.process(context);

    const start = process.hrtime.bigint();
    const result = processor.process(context);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;

    expect(result).not.toBeNull();
    expect(ms).toBeLessThan(15);

    cleanup(fixture.root);
  });
});
