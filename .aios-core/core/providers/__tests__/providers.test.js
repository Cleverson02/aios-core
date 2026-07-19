/**
 * Tests for the Providers module (Story WSB-4.4).
 *
 * All filesystem state is isolated:
 *   - `AIOX_HOME` is redirected to a per-test tmp dir (credentials + enabled flags);
 *   - the availability cache lives under a separate tmp `cwd`.
 * CLI probes are mocked (no `child_process` spawn, no network).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const credentials = require('../credentials-store');
const availability = require('../availability');
const { LlmRouter } = require('../../router/router');
const { clearCache } = require('../../router/matrix-loader');

/** Make an isolated temp dir. */
function mkTmp(prefix = 'providers-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Env keys we scrub so host env never leaks into a test. */
const SCRUBBED_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
];

let aioxHome;
let savedEnv;

beforeEach(() => {
  clearCache();
  aioxHome = mkTmp('aiox-home-');
  process.env.AIOX_HOME = aioxHome;

  savedEnv = {};
  for (const k of SCRUBBED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SCRUBBED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete process.env.AIOX_HOME;
  fs.rmSync(aioxHome, { recursive: true, force: true });
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// credentials-store
// ─────────────────────────────────────────────────────────────────────────────

describe('credentials-store', () => {
  test('AC1: set/get a key round-trips through the store', () => {
    credentials.setKey('anthropic', 'sk-ant-123');
    expect(credentials.getKey('anthropic')).toBe('sk-ant-123');
    expect(credentials.getKeySource('anthropic')).toBe('store');
  });

  test('AC1: the credentials file is written with mode 0600', () => {
    credentials.setKey('openai', 'sk-openai-xyz');
    const file = credentials.credentialsPath();
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('AC1: env var ALWAYS takes precedence over the store', () => {
    credentials.setKey('xai', 'store-key');
    process.env.XAI_API_KEY = 'env-key';
    expect(credentials.getKey('xai')).toBe('env-key');
    expect(credentials.getKeySource('xai')).toBe('env');
  });

  test('AC1: google resolves from either GOOGLE_API_KEY or GEMINI_API_KEY', () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    expect(credentials.getKey('google')).toBe('gem-key');
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'goog-key';
    expect(credentials.getKey('google')).toBe('goog-key');
  });

  test('removeKey drops the stored value but leaves env untouched', () => {
    credentials.setKey('telegram', 'bot-token');
    expect(credentials.removeKey('telegram')).toBe(true);
    expect(credentials.getKey('telegram')).toBeNull();
    // Removing again is a no-op.
    expect(credentials.removeKey('telegram')).toBe(false);
  });

  test('listProviders reports presence + source and NEVER the key value', () => {
    credentials.setKey('anthropic', 'super-secret-value');
    process.env.OPENAI_API_KEY = 'env-secret';

    const rows = credentials.listProviders();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('env-secret');

    const anthropic = rows.find((r) => r.provider === 'anthropic');
    const openai = rows.find((r) => r.provider === 'openai');
    const google = rows.find((r) => r.provider === 'google');
    expect(anthropic).toMatchObject({ hasKey: true, source: 'store' });
    expect(openai).toMatchObject({ hasKey: true, source: 'env' });
    expect(google).toMatchObject({ hasKey: false, source: null });
  });

  test('unknown provider throws a clear error', () => {
    expect(() => credentials.setKey('bogus', 'x')).toThrow(/Unknown provider/);
  });

  test('setKey refuses an empty key', () => {
    expect(() => credentials.setKey('anthropic', '   ')).toThrow(/empty key/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// availability
// ─────────────────────────────────────────────────────────────────────────────

describe('availability', () => {
  test('AC2: available when the CLI is present (key absent), no network', () => {
    const spy = jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => 'v1.0.0');
    const cwd = mkTmp('cwd-');
    try {
      const { providers } = availability.getAvailability({ cwd, refresh: true });
      expect(providers.anthropic.cliPresent).toBe(true);
      expect(providers.anthropic.keyPresent).toBe(false);
      expect(providers.anthropic.available).toBe(true);
      // xAI is API-only → never probes a CLI.
      expect(providers.xai.cliPresent).toBeNull();
      // execFileSync only ever called with `--version`, never a network op.
      for (const call of spy.mock.calls) {
        expect(call[1]).toEqual(['--version']);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('AC2: available via key when the CLI is absent', () => {
    jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('command not found');
    });
    process.env.XAI_API_KEY = 'env-key';
    const cwd = mkTmp('cwd-');
    try {
      const { providers } = availability.getAvailability({ cwd, refresh: true });
      expect(providers.anthropic.cliPresent).toBe(false);
      expect(providers.anthropic.available).toBe(false);
      // xAI has a key and no CLI requirement → available.
      expect(providers.xai.keyPresent).toBe(true);
      expect(providers.xai.available).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('AC2: results are cached and reused within the TTL', () => {
    const spy = jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => 'v1');
    const cwd = mkTmp('cwd-');
    try {
      availability.getAvailability({ cwd, refresh: true });
      const callsAfterFirst = spy.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // Second call (no refresh) is served from cache → no new probes.
      availability.getAvailability({ cwd });
      expect(spy.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('AC2: a stale cache (past TTL) is recomputed', () => {
    const spy = jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => 'v1');
    const cwd = mkTmp('cwd-');
    try {
      availability.getAvailability({ cwd, refresh: true });
      const first = spy.mock.calls.length;

      // Age the cache beyond the TTL.
      const file = availability.cachePath(cwd);
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      payload.generatedAt = Date.now() - availability.CACHE_TTL_MS - 1000;
      fs.writeFileSync(file, JSON.stringify(payload));

      availability.getAvailability({ cwd });
      expect(spy.mock.calls.length).toBeGreaterThan(first);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('AC2: enable/disable persists and flips availability', () => {
    jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => 'v1');
    const cwd = mkTmp('cwd-');
    try {
      let providers = availability.getAvailability({ cwd, refresh: true }).providers;
      expect(providers.anthropic.available).toBe(true);

      availability.setEnabled('anthropic', false);
      expect(availability.isEnabled('anthropic')).toBe(false);

      providers = availability.getAvailability({ cwd, refresh: true }).providers;
      expect(providers.anthropic.enabled).toBe(false);
      expect(providers.anthropic.available).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('readAvailabilityCache returns null when there is no cache', () => {
    const cwd = mkTmp('cwd-');
    try {
      expect(availability.readAvailabilityCache({ cwd })).toBeNull();
      expect(availability.unavailableProviders({ cwd })).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// router integration (AC3)
// ─────────────────────────────────────────────────────────────────────────────

/** Write an availability cache fixture at <cwd>/.aios/providers-status.json. */
function writeAvailabilityFixture(cwd, providers) {
  const dir = path.join(cwd, '.aios');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'providers-status.json'),
    JSON.stringify({ generatedAt: Date.now(), providers }),
  );
}

describe('router availability filter (AC3)', () => {
  test('is neutral when no availability cache exists', () => {
    const cwd = mkTmp('cwd-');
    try {
      const router = new LlmRouter({ projectRoot: cwd });
      const d = router.route('refatorar o módulo de billing');
      // Same as the vanilla router: direct mapping to grok-4-5.
      expect(d.model).toBe('grok-4-5');
      expect(d.policy).toBe('direct');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('filters out models whose provider is unavailable', () => {
    const cwd = mkTmp('cwd-');
    try {
      // xai down, but openai/google up → test-generation (grok is xai) reroutes.
      writeAvailabilityFixture(cwd, {
        anthropic: { available: true },
        openai: { available: true },
        xai: { available: false },
        google: { available: true },
      });
      const router = new LlmRouter({ projectRoot: cwd });
      const d = router.route('escrever testes unitários');
      expect(d.category).toBe('test-generation');
      // grok-4-5 (xai) is filtered out; the chosen model is NOT xai.
      expect(d.provider).not.toBe('xai');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('direct route to an unavailable model falls back with a reason', () => {
    const cwd = mkTmp('cwd-');
    try {
      // anthropic down → architecture-decision (claude-opus-4-8) must reroute.
      writeAvailabilityFixture(cwd, {
        anthropic: { available: false },
        openai: { available: true },
        xai: { available: true },
        google: { available: true },
      });
      const router = new LlmRouter({ projectRoot: cwd });
      const d = router.route('decidir a arquitetura do gateway');
      expect(d.category).toBe('architecture-decision');
      expect(d.model).not.toBe('claude-opus-4-8');
      expect(d.provider).not.toBe('anthropic');
      expect(d.reason).toMatch(/claude-opus-4-8 indisponível/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('ignoreAvailability bypasses the filter entirely', () => {
    const cwd = mkTmp('cwd-');
    try {
      writeAvailabilityFixture(cwd, {
        anthropic: { available: false },
        openai: { available: true },
        xai: { available: true },
        google: { available: true },
      });
      const router = new LlmRouter({ projectRoot: cwd });
      const d = router.route('decidir a arquitetura do gateway', { ignoreAvailability: true });
      // Filter bypassed → curated direct mapping restored.
      expect(d.model).toBe('claude-opus-4-8');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('stays neutral when ALL relevant providers are unavailable (never strand)', () => {
    const cwd = mkTmp('cwd-');
    try {
      writeAvailabilityFixture(cwd, {
        anthropic: { available: false },
        openai: { available: false },
        xai: { available: false },
        google: { available: false },
      });
      const router = new LlmRouter({ projectRoot: cwd });
      const d = router.route('decidir a arquitetura do gateway');
      // Nothing available → original curated choice is kept rather than stranding.
      expect(d.model).toBe('claude-opus-4-8');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
