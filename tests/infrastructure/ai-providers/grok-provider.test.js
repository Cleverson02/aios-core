/**
 * Grok Provider Tests
 * Story WSB-2.2 — Provider Adapters (xAI Grok API)
 *
 * global.fetch is mocked for every test. NO real network request is ever made.
 */

const { GrokProvider } = require('../../../.aios-core/infrastructure/integrations/ai-providers/grok-provider');
const { AIProvider } = require('../../../.aios-core/infrastructure/integrations/ai-providers/ai-provider');

describe('GrokProvider', () => {
  const ORIGINAL_ENV = process.env.XAI_API_KEY;
  let fetchSpy;

  beforeEach(() => {
    // Fail loud if any test performs a real fetch: default mock rejects.
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected real fetch'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = ORIGINAL_ENV;
    }
  });

  describe('construction', () => {
    it('extends AIProvider', () => {
      expect(new GrokProvider()).toBeInstanceOf(AIProvider);
    });

    it('has name "grok" and default model grok-4-5', () => {
      const p = new GrokProvider();
      expect(p.name).toBe('grok');
      expect(p.options.model).toBe('grok-4-5');
    });

    it('does not throw on construction without a key', () => {
      delete process.env.XAI_API_KEY;
      expect(() => new GrokProvider()).not.toThrow();
    });
  });

  describe('checkAvailability', () => {
    it('returns false without XAI_API_KEY and makes NO network call', async () => {
      delete process.env.XAI_API_KEY;
      const p = new GrokProvider();

      await expect(p.checkAvailability()).resolves.toBe(false);
      expect(p.isAvailable).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns true when XAI_API_KEY is present and makes NO network call', async () => {
      process.env.XAI_API_KEY = 'test-key';
      const p = new GrokProvider();

      await expect(p.checkAvailability()).resolves.toBe(true);
      expect(p.isAvailable).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('execute — happy path', () => {
    it('POSTs to the xAI endpoint and returns AIResponse from choices', async () => {
      process.env.XAI_API_KEY = 'test-key';
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '  grok says hi  ' } }],
          usage: { total_tokens: 42 },
        }),
      });

      const p = new GrokProvider();
      const res = await p.execute('hello');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.x.ai/v1/chat/completions');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer test-key');

      const body = JSON.parse(init.body);
      expect(body.model).toBe('grok-4-5');
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);

      // AIResponse shape
      expect(res.success).toBe(true);
      expect(res.output).toBe('grok says hi');
      expect(res.metadata.provider).toBe('grok');
      expect(res.metadata.model).toBe('grok-4-5');
      expect(res.metadata.tokens).toBe(42);
      expect(typeof res.metadata.duration).toBe('number');
    });
  });

  describe('execute — errors', () => {
    it('throws a clear error when XAI_API_KEY is not set (no fetch)', async () => {
      delete process.env.XAI_API_KEY;
      const p = new GrokProvider();

      await expect(p.execute('hi')).rejects.toThrow('XAI_API_KEY not set');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws with status + truncated body on HTTP 429', async () => {
      process.env.XAI_API_KEY = 'test-key';
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limit exceeded',
      });

      const p = new GrokProvider();
      await expect(p.execute('hi')).rejects.toThrow(/Grok API error 429: rate limit exceeded/);
    });

    it('throws a timeout error when the request is aborted', async () => {
      process.env.XAI_API_KEY = 'test-key';
      fetchSpy.mockImplementation((_url, init) => {
        // Simulate AbortController firing
        return new Promise((_resolve, reject) => {
          if (init.signal.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const p = new GrokProvider();
      await expect(p.execute('hi', { timeout: 10 })).rejects.toThrow(/Grok execution timed out after 10ms/);
    });
  });

  describe('executeWithRetry (base) with grok', () => {
    it('retries on HTTP failure then succeeds, using only mocked fetch', async () => {
      process.env.XAI_API_KEY = 'test-key';
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
        });

      const p = new GrokProvider({ maxRetries: 2 });
      const res = await p.executeWithRetry('hi');
      expect(res.output).toBe('recovered');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
