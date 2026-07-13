/**
 * Factory Fallback Tests — WSB-2.2
 *
 * Verifies codex/grok enter the existing fallback flow. Config is injected via
 * a mocked `.aios-ai-config.yaml`; provider I/O is stubbed. No real CLI/network.
 */

// Inject a config making grok primary and codex fallback.
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(
    () => 'ai_providers:\n  primary: grok\n  fallback: codex\n',
  ),
}));

const factory = require('../../../.aios-core/infrastructure/integrations/ai-providers/ai-provider-factory');

describe('WSB-2.2 factory fallback', () => {
  const ORIGINAL_KEY = process.env.XAI_API_KEY;

  beforeEach(() => {
    factory.clearProviderCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (ORIGINAL_KEY === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = ORIGINAL_KEY;
    }
  });

  it('resolves grok as primary and codex as fallback from config', () => {
    expect(factory.getPrimaryProvider().name).toBe('grok');
    expect(factory.getFallbackProvider().name).toBe('codex');
  });

  it('falls back from unavailable grok to codex without real I/O', async () => {
    delete process.env.XAI_API_KEY; // grok unavailable (no network)

    const codex = factory.getProvider('codex');
    jest.spyOn(codex, 'checkAvailability').mockResolvedValue(true);
    jest.spyOn(codex, 'executeWithRetry').mockResolvedValue({
      success: true,
      output: 'codex handled it',
      metadata: { provider: 'codex' },
    });

    const res = await factory.executeWithFallback('do work');
    expect(res.success).toBe(true);
    expect(res.output).toBe('codex handled it');
    expect(codex.executeWithRetry).toHaveBeenCalled();
  });

  it('uses grok directly when it is available (execute stubbed)', async () => {
    process.env.XAI_API_KEY = 'test-key';

    const grok = factory.getProvider('grok');
    jest.spyOn(grok, 'executeWithRetry').mockResolvedValue({
      success: true,
      output: 'grok handled it',
      metadata: { provider: 'grok' },
    });

    const res = await factory.executeWithFallback('do work');
    expect(res.success).toBe(true);
    expect(res.output).toBe('grok handled it');
    expect(grok.executeWithRetry).toHaveBeenCalled();
  });
});
