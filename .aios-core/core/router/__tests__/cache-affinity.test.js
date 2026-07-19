/**
 * Tests for cache-aware routing (Story WSB-4.6).
 *
 * Every numeric case below is verifiable BY HAND from the pricing blocks in
 * `capability-matrix.yaml` (USD per MILLION tokens):
 *
 *   claude-opus-4-8 : input 15   cached 1.5  output 75  write 18.75
 *   grok-4-5        : input  2   cached 0.5  output  6  write  2.50
 *   gpt-5.5-codex   : input  5   cached 0.5  output 20  write  5.00
 *   gemini-2.x      : input  1   cached 0.25 output  4  write  1.00
 *
 * Cost model (÷1e6):
 *   stayCost   = cached×inc.cached + newIn×inc.input + out×inc.output
 *   switchCost = (cached+newIn)×cand.input + cand.write×(cached+newIn) + out×cand.output
 */

const { switchCost } = require('../cache-affinity');
const { LlmRouter } = require('../router');
const { loadMatrix, clearCache } = require('../matrix-loader');

beforeEach(() => {
  clearCache();
});

/** Minimal priced matrix for synthetic, fully-hand-computed cases. */
function pricedMatrix(models) {
  return { models };
}

// ─────────────────────────────────────────────────────────────────────────────
// switchCost — documented, hand-verifiable numeric cases (real matrix)
// ─────────────────────────────────────────────────────────────────────────────

describe('switchCost — hand-verified numbers (opus → grok, real matrix)', () => {
  const matrix = loadMatrix({});

  test('cached=100k, new=10k, out=5k → stay $0.6750 vs switch $0.5250 → switch', () => {
    // stay   = 100000×1.5 + 10000×15 + 5000×75  = 150000 + 150000 + 375000 = 675000/1e6 = 0.675
    // switch = 110000×2 + 2.5×110000 + 5000×6    = 220000 + 275000 + 30000  = 525000/1e6 = 0.525
    const sc = switchCost({
      incumbentModel: 'claude-opus-4-8',
      candidateModel: 'grok-4-5',
      cachedContextTokens: 100000,
      expectedNewInputTokens: 10000,
      expectedOutputTokens: 5000,
      matrix,
    });
    expect(sc.stayCost).toBeCloseTo(0.675, 10);
    expect(sc.switchCost).toBeCloseTo(0.525, 10);
    expect(sc.saving).toBeCloseTo(0.15, 10);
    // switch 0.525 < stay×0.9 = 0.6075 → switch
    expect(sc.recommendation).toBe('switch');
    // grok is so much cheaper it already wins at 0 new tokens → break-even clamps to 0.
    expect(sc.breakEvenTokens).toBe(0);
    expect(sc.explanation).toMatch(/\$0\.6750/);
    expect(sc.explanation).toMatch(/\$0\.5250/);
  });

  test('cached=100k, new=0, out=0 → stay $0.1500 vs switch $0.4500 → stay (cache protected)', () => {
    // stay   = 100000×1.5                       = 150000/1e6 = 0.15
    // switch = 100000×2 + 2.5×100000            = 200000 + 250000 = 450000/1e6 = 0.45
    const sc = switchCost({
      incumbentModel: 'claude-opus-4-8',
      candidateModel: 'grok-4-5',
      cachedContextTokens: 100000,
      matrix,
    });
    expect(sc.stayCost).toBeCloseTo(0.15, 10);
    expect(sc.switchCost).toBeCloseTo(0.45, 10);
    expect(sc.saving).toBeCloseTo(-0.3, 10);
    expect(sc.recommendation).toBe('stay');
    // denom = 15 − 2 − 2.5 = 10.5 ; numerator = 100000×(2+2.5−1.5) = 300000 ; ceil(300000/10.5) = 28572
    expect(sc.breakEvenTokens).toBe(28572);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// switchCost — margin boundary (synthetic matrix so ratio is exactly 0.9)
// ─────────────────────────────────────────────────────────────────────────────

describe('switchCost — margin boundary', () => {
  // inc.input 10 ; cand.input 8 + cand.write 1 = 9 ⇒ switch/stay = 9/10 = 0.9 exactly.
  const matrix = pricedMatrix({
    inc: { pricing: { input_per_mtok: 10, cached_input_per_mtok: 1, output_per_mtok: 10, cache_write_per_mtok: 10 } },
    cand: { pricing: { input_per_mtok: 8, cached_input_per_mtok: 1, output_per_mtok: 10, cache_write_per_mtok: 1 } },
  });
  const base = { incumbentModel: 'inc', candidateModel: 'cand', cachedContextTokens: 0, expectedNewInputTokens: 100000, expectedOutputTokens: 0, matrix };

  test('stay=$1.0000, switch=$0.9000', () => {
    const sc = switchCost(base);
    expect(sc.stayCost).toBeCloseTo(1.0, 10);
    expect(sc.switchCost).toBeCloseTo(0.9, 10);
  });

  test('margin 10% at the boundary → stay (switch not strictly < stay×0.9)', () => {
    expect(switchCost({ ...base, marginPct: 10 }).recommendation).toBe('stay');
  });

  test('margin 5% → switch (0.9 < stay×0.95)', () => {
    expect(switchCost({ ...base, marginPct: 5 }).recommendation).toBe('switch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// switchCost — break-even derivation (synthetic, exact crossover)
// ─────────────────────────────────────────────────────────────────────────────

describe('switchCost — break-even', () => {
  // inc.input 10 cached 1 ; cand.input 5 write 1 ; cached=10000, out=0.
  // denom = 10 − 5 − 1 = 4 ; numerator = 10000×(5+1−1) = 50000 ; N* = 50000/4 = 12500.
  const matrix = pricedMatrix({
    inc: { pricing: { input_per_mtok: 10, cached_input_per_mtok: 1, output_per_mtok: 5, cache_write_per_mtok: 0 } },
    cand: { pricing: { input_per_mtok: 5, cached_input_per_mtok: 1, output_per_mtok: 5, cache_write_per_mtok: 1 } },
  });

  test('break-even is exactly 12500 new tokens', () => {
    const sc = switchCost({ incumbentModel: 'inc', candidateModel: 'cand', cachedContextTokens: 10000, matrix });
    expect(sc.breakEvenTokens).toBe(12500);
  });

  test('at N=12500 stay and switch costs are equal', () => {
    const sc = switchCost({ incumbentModel: 'inc', candidateModel: 'cand', cachedContextTokens: 10000, expectedNewInputTokens: 12500, matrix });
    // stay   = 10000×1 + 12500×10 = 135000/1e6 = 0.135
    // switch = 22500×5 + 1×22500  = 135000/1e6 = 0.135
    expect(sc.stayCost).toBeCloseTo(0.135, 10);
    expect(sc.switchCost).toBeCloseTo(0.135, 10);
  });

  test('candidate pricier per input token → break-even Infinity (never catches up)', () => {
    const real = loadMatrix({});
    const sc = switchCost({ incumbentModel: 'grok-4-5', candidateModel: 'claude-opus-4-8', cachedContextTokens: 1000, expectedNewInputTokens: 5000, matrix: real });
    expect(sc.breakEvenTokens).toBe(Infinity);
    expect(sc.recommendation).toBe('stay');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// switchCost — neutral when pricing is missing (AC5)
// ─────────────────────────────────────────────────────────────────────────────

describe('switchCost — neutral without pricing (AC5)', () => {
  const matrix = pricedMatrix({
    priced: { pricing: { input_per_mtok: 10, cached_input_per_mtok: 1, output_per_mtok: 10, cache_write_per_mtok: 1 } },
    unpriced: {},
  });

  test('missing candidate pricing → neutral, never blocks', () => {
    const sc = switchCost({ incumbentModel: 'priced', candidateModel: 'unpriced', cachedContextTokens: 5000, matrix });
    expect(sc.recommendation).toBe('neutral');
    expect(sc.reason).toMatch(/sem pricing/i);
    expect(sc.stayCost).toBeUndefined();
  });

  test('missing incumbent pricing → neutral', () => {
    const sc = switchCost({ incumbentModel: 'unpriced', candidateModel: 'priced', cachedContextTokens: 5000, matrix });
    expect(sc.recommendation).toBe('neutral');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LlmRouter.route — incumbent-aware (AC2)
// ─────────────────────────────────────────────────────────────────────────────

describe('LlmRouter.route — cache affinity', () => {
  test('without incumbent behavior is unchanged (no cacheAffinity field)', () => {
    const router = new LlmRouter({});
    const d = router.route('escrever testes unitários do serviço');
    expect(d.model).toBe('grok-4-5');
    expect(d.cacheAffinity).toBeUndefined();
  });

  test('incumbent opus + big cache + no new tokens → STAY on opus', () => {
    const router = new LlmRouter({});
    // naive pick for test-generation is grok-4-5; but 100k cached makes staying cheaper.
    const d = router.route('escrever testes unitários', {
      incumbent: 'claude-opus-4-8',
      cachedContextTokens: 100000,
    });
    expect(d.model).toBe('claude-opus-4-8');
    expect(d.cacheAffinity.recommendation).toBe('stay');
    expect(d.reason).toMatch(/afinidade de cache/i);
    expect(d.reason).toMatch(/\$0\.1500/);
    expect(d.reason).toMatch(/\$0\.4500/);
  });

  test('incumbent opus + many NEW tokens, empty cache → SWITCH to grok', () => {
    const router = new LlmRouter({});
    const d = router.route('escrever testes unitários', {
      incumbent: 'claude-opus-4-8',
      cachedContextTokens: 0,
      expectedNewInputTokens: 100000,
    });
    expect(d.model).toBe('grok-4-5');
    expect(d.cacheAffinity.recommendation).toBe('switch');
    expect(d.reason).toMatch(/Cache-affinity confirma a troca/);
  });

  test('incumbent already equals the naive pick → base decision, no rewrite', () => {
    const router = new LlmRouter({});
    const d = router.route('escrever testes unitários', { incumbent: 'grok-4-5', cachedContextTokens: 100000 });
    expect(d.model).toBe('grok-4-5');
    expect(d.cacheAffinity).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LlmRouter.routeChain — anchor + quality-override exception (AC3)
// ─────────────────────────────────────────────────────────────────────────────

describe('LlmRouter.routeChain', () => {
  test('anchors on the dominant category and forces the strong model mid-chain', () => {
    const router = new LlmRouter({});
    const chain = router.routeChain([
      { description: 'escrever testes unitários' },
      { description: 'decidir a arquitetura do módulo de billing' },
      { description: 'adicionar cobertura de testes' },
      { description: 'criar testes de integração' },
    ]);

    // Dominant category is test-generation (×3) → anchor grok-4-5.
    expect(chain.anchor).toBe('grok-4-5');
    expect(chain.steps).toHaveLength(4);

    const arch = chain.steps[1];
    expect(arch.category).toBe('architecture-decision');
    expect(arch.model).toBe('claude-opus-4-8');
    expect(arch.qualityOverride).toBe(true);
    expect(arch.switched).toBe(true);

    // Test-generation steps stay on the anchor.
    for (const i of [0, 2, 3]) {
      expect(chain.steps[i].category).toBe('test-generation');
      expect(chain.steps[i].model).toBe('grok-4-5');
      expect(chain.steps[i].switched).toBe(false);
      expect(chain.steps[i].qualityOverride).toBe(false);
    }

    expect(chain.totalEstimatedCost).toBeGreaterThan(0);
  });

  test('empty chain returns a null anchor and no steps', () => {
    const router = new LlmRouter({});
    expect(router.routeChain([])).toEqual({ anchor: null, steps: [], totalEstimatedCost: 0 });
  });

  test('tie on category count breaks toward the higher cost_tier model', () => {
    const router = new LlmRouter({});
    // 1 architecture-decision (opus/high) vs 1 test-generation (grok/low) → tie, high wins.
    const chain = router.routeChain([
      { description: 'decidir a arquitetura do gateway' },
      { description: 'escrever testes unitários' },
    ]);
    expect(chain.anchor).toBe('claude-opus-4-8');
  });
});
