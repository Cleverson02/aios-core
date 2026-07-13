/**
 * @fileoverview xAI Grok Provider
 *
 * AI Provider implementation for xAI's Grok models. Unlike the CLI-based
 * providers, Grok is accessed directly over the OpenAI-compatible REST API
 * (`https://api.x.ai/v1/chat/completions`) using the native `fetch`.
 *
 * Requires the `XAI_API_KEY` environment variable. Availability is a local
 * check for the presence of that key — no network request is ever made during
 * `checkAvailability()`.
 *
 * @see Epic WSB — Story WSB-2.2: Provider Adapters (xAI Grok API)
 */

const { AIProvider } = require('./ai-provider');

/** xAI OpenAI-compatible chat completions endpoint */
const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';

/**
 * xAI Grok API provider implementation
 *
 * @class GrokProvider
 * @extends AIProvider
 */
class GrokProvider extends AIProvider {
  /**
   * Create a Grok provider
   * @param {Object} [config={}] - Provider configuration
   * @param {string} [config.model='grok-4-5'] - Model to use
   * @param {number} [config.timeout=300000] - Execution timeout
   * @param {string} [config.apiUrl] - Override API endpoint (mainly for tests)
   */
  constructor(config = {}) {
    super({
      // `command` is not a CLI here — kept for interface parity with base class.
      name: 'grok',
      command: 'grok',
      timeout: config.timeout || 300000,
      maxRetries: config.maxRetries || 3,
      options: {
        model: config.model || 'grok-4-5',
        apiUrl: config.apiUrl || XAI_API_URL,
        ...config,
      },
    });
  }

  /**
   * Check if Grok is available.
   *
   * Availability is purely local: the `XAI_API_KEY` must be present in the
   * environment. No network request is performed.
   * @returns {Promise<boolean>} True if the API key is set
   */
  async checkAvailability() {
    const hasKey = Boolean(process.env.XAI_API_KEY);

    this.isAvailable = hasKey;
    if (!hasKey) {
      this.lastError = new Error('XAI_API_KEY not set');
    }
    return hasKey;
  }

  /**
   * Execute a prompt against the xAI Grok API
   * @param {string} prompt - The prompt to send
   * @param {Object} [options={}] - Execution options
   * @param {Object} [options.env] - Additional environment variables (checked before process.env)
   * @param {number} [options.timeout] - Override default timeout
   * @param {string} [options.model] - Override model
   * @returns {Promise<AIResponse>} The AI response
   */
  async execute(prompt, options = {}) {
    const startTime = Date.now();
    const timeout = options.timeout || this.timeout;
    const model = options.model || this.options.model;

    const apiKey = (options.env && options.env.XAI_API_KEY) || process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('XAI_API_KEY not set');
    }

    // AbortController-based timeout (native fetch, no extra deps)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await fetch(this.options.apiUrl || XAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`Grok execution timed out after ${timeout}ms`);
      }
      throw new Error(`Grok request failed: ${error.message}`);
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        body = '';
      }
      // Truncate body to keep error messages bounded
      const truncated = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      throw new Error(`Grok API error ${response.status}: ${truncated}`);
    }

    const data = await response.json();
    const duration = Date.now() - startTime;
    const content = data?.choices?.[0]?.message?.content ?? '';

    return {
      success: true,
      output: typeof content === 'string' ? content.trim() : String(content),
      data,
      metadata: {
        duration,
        provider: 'grok',
        model,
        usage: data?.usage,
        tokens: data?.usage?.total_tokens,
      },
    };
  }
}

module.exports = { GrokProvider };
