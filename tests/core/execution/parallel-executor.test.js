/**
 * Parallel Executor Tests
 * Story GEMINI-INT.17
 * Story WSB-2.4 - Cross-Vendor Consensus (N-provider modes)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Registry populated per-test; the mocked factory resolves from it.
const mockProviders = {};

jest.mock(
  '../../../.aios-core/infrastructure/integrations/ai-providers/ai-provider-factory',
  () => ({
    getProvider: (name) => {
      if (!mockProviders[name]) {
        throw new Error(`Unknown AI provider: ${name}`);
      }
      return mockProviders[name];
    },
  }),
);

const {
  ParallelExecutor,
  ParallelMode,
  CONSENSUS_PRESETS,
} = require('../../../.aios-core/core/execution/parallel-executor');

/**
 * Build a mock provider.
 * @param {Object} opts - { available, success, output, error }
 * @returns {Object} Mock provider with checkAvailability + execute
 */
function makeProvider({ available = true, success = true, output = '', error } = {}) {
  return {
    checkAvailability: jest.fn().mockResolvedValue(available),
    execute: jest
      .fn()
      .mockResolvedValue(success ? { success: true, output } : { success: false, error: error || 'failed' }),
  };
}

describe('ParallelExecutor', () => {
  let executor;

  beforeEach(() => {
    executor = new ParallelExecutor();
  });

  describe('ParallelMode', () => {
    it('should have all execution modes defined', () => {
      expect(ParallelMode.RACE).toBe('race');
      expect(ParallelMode.CONSENSUS).toBe('consensus');
      expect(ParallelMode.BEST_OF).toBe('best-of');
      expect(ParallelMode.MERGE).toBe('merge');
      expect(ParallelMode.FALLBACK).toBe('fallback');
    });
  });

  describe('constructor', () => {
    it('should use default mode as fallback', () => {
      expect(executor.mode).toBe(ParallelMode.FALLBACK);
    });

    it('should accept custom mode', () => {
      const custom = new ParallelExecutor({ mode: ParallelMode.RACE });
      expect(custom.mode).toBe(ParallelMode.RACE);
    });

    it('should have default consensus similarity', () => {
      expect(executor.consensusSimilarity).toBe(0.85);
    });

    it('should initialize stats', () => {
      expect(executor.stats.executions).toBe(0);
      expect(executor.stats.consensusAgreements).toBe(0);
      expect(executor.stats.fallbacksUsed).toBe(0);
    });
  });

  describe('execute', () => {
    it('should execute both providers in parallel', async () => {
      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Claude result' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Gemini result' });

      const result = await executor.execute(claudeExecutor, geminiExecutor);

      expect(claudeExecutor).toHaveBeenCalled();
      expect(geminiExecutor).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should increment execution count', async () => {
      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'test' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'test' });

      await executor.execute(claudeExecutor, geminiExecutor);

      expect(executor.stats.executions).toBe(1);
    });

    it('should handle Claude failure with Gemini fallback', async () => {
      const claudeExecutor = jest.fn().mockRejectedValue(new Error('Claude failed'));
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Gemini result' });

      const result = await executor.execute(claudeExecutor, geminiExecutor);

      expect(result.success).toBe(true);
      expect(result.selectedProvider).toBe('gemini');
      expect(result.usedFallback).toBe(true);
    });

    it('should handle both failures', async () => {
      const claudeExecutor = jest.fn().mockRejectedValue(new Error('Claude failed'));
      const geminiExecutor = jest.fn().mockRejectedValue(new Error('Gemini failed'));

      const result = await executor.execute(claudeExecutor, geminiExecutor);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Both providers failed');
    });

    it('should emit events', async () => {
      const startedHandler = jest.fn();
      const completedHandler = jest.fn();

      executor.on('parallel_started', startedHandler);
      executor.on('parallel_completed', completedHandler);

      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'test' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'test' });

      await executor.execute(claudeExecutor, geminiExecutor);

      expect(startedHandler).toHaveBeenCalled();
      expect(completedHandler).toHaveBeenCalled();
    });
  });

  describe('race mode', () => {
    it('should return first successful result', async () => {
      const raceExecutor = new ParallelExecutor({ mode: ParallelMode.RACE });

      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Claude' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Gemini' });

      const result = await raceExecutor.execute(claudeExecutor, geminiExecutor);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('race');
    });
  });

  describe('consensus mode', () => {
    it('should achieve consensus when outputs are similar', async () => {
      const consensusExecutor = new ParallelExecutor({
        mode: ParallelMode.CONSENSUS,
        consensusSimilarity: 0.5,
      });

      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'The quick brown fox' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'The quick brown dog' });

      const result = await consensusExecutor.execute(claudeExecutor, geminiExecutor);

      expect(result.mode).toBe('consensus');
      expect(result).toHaveProperty('similarity');
    });
  });

  describe('best-of mode', () => {
    it('should score and pick best output', async () => {
      const bestOfExecutor = new ParallelExecutor({ mode: ParallelMode.BEST_OF });

      const claudeExecutor = jest.fn().mockResolvedValue({
        success: true,
        output: 'Short response',
      });
      const geminiExecutor = jest.fn().mockResolvedValue({
        success: true,
        output: 'This is a much longer response with more content and details including ```code blocks``` and - bullet points',
      });

      const result = await bestOfExecutor.execute(claudeExecutor, geminiExecutor);

      expect(result.mode).toBe('best-of');
      expect(result).toHaveProperty('scores');
    });
  });

  describe('merge mode', () => {
    it('should merge both outputs', async () => {
      const mergeExecutor = new ParallelExecutor({ mode: ParallelMode.MERGE });

      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Claude output' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Gemini output' });

      const result = await mergeExecutor.execute(claudeExecutor, geminiExecutor);

      expect(result.mode).toBe('merge');
      expect(result.output).toContain('Claude');
      expect(result.output).toContain('Gemini');
    });
  });

  describe('getStats', () => {
    it('should return stats with calculated rates', async () => {
      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'test' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'test' });

      await executor.execute(claudeExecutor, geminiExecutor);

      const stats = executor.getStats();

      expect(stats).toHaveProperty('executions');
      expect(stats).toHaveProperty('consensusRate');
      expect(stats).toHaveProperty('fallbackRate');
    });
  });

  describe('timeout handling', () => {
    it('should timeout slow executors', async () => {
      const timeoutExecutor = new ParallelExecutor({ timeout: 100 });

      const slowExecutor = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 500)),
      );
      const fastExecutor = jest.fn().mockResolvedValue({ success: true, output: 'fast' });

      const result = await timeoutExecutor.execute(slowExecutor, fastExecutor);

      expect(result.success).toBe(true);
    }, 10000);
  });

  // ===========================================================================
  // Story WSB-2.4 — Cross-Vendor Consensus (N-provider API)
  // ===========================================================================
  describe('executeWithProviders (N-provider)', () => {
    beforeEach(() => {
      for (const key of Object.keys(mockProviders)) {
        delete mockProviders[key];
      }
    });

    it('exposes the critical-review preset', () => {
      expect(CONSENSUS_PRESETS['critical-review']).toEqual(['claude', 'codex', 'grok']);
    });

    it('3-way CONSENSUS: simple majority 2-1 wins', async () => {
      mockProviders.claude = makeProvider({ output: 'Use PostgreSQL for the store' });
      mockProviders.codex = makeProvider({ output: 'Use PostgreSQL for the store' });
      mockProviders.grok = makeProvider({ output: 'Prefer MongoDB document database instead' });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Which DB?', {
        mode: ParallelMode.CONSENSUS,
        decisionLog: false,
      });

      expect(result.success).toBe(true);
      expect(result.consensus).toBe(true);
      expect(result.votes).toHaveLength(3);
      // Majority group has claude + codex sharing the same group id.
      const claudeVote = result.votes.find((v) => v.provider === 'claude');
      const codexVote = result.votes.find((v) => v.provider === 'codex');
      const grokVote = result.votes.find((v) => v.provider === 'grok');
      expect(claudeVote.group).toBe(codexVote.group);
      expect(grokVote.group).not.toBe(claudeVote.group);
      expect(['claude', 'codex']).toContain(result.winner.provider);
      expect(result.tiebreak).toBeUndefined();
    });

    it('3-way CONSENSUS: 1-1-1 tie broken by BEST_OF scoring', async () => {
      mockProviders.claude = makeProvider({ output: 'Alpha approach' });
      mockProviders.codex = makeProvider({ output: 'Beta entirely separate reasoning here' });
      mockProviders.grok = makeProvider({
        output:
          'Gamma detailed recommendation with a concrete example:\n```js\nconst x = compute();\n```\nThis longer structured answer explains the trade-offs thoroughly for reviewers.',
      });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Approach?', {
        mode: ParallelMode.CONSENSUS,
        decisionLog: false,
      });

      expect(result.success).toBe(true);
      expect(result.consensus).toBe(false);
      expect(result.tiebreak).toBe('best-of');
      // grok output is longest + has a code block → highest score.
      expect(result.selectedProvider).toBe('grok');
      expect(result.scores).toHaveProperty('grok');
      // All three formed distinct groups.
      const groupIds = new Set(result.votes.map((v) => v.group));
      expect(groupIds.size).toBe(3);
    });

    it('skips unavailable provider and proceeds with remaining 2', async () => {
      mockProviders.claude = makeProvider({ output: 'Ship it now' });
      mockProviders.codex = makeProvider({ output: 'Ship it now' });
      mockProviders.grok = makeProvider({ available: false });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Go?', {
        mode: ParallelMode.CONSENSUS,
        decisionLog: false,
      });

      expect(result.success).toBe(true);
      expect(result.consensus).toBe(true);
      expect(result.votes).toHaveLength(2);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].name).toBe('grok');
      expect(mockProviders.grok.execute).not.toHaveBeenCalled();
    });

    it('returns structured error when fewer than 2 providers are available', async () => {
      mockProviders.claude = makeProvider({ output: 'only one' });
      mockProviders.codex = makeProvider({ available: false });
      mockProviders.grok = makeProvider({ available: false });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Go?', {
        mode: ParallelMode.CONSENSUS,
        decisionLog: false,
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe('INSUFFICIENT_PROVIDERS');
      expect(result.available).toEqual(['claude']);
      expect(result.skipped).toHaveLength(2);
      expect(mockProviders.claude.execute).not.toHaveBeenCalled();
    });

    it('resolves the critical-review preset from a string argument', async () => {
      mockProviders.claude = makeProvider({ output: 'Consensus text' });
      mockProviders.codex = makeProvider({ output: 'Consensus text' });
      mockProviders.grok = makeProvider({ output: 'Consensus text' });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders('critical-review', 'Review this', {
        mode: ParallelMode.CONSENSUS,
        decisionLog: false,
      });

      expect(result.success).toBe(true);
      expect(result.votes.map((v) => v.provider).sort()).toEqual(['claude', 'codex', 'grok']);
    });

    it('unknown provider name is skipped with a reason', async () => {
      mockProviders.claude = makeProvider({ output: 'A' });
      mockProviders.codex = makeProvider({ output: 'A' });
      // 'grok' intentionally not registered → getProvider throws → skipped.

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Go?', {
        mode: ParallelMode.CONSENSUS,
        decisionLog: false,
      });

      expect(result.success).toBe(true);
      expect(result.skipped.some((s) => s.name === 'grok')).toBe(true);
    });

    it('RACE mode returns first successful provider (in order)', async () => {
      mockProviders.claude = makeProvider({ success: false, error: 'boom' });
      mockProviders.codex = makeProvider({ output: 'codex wins the race' });
      mockProviders.grok = makeProvider({ output: 'grok also ok' });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Race', {
        mode: ParallelMode.RACE,
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('race');
      expect(result.selectedProvider).toBe('codex');
    });

    it('BEST_OF mode picks the highest scored output', async () => {
      mockProviders.claude = makeProvider({ output: 'short' });
      mockProviders.codex = makeProvider({
        output:
          'A thorough answer with structure:\n```js\ncode();\n```\n- point one\n- point two, complete and done, over one hundred characters long.',
      });
      mockProviders.grok = makeProvider({ output: 'medium length answer here' });

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Best?', {
        mode: ParallelMode.BEST_OF,
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('best-of');
      expect(result.selectedProvider).toBe('codex');
      expect(result.scores).toHaveProperty('claude');
    });

    it('writes a consensus decision log to .ai/ under the given cwd', async () => {
      mockProviders.claude = makeProvider({ output: 'Adopt hexagonal architecture' });
      mockProviders.codex = makeProvider({ output: 'Adopt hexagonal architecture' });
      mockProviders.grok = makeProvider({ output: 'Use a simple layered monolith instead' });

      const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb24-'));

      const exec = new ParallelExecutor();
      const result = await exec.executeWithProviders(['claude', 'codex', 'grok'], 'Architecture decision', {
        mode: ParallelMode.CONSENSUS,
        cwd: tmpCwd,
        consensusId: 'test-3way',
      });

      expect(result.decisionLogPath).toBeDefined();
      expect(fs.existsSync(result.decisionLogPath)).toBe(true);

      const content = fs.readFileSync(result.decisionLogPath, 'utf8');
      expect(content).toContain('# Decision Log: Cross-Vendor Consensus');
      expect(content).toContain('## Votes');
      expect(content).toContain('claude');
      expect(content).toContain('grok');
      expect(content).toContain('## Winner');

      fs.rmSync(tmpCwd, { recursive: true, force: true });
    });
  });

  describe('backward compatibility (2-provider execute)', () => {
    it('classic execute() still works unchanged with two executor functions', async () => {
      const exec = new ParallelExecutor();
      const claudeExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Claude' });
      const geminiExecutor = jest.fn().mockResolvedValue({ success: true, output: 'Gemini' });

      const result = await exec.execute(claudeExecutor, geminiExecutor);

      expect(result.success).toBe(true);
      expect(claudeExecutor).toHaveBeenCalled();
      expect(geminiExecutor).toHaveBeenCalled();
    });
  });
});
