/**
 * Codex Provider Tests
 * Story WSB-2.2 — Provider Adapters (OpenAI Codex CLI)
 *
 * All child_process interactions are mocked. No real CLI is invoked.
 */

const { EventEmitter } = require('events');

// Mock child_process before requiring the provider
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
}));

const childProcess = require('child_process');
const { CodexProvider } = require('../../../.aios-core/infrastructure/integrations/ai-providers/codex-provider');
const { AIProvider } = require('../../../.aios-core/infrastructure/integrations/ai-providers/ai-provider');

/**
 * Build a fake child process object suitable for the provider's spawn usage.
 * @param {Object} opts - Behavior options
 * @returns {EventEmitter} Fake child process
 */
function makeFakeChild({ stdout = '', stderr = '', code = 0, emitError = null } = {}) {
  const child = new EventEmitter();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();

  // Drive the async emissions on next tick
  process.nextTick(() => {
    if (emitError) {
      child.emit('error', emitError);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });

  return child;
}

describe('CodexProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('construction', () => {
    it('extends AIProvider', () => {
      const p = new CodexProvider();
      expect(p).toBeInstanceOf(AIProvider);
    });

    it('has name "codex" and command "codex"', () => {
      const p = new CodexProvider();
      expect(p.name).toBe('codex');
      expect(p.command).toBe('codex');
    });

    it('defaults model to gpt-5.5-codex and does not throw', () => {
      expect(() => new CodexProvider()).not.toThrow();
      const p = new CodexProvider();
      expect(p.options.model).toBe('gpt-5.5-codex');
    });

    it('honors custom model/timeout', () => {
      const p = new CodexProvider({ model: 'custom-codex', timeout: 1234 });
      expect(p.options.model).toBe('custom-codex');
      expect(p.timeout).toBe(1234);
    });
  });

  describe('checkAvailability', () => {
    it('returns false and never throws when CLI is missing', async () => {
      childProcess.execSync.mockImplementation(() => {
        throw new Error('command not found: codex');
      });

      const p = new CodexProvider();
      await expect(p.checkAvailability()).resolves.toBe(false);
      expect(p.isAvailable).toBe(false);
      expect(p.lastError).toBeInstanceOf(Error);
    });

    it('returns true and caches version when CLI is present', async () => {
      childProcess.execSync.mockReturnValue('codex 1.0.0\n');

      const p = new CodexProvider();
      await expect(p.checkAvailability()).resolves.toBe(true);
      expect(p.isAvailable).toBe(true);
      expect(p.version).toBe('codex 1.0.0');
    });
  });

  describe('execute', () => {
    it('invokes `codex exec` with prompt via stdin and returns AIResponse', async () => {
      childProcess.spawn.mockReturnValue(makeFakeChild({ stdout: 'hello from codex', code: 0 }));

      const p = new CodexProvider();
      const res = await p.execute('do the thing');

      // codex exec subcommand, prompt via stdin (not as an arg)
      const [cmd, args] = childProcess.spawn.mock.calls[0];
      expect(cmd).toBe('codex');
      expect(args[0]).toBe('exec');

      const child = childProcess.spawn.mock.results[0].value;
      expect(child.stdin.write).toHaveBeenCalledWith('do the thing');
      expect(child.stdin.end).toHaveBeenCalled();

      // AIResponse shape matches existing providers
      expect(res.success).toBe(true);
      expect(res.output).toBe('hello from codex');
      expect(res.metadata.provider).toBe('codex');
      expect(res.metadata.model).toBe('gpt-5.5-codex');
      expect(typeof res.metadata.duration).toBe('number');
    });

    it('passes --model when specified', async () => {
      childProcess.spawn.mockReturnValue(makeFakeChild({ stdout: 'ok', code: 0 }));

      const p = new CodexProvider();
      await p.execute('prompt', { model: 'gpt-x' });

      const [, args] = childProcess.spawn.mock.calls[0];
      expect(args).toContain('--model');
      expect(args).toContain('gpt-x');
    });

    it('rejects when the CLI exits non-zero (base retry handles it)', async () => {
      childProcess.spawn.mockReturnValue(makeFakeChild({ stderr: 'boom', code: 1 }));

      const p = new CodexProvider();
      await expect(p.execute('prompt')).rejects.toThrow(/Codex exited with code 1/);
    });

    it('rejects on spawn error', async () => {
      childProcess.spawn.mockReturnValue(makeFakeChild({ emitError: new Error('ENOENT') }));

      const p = new CodexProvider();
      await expect(p.execute('prompt')).rejects.toThrow(/Codex spawn error/);
    });
  });
});
