/**
 * Tests for the LLM Router (Story WSB-2.1 + WSB-2.3).
 *
 * Uses temporary dirs under os.tmpdir() for project-override / schema tests, and
 * injected in-memory matrix fixtures for deterministic policy-selection tests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { loadMatrix, clearCache } = require('../matrix-loader');
const { LlmRouter } = require('../router');
const { routeCommand } = require('../cli');

/** Create an isolated temp dir. */
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
}

/** Write a project override at <dir>/.aios/capability-matrix.yaml. */
function writeProjectOverride(dir, obj) {
  const aiosDir = path.join(dir, '.aios');
  fs.mkdirSync(aiosDir, { recursive: true });
  fs.writeFileSync(path.join(aiosDir, 'capability-matrix.yaml'), yaml.dump(obj), 'utf8');
}

/**
 * A self-contained matrix fixture engineered so each policy picks a DIFFERENT
 * model on the `test-generation` category (desired = [test-generation, coding-speed]):
 *   - qual  → 2 matches, high cost, slow speed  → wins quality-first
 *   - cheap → 1 match,   low cost,  medium speed → wins cost-first
 *   - swift → 1 match,   high cost, fast speed   → wins speed-first
 */
function policyFixture() {
  return {
    version: 1,
    models: {
      qual: { provider: 'pq', strengths: ['test-generation', 'coding-speed'], cost_tier: 'high', speed_tier: 'slow' },
      cheap: { provider: 'pc', strengths: ['test-generation'], cost_tier: 'low', speed_tier: 'medium' },
      swift: { provider: 'ps', strengths: ['test-generation'], cost_tier: 'high', speed_tier: 'fast' },
    },
    routing_policies: {
      'quality-first': { description: 'q' },
      'cost-first': { description: 'c' },
      'speed-first': { description: 's' },
    },
    default_policy: 'cost-first',
    task_routing: {
      'test-generation': 'policy:cost-first',
      default: 'policy:default',
    },
  };
}

beforeEach(() => {
  clearCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// matrix-loader: schema + semantic validation
// ─────────────────────────────────────────────────────────────────────────────

describe('matrix-loader — validation', () => {
  test('the real repo matrix loads and validates', () => {
    const matrix = loadMatrix({});
    expect(matrix.models['claude-opus-4-8']).toBeDefined();
    expect(matrix.models['grok-4-5'].cost_tier).toBe('low');
    expect(matrix.default_policy).toBe('cost-first');
    expect(matrix.task_routing['architecture-decision']).toBe('claude-opus-4-8');
  });

  test('schema-invalid override (empty strengths) throws a clear error', () => {
    const dir = mkTmp();
    try {
      writeProjectOverride(dir, {
        models: { broken: { provider: 'x', strengths: [], cost_tier: 'high', speed_tier: 'fast' } },
      });
      expect(() => loadMatrix({ projectRoot: dir })).toThrow(/validation failed/i);
      expect(() => loadMatrix({ projectRoot: dir })).toThrow(/strengths/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('schema-invalid override (bad cost_tier enum) throws with allowed values', () => {
    const dir = mkTmp();
    try {
      writeProjectOverride(dir, {
        models: { weird: { provider: 'x', strengths: ['coding-speed'], cost_tier: 'ultra', speed_tier: 'fast' } },
      });
      expect(() => loadMatrix({ projectRoot: dir })).toThrow(/low, medium, high/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('semantic-invalid override (route → unknown model) throws a clear error', () => {
    const dir = mkTmp();
    try {
      writeProjectOverride(dir, { task_routing: { default: 'no-such-model' } });
      expect(() => loadMatrix({ projectRoot: dir })).toThrow(/semantic validation failed/i);
      expect(() => loadMatrix({ projectRoot: dir })).toThrow(/no-such-model/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// matrix-loader: project override + cache invalidation
// ─────────────────────────────────────────────────────────────────────────────

describe('matrix-loader — project override', () => {
  test('AC3: a project can add a new model and re-point a route without code', () => {
    const dir = mkTmp();
    try {
      writeProjectOverride(dir, {
        models: {
          'my-local-model': {
            provider: 'local',
            strengths: ['coding-speed', 'test-generation'],
            cost_tier: 'low',
            speed_tier: 'fast',
          },
        },
        task_routing: { 'test-generation': 'my-local-model' },
      });

      const matrix = loadMatrix({ projectRoot: dir });
      expect(matrix.models['my-local-model']).toBeDefined();
      expect(matrix.task_routing['test-generation']).toBe('my-local-model');
      // Core models remain available (shallow merge preserves un-overridden keys).
      expect(matrix.models['claude-opus-4-8']).toBeDefined();

      const router = new LlmRouter({ matrix });
      const decision = router.route('escrever testes unitários do serviço');
      expect(decision.category).toBe('test-generation');
      expect(decision.model).toBe('my-local-model');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cache invalidates when the project override mtime changes', () => {
    const dir = mkTmp();
    try {
      writeProjectOverride(dir, { task_routing: { 'code-review': 'grok-4-5' } });
      let matrix = loadMatrix({ projectRoot: dir });
      expect(matrix.task_routing['code-review']).toBe('grok-4-5');

      // Rewrite with a different route and a bumped mtime.
      const file = path.join(dir, '.aios', 'capability-matrix.yaml');
      fs.writeFileSync(file, yaml.dump({ task_routing: { 'code-review': 'gpt-5.5-codex' } }), 'utf8');
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(file, future, future);

      matrix = loadMatrix({ projectRoot: dir });
      expect(matrix.task_routing['code-review']).toBe('gpt-5.5-codex');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// router.categorize — PT + EN heuristics
// ─────────────────────────────────────────────────────────────────────────────

describe('LlmRouter.categorize', () => {
  const router = new LlmRouter({ matrix: policyFixture() });

  const cases = [
    ['decidir a arquitetura do gateway', 'architecture-decision'],
    ['design the system architecture', 'architecture-decision'],
    ['refatorar o módulo de billing', 'bulk-refactor'],
    ['large-scale refactor of the api', 'bulk-refactor'],
    ['migrar o banco para postgres', 'bulk-refactor'],
    ['escrever testes de integração', 'test-generation'],
    ['add test coverage', 'test-generation'],
    ['revisar o pull request', 'code-review'],
    ['do a code review of the diff', 'code-review'],
    ['auditoria de segurança do login', 'security-review'],
    ['pesquisar e resumir o mercado', 'research-summarize'],
    ['research and summarize competitors', 'research-summarize'],
    ['implementar a feature de login', 'story-implementation'],
    ['implement the story', 'story-implementation'],
    ['algo totalmente aleatório', 'default'],
  ];

  test.each(cases)('categorize(%s) → %s', (text, expected) => {
    expect(router.categorize(text)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// router.route — policies pick as specified (injected fixture)
// ─────────────────────────────────────────────────────────────────────────────

describe('LlmRouter.route — policy selection', () => {
  const router = new LlmRouter({ matrix: policyFixture() });

  test('quality-first ignores cost and picks the strongest match', () => {
    const d = router.route('write tests', { policy: 'quality-first' });
    expect(d.model).toBe('qual');
    expect(d.policy).toBe('quality-first');
  });

  test('cost-first picks the cheapest covering model', () => {
    const d = router.route('write tests', { policy: 'cost-first' });
    expect(d.model).toBe('cheap');
  });

  test('speed-first picks the fastest covering model', () => {
    const d = router.route('write tests', { policy: 'speed-first' });
    expect(d.model).toBe('swift');
  });

  test('unknown policy throws a clear error', () => {
    expect(() => router.route('write tests', { policy: 'nonsense' })).toThrow(/Unknown policy/);
  });

  test('alternatives exclude the chosen model', () => {
    const d = router.route('write tests', { policy: 'cost-first' });
    expect(d.model).toBe('cheap');
    expect(d.alternatives.map((a) => a.model)).not.toContain('cheap');
    expect(d.alternatives.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// router.route — real matrix behavior (direct mapping + complexity upgrade)
// ─────────────────────────────────────────────────────────────────────────────

describe('LlmRouter.route — real matrix', () => {
  test('bulk-refactor maps directly to grok-4-5', () => {
    const router = new LlmRouter({});
    const d = router.route('refatorar o módulo de billing para extrair um pacote compartilhado');
    expect(d.category).toBe('bulk-refactor');
    expect(d.model).toBe('grok-4-5');
    expect(d.policy).toBe('direct');
  });

  test('architecture-decision + quality-first stays on claude-opus-4-8', () => {
    const router = new LlmRouter({});
    const d = router.route('decidir a arquitetura do gateway telegram', { policy: 'quality-first' });
    expect(d.category).toBe('architecture-decision');
    expect(d.model).toBe('claude-opus-4-8');
    expect(d.provider).toBe('anthropic');
  });

  test('cost-first upgrades one tier for complex tasks', () => {
    const router = new LlmRouter({});
    const d = router.route('optimize the performance of the whole system', { policy: 'cost-first' });
    expect(d.complexity).toBe('complex');
    // low-tier (grok/gemini) would be the naive pick; complex bumps to medium.
    expect(d.model).toBe('gpt-5.5-codex');
    expect(d.reason).toMatch(/complex/i);
  });

  test('listModels and listPolicies expose the matrix', () => {
    const router = new LlmRouter({});
    expect(router.listModels().map((m) => m.id)).toContain('claude-opus-4-8');
    const policies = router.listPolicies();
    expect(policies.find((p) => p.isDefault).name).toBe('cost-first');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cli.routeCommand — advisor mode end-to-end (exit codes)
// ─────────────────────────────────────────────────────────────────────────────

describe('routeCommand — advisor CLI', () => {
  let logs;
  let logSpy;
  let errSpy;

  beforeEach(() => {
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    errSpy = jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('suggest prints a recommendation and exits 0', () => {
    const code = routeCommand(['suggest', 'refatorar o módulo de billing']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/grok-4-5/);
  });

  test('suggest with --policy exits 0', () => {
    const code = routeCommand(['suggest', 'decidir a arquitetura', '--policy', 'quality-first']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/claude-opus-4-8/);
  });

  test('suggest without a task exits 1', () => {
    const code = routeCommand(['suggest']);
    expect(code).toBe(1);
  });

  test('matrix prints the table and exits 0', () => {
    const code = routeCommand(['matrix']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/claude-opus-4-8/);
  });

  test('policies lists policies and exits 0', () => {
    const code = routeCommand(['policies']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/cost-first/);
  });

  test('unknown subcommand prints usage and exits 1', () => {
    const code = routeCommand(['bogus']);
    expect(code).toBe(1);
  });

  test('no subcommand prints usage and exits 0', () => {
    const code = routeCommand([]);
    expect(code).toBe(0);
  });
});
