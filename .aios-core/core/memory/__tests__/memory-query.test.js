/**
 * MemoryQuery Tests
 *
 * Story: WSB-0.2 - Memory API Unificada
 *
 * Covers: return contracts, missing stores (graceful degradation),
 * score ordering, and the getContextForAgent contract.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MemoryQuery = require('../memory-query');

describe('MemoryQuery', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-mq-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const writeGotchas = (gotchas) => {
    const dir = path.join(tempDir, '.aios');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gotchas.json'), JSON.stringify({ gotchas }, null, 2));
  };

  const writeDecisionLog = (name, content) => {
    const dir = path.join(tempDir, '.ai');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };

  const writeStory = (relPath, content) => {
    const full = path.join(tempDir, 'docs', 'stories', relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  describe('constructor', () => {
    it('defaults projectRoot to cwd when no options given', () => {
      const mq = new MemoryQuery();
      expect(mq.projectRoot).toBe(process.cwd());
    });

    it('accepts an explicit projectRoot', () => {
      const mq = new MemoryQuery({ projectRoot: tempDir });
      expect(mq.projectRoot).toBe(tempDir);
    });
  });

  describe('query() - graceful degradation', () => {
    it('returns [] when no stores exist', async () => {
      const mq = new MemoryQuery({ projectRoot: tempDir });
      const results = await mq.query('anything');
      expect(results).toEqual([]);
    });

    it('returns [] for an empty query string', async () => {
      writeGotchas([{ title: 'Fetch Error Handling', reason: 'fetch does not throw' }]);
      const mq = new MemoryQuery({ projectRoot: tempDir });
      expect(await mq.query('')).toEqual([]);
      expect(await mq.query('   ')).toEqual([]);
    });

    it('does not throw when gotchas.json is malformed', async () => {
      const dir = path.join(tempDir, '.aios');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'gotchas.json'), '{ not valid json');
      const mq = new MemoryQuery({ projectRoot: tempDir });
      await expect(mq.query('fetch')).resolves.toEqual([]);
    });
  });

  describe('query() - return contract', () => {
    it('returns items shaped {type, content, summary, score}', async () => {
      writeGotchas([
        { title: 'Fetch Error Handling', reason: 'fetch does not throw on HTTP errors' },
      ]);
      const mq = new MemoryQuery({ projectRoot: tempDir });
      const results = await mq.query('fetch error handling');

      expect(results.length).toBeGreaterThan(0);
      const item = results[0];
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('content');
      expect(item).toHaveProperty('summary');
      expect(item).toHaveProperty('score');
      expect(typeof item.content).toBe('string');
      expect(item.score).toBeGreaterThan(0);
      expect(item.score).toBeLessThanOrEqual(1);
    });

    it('matches gotchas, decision logs and story files', async () => {
      writeGotchas([{ title: 'Zustand Persist Typing', reason: 'zustand needs explicit type' }]);
      writeDecisionLog('decision-log-x.md', '# Chose Zustand for state management\n');
      writeStory('story-1.md', '# Story about Zustand state\n\nbody text here');

      const mq = new MemoryQuery({ projectRoot: tempDir });
      const results = await mq.query('zustand state');
      const types = new Set(results.map((r) => r.type));

      expect(types.has('gotcha')).toBe(true);
      expect(types.has('decision')).toBe(true);
      expect(types.has('story')).toBe(true);
    });
  });

  describe('query() - score ordering and limit', () => {
    it('orders results by descending score', async () => {
      writeGotchas([
        { title: 'alpha beta gamma delta', reason: 'alpha beta gamma delta' },
        { title: 'alpha only unrelated', reason: 'alpha' },
      ]);
      const mq = new MemoryQuery({ projectRoot: tempDir });
      const results = await mq.query('alpha beta gamma delta');

      expect(results.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
      // Full-overlap candidate should score higher than partial-overlap candidate
      expect(results[0].score).toBeGreaterThan(results[results.length - 1].score);
    });

    it('respects the limit option', async () => {
      const gotchas = [];
      for (let i = 0; i < 10; i++) {
        gotchas.push({ title: `keyword item number ${i}`, reason: 'keyword item' });
      }
      writeGotchas(gotchas);
      const mq = new MemoryQuery({ projectRoot: tempDir });
      const results = await mq.query('keyword item', { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  describe('getContextForAgent()', () => {
    it('returns {relevantMemory, suggestedPatterns} contract', async () => {
      writeGotchas([{ title: 'API retry logic', reason: 'retry with backoff on api errors' }]);
      const mq = new MemoryQuery({ projectRoot: tempDir });
      const ctx = await mq.getContextForAgent('dev', 'implement api retry logic');

      expect(ctx).toHaveProperty('relevantMemory');
      expect(ctx).toHaveProperty('suggestedPatterns');
      expect(Array.isArray(ctx.relevantMemory)).toBe(true);
      expect(Array.isArray(ctx.suggestedPatterns)).toBe(true);
      expect(ctx.relevantMemory.length).toBeGreaterThan(0);
      expect(ctx.relevantMemory.length).toBeLessThanOrEqual(5);
    });

    it('degrades to empty arrays when no stores and no patterns exist', async () => {
      const mq = new MemoryQuery({ projectRoot: tempDir });
      const ctx = await mq.getContextForAgent('dev', 'some task');
      expect(ctx.relevantMemory).toEqual([]);
      expect(Array.isArray(ctx.suggestedPatterns)).toBe(true);
    });
  });
});
