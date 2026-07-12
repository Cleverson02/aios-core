/**
 * Tests for the Brain semantic search layer (WSB-1.3).
 *
 * Fixtures are produced by running the REAL BrainIndexer over a throwaway
 * workspace under the OS temp dir (this is USE of the indexer, not modification)
 * so chunks.json / index.json are generated exactly as in production. The
 * brainDir is always isolated (never touches ~/.aiox).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { BrainIndexer } = require('../indexer');
const {
  HashingVectorProvider,
  ApiEmbeddingProvider,
  resolveProvider,
} = require('../semantic/vector-provider');
const { buildVectors, loadVectors } = require('../semantic/semantic-store');
const {
  semanticSearch,
  hybridSearch,
  hybridSearchWithMeta,
} = require('../semantic/hybrid-search');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build a temp workspace with docs crafted to exercise fuzzy (morphological)
 * matching that the term-exact lexical index cannot resolve.
 * @returns {{root: string, areas: string, brainDir: string}}
 */
function buildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-semantic-'));
  const areas = path.join(root, 'areas');
  const brainDir = path.join(root, '.brain-store');

  // areas/plataforma — the fuzzy target. Body uses PLURAL / different radical
  // forms ("gerenciamento", "janelas", "deslizantes") so a query in the
  // singular/infinitive form shares NO exact token but many char n-grams.
  const plataforma = path.join(areas, 'plataforma');
  fs.mkdirSync(plataforma, { recursive: true });
  fs.writeFileSync(
    path.join(plataforma, 'contexto.md'),
    '# Gerenciamento de Janelas\n\n' +
      'Como o sistema faz gerenciamento de janelas deslizantes para os agentes.\n',
  );

  // areas/marketing — an unrelated distractor in a different area.
  const marketing = path.join(areas, 'marketing');
  fs.mkdirSync(marketing, { recursive: true });
  fs.writeFileSync(
    path.join(marketing, 'campanha.md'),
    '# Campanha de Verao\n\nEstrategia de anuncios e promocoes para lojas fisicas.\n',
  );

  return { root, areas, brainDir };
}

/**
 * Build + persist a lexical index over the workspace via the real indexer.
 * @param {{root: string, areas: string, brainDir: string}} ws
 * @returns {Promise<BrainIndexer>}
 */
async function indexWorkspace(ws) {
  const idx = new BrainIndexer({
    cwd: ws.root,
    brainDir: ws.brainDir,
    roots: [{ name: 'areas', path: ws.areas, tier: 'areas' }],
  });
  await idx.index({ incremental: false });
  return idx;
}

/** Recursively remove a workspace. */
function cleanup(ws) {
  fs.rmSync(ws.root, { recursive: true, force: true });
}

/** Snapshot + clear the embedding-related env for opt-in isolation. */
function withCleanEmbeddingEnv(fn) {
  const saved = {
    provider: process.env.AIOX_EMBEDDINGS_PROVIDER,
    openai: process.env.OPENAI_API_KEY,
    voyage: process.env.VOYAGE_API_KEY,
  };
  delete process.env.AIOX_EMBEDDINGS_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  try {
    return fn();
  } finally {
    if (saved.provider !== undefined) process.env.AIOX_EMBEDDINGS_PROVIDER = saved.provider;
    if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
    if (saved.voyage !== undefined) process.env.VOYAGE_API_KEY = saved.voyage;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HASHING PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════════

describe('HashingVectorProvider', () => {
  it('produces deterministic, L2-normalised vectors of the configured dim', async () => {
    const provider = new HashingVectorProvider();
    expect(provider.dim).toBe(512);

    const [a] = await provider.embed(['gerenciamento de janelas de contexto']);
    const [b] = await new HashingVectorProvider().embed(['gerenciamento de janelas de contexto']);

    expect(a).toHaveLength(512);
    expect(a).toEqual(b); // determinism across instances

    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('gives higher cosine to morphological variants than to unrelated text', async () => {
    const provider = new HashingVectorProvider();
    const [q, related, unrelated] = await provider.embed([
      'gerenciar janela de contexto',
      'gerenciamento de janelas deslizantes',
      'estrategia de anuncios e promocoes',
    ]);
    const dot = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
    expect(dot(q, related)).toBeGreaterThan(dot(q, unrelated));
    expect(dot(q, related)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              API PROVIDER OPT-IN (NO NETWORK)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('ApiEmbeddingProvider — opt-in only', () => {
  it('create() returns null and never fetches without env opt-in', async () => {
    await withCleanEmbeddingEnv(async () => {
      const fetchSpy = jest.fn();
      const originalFetch = global.fetch;
      global.fetch = fetchSpy;
      try {
        expect(ApiEmbeddingProvider.create()).toBeNull();

        // resolveProvider must fall through to the hashing default.
        const provider = resolveProvider();
        expect(provider).toBeInstanceOf(HashingVectorProvider);

        // A full build must not hit the network.
        const ws = buildWorkspace();
        await indexWorkspace(ws);
        await buildVectors(ws.brainDir);
        cleanup(ws);

        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  it('create() still returns null when provider is set but the key is missing', () => {
    withCleanEmbeddingEnv(() => {
      process.env.AIOX_EMBEDDINGS_PROVIDER = 'openai';
      // OPENAI_API_KEY intentionally absent.
      expect(ApiEmbeddingProvider.create()).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              VECTOR STORE (BUILD / INCREMENTAL / REMOVAL)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('semantic-store — buildVectors', () => {
  let ws;
  beforeEach(async () => {
    ws = buildWorkspace();
    await indexWorkspace(ws);
  });
  afterEach(() => cleanup(ws));

  it('embeds all chunks and persists a decodable vectors.json', async () => {
    const stats = await buildVectors(ws.brainDir);
    expect(stats.embedded).toBeGreaterThan(0);
    expect(stats.reused).toBe(0);
    expect(fs.existsSync(path.join(ws.brainDir, 'vectors.json'))).toBe(true);

    const loaded = loadVectors(ws.brainDir);
    expect(loaded).not.toBeNull();
    expect(loaded.dim).toBe(512);
    const ids = Object.keys(loaded.vectors);
    expect(ids.length).toBe(stats.embedded);
    expect(loaded.vectors[ids[0]].v).toBeInstanceOf(Float32Array);
    expect(loaded.vectors[ids[0]].v).toHaveLength(512);
  });

  it('re-uses unchanged vectors on the second build (incremental)', async () => {
    const first = await buildVectors(ws.brainDir);
    const second = await buildVectors(ws.brainDir);
    expect(second.embedded).toBe(0);
    expect(second.reused).toBe(first.embedded);
    expect(second.removed).toBe(0);
  });

  it('drops vectors for chunks whose source file was deleted', async () => {
    await buildVectors(ws.brainDir);

    // Delete a source file and re-index → its chunks leave chunks.json.
    fs.rmSync(path.join(ws.areas, 'marketing', 'campanha.md'));
    await indexWorkspace(ws);

    const after = await buildVectors(ws.brainDir);
    expect(after.removed).toBeGreaterThan(0);
    expect(after.reused).toBeGreaterThan(0); // plataforma chunks survive
  });

  it('re-embeds everything when the provider identity changes', async () => {
    const first = await buildVectors(ws.brainDir);
    // A different-dim provider ⇒ different name ⇒ cache invalidated.
    const second = await buildVectors(ws.brainDir, {
      provider: new HashingVectorProvider({ dim: 256 }),
    });
    expect(second.reused).toBe(0);
    expect(second.embedded).toBe(first.embedded);
    expect(loadVectors(ws.brainDir).dim).toBe(256);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SEMANTIC + HYBRID SEARCH
// ═══════════════════════════════════════════════════════════════════════════════════

describe('semanticSearch — fuzzy match beyond the lexical index', () => {
  let ws;
  let idx;
  beforeEach(async () => {
    ws = buildWorkspace();
    idx = await indexWorkspace(ws);
    await buildVectors(ws.brainDir);
  });
  afterEach(() => cleanup(ws));

  it('finds a morphological variant the lexical search misses', async () => {
    const query = 'gerenciar janela deslizante';

    // Lexical: query tokens (gerenciar/janela/deslizante) are NONE of the doc's
    // exact tokens (gerenciamento/janelas/deslizantes) → no lexical hit.
    const lexical = await idx.search(query);
    expect(lexical).toEqual([]);

    // Semantic: char n-grams overlap heavily → the target doc is found.
    const results = await semanticSearch(ws.brainDir, query);
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.matchType).toBe('semantic');
    expect(top.score).toBeGreaterThan(0);
    expect(top.file).toBe(path.join('plataforma', 'contexto.md'));
    expect(top.heading).toBe('Gerenciamento de Janelas');
  });

  it('filters semantic results by area and tier', async () => {
    const byArea = await semanticSearch(ws.brainDir, 'gerenciar janela', {
      area: 'plataforma',
    });
    expect(byArea.length).toBeGreaterThan(0);
    expect(byArea.every((r) => r.area === 'plataforma')).toBe(true);

    const byTier = await semanticSearch(ws.brainDir, 'gerenciar janela', { tier: 'areas' });
    expect(byTier.length).toBeGreaterThan(0);
    expect(byTier.every((r) => r.tier === 'areas')).toBe(true);

    const wrongArea = await semanticSearch(ws.brainDir, 'gerenciar janela', {
      area: 'inexistente',
    });
    expect(wrongArea).toEqual([]);
  });

  it('hybridSearch combines lexical + semantic and tags matchType hybrid', async () => {
    // "sistema" is an exact token in the plataforma doc (lexical anchor) while
    // "janela" only matches semantically — hybrid should surface the doc.
    const results = await hybridSearch(ws.brainDir, 'sistema gerenciar janela');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('hybrid');
    expect(results.some((r) => r.file === path.join('plataforma', 'contexto.md'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              GRACEFUL DEGRADATION (NO VECTORS)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('hybridSearch — fallback when vectors.json is absent', () => {
  let ws;
  beforeEach(async () => {
    ws = buildWorkspace();
    await indexWorkspace(ws);
    // NOTE: buildVectors is intentionally NOT called → no vectors.json.
  });
  afterEach(() => cleanup(ws));

  it('degrades to pure lexical results (matchType lexical)', async () => {
    // Use an exact term so the lexical index yields a hit.
    const meta = await hybridSearchWithMeta(ws.brainDir, 'gerenciamento janelas');
    expect(meta.degraded).toBe(true);
    expect(meta.warnings.length).toBeGreaterThan(0);
    expect(meta.results.length).toBeGreaterThan(0);
    expect(meta.results.every((r) => r.matchType === 'lexical')).toBe(true);

    // Array-shape entry point returns the same results.
    const arr = await hybridSearch(ws.brainDir, 'gerenciamento janelas');
    expect(arr.length).toBe(meta.results.length);
    expect(arr[0].matchType).toBe('lexical');
  });

  it('semanticSearch returns an empty array without vectors.json', async () => {
    expect(await semanticSearch(ws.brainDir, 'gerenciamento janelas')).toEqual([]);
  });
});
