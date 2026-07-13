/**
 * @fileoverview OpenAI Codex Provider
 *
 * AI Provider implementation for OpenAI's Codex CLI.
 * Wraps the `codex exec` command for non-interactive prompt execution.
 * Mirrors the ClaudeProvider technique: prompt is written via stdin to avoid
 * shell interpolation/injection.
 *
 * @see Epic WSB — Story WSB-2.2: Provider Adapters (Codex CLI)
 */

const { spawn, execSync } = require('child_process');
const { AIProvider } = require('./ai-provider');

/**
 * OpenAI Codex CLI provider implementation
 *
 * @class CodexProvider
 * @extends AIProvider
 */
class CodexProvider extends AIProvider {
  /**
   * Create a Codex provider
   * @param {Object} [config={}] - Provider configuration
   * @param {string} [config.model='gpt-5.5-codex'] - Model to use
   * @param {number} [config.timeout=300000] - Execution timeout
   */
  constructor(config = {}) {
    super({
      name: 'codex',
      command: 'codex',
      timeout: config.timeout || 300000,
      maxRetries: config.maxRetries || 3,
      options: {
        model: config.model || 'gpt-5.5-codex',
        ...config,
      },
    });
  }

  /**
   * Check if Codex CLI is available
   * @returns {Promise<boolean>} True if available
   */
  async checkAvailability() {
    try {
      const version = execSync('codex --version', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim();

      this.isAvailable = true;
      this.version = version;
      return true;
    } catch (error) {
      this.isAvailable = false;
      this.lastError = error;
      return false;
    }
  }

  /**
   * Execute a prompt using the Codex CLI (`codex exec`, non-interactive)
   * @param {string} prompt - The prompt to send
   * @param {Object} [options={}] - Execution options
   * @param {string} [options.workingDir] - Working directory for execution
   * @param {Object} [options.env] - Additional environment variables
   * @param {number} [options.timeout] - Override default timeout
   * @param {string} [options.model] - Override model
   * @returns {Promise<AIResponse>} The AI response
   */
  async execute(prompt, options = {}) {
    const startTime = Date.now();
    const workingDir = options.workingDir || process.cwd();
    const timeout = options.timeout || this.timeout;

    // Non-interactive subcommand. Prompt is written via stdin (mirrors
    // ClaudeProvider) so we never interpolate it into a shell command.
    const args = ['exec'];

    if (options.model || this.options.model) {
      args.push('--model', options.model || this.options.model);
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      // Spawn codex directly without shell interpolation (safer)
      const child = spawn(this.command, args, {
        cwd: workingDir,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Write prompt via stdin to avoid shell injection
      child.stdin.write(prompt);
      child.stdin.end();

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Codex execution timed out after ${timeout}ms`));
      }, timeout);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;

        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim(),
            metadata: {
              duration,
              provider: 'codex',
              model: options.model || this.options.model,
            },
          });
        } else {
          reject(new Error(`Codex exited with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Codex spawn error: ${error.message}`));
      });
    });
  }
}

module.exports = { CodexProvider };
