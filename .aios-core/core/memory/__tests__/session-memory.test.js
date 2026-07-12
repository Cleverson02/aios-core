/**
 * SessionMemory Tests
 *
 * Story: WSB-0.2 - Memory API Unificada
 *
 * Covers: record/retrieve contracts, persistence, timestamp ordering,
 * decision-log fallback, and graceful degradation for missing stores.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SessionMemory = require('../session-memory');

describe('SessionMemory', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-sm-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('defaults projectRoot to cwd when no options given', () => {
      const sm = new SessionMemory();
      expect(sm.projectRoot).toBe(process.cwd());
    });

    it('accepts an explicit projectRoot', () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      expect(sm.projectRoot).toBe(tempDir);
      expect(sm.storePath).toBe(path.join(tempDir, '.aios', 'session-memory.json'));
    });
  });

  describe('recordDecision()', () => {
    it('persists a decision with an ISO timestamp, creating the store', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      const record = await sm.recordDecision({
        decision: 'Use lexical matching',
        reason: 'No new dependencies allowed',
        context: { story: 'WSB-0.2' },
      });

      expect(record.decision).toBe('Use lexical matching');
      expect(record.reason).toBe('No new dependencies allowed');
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const storePath = path.join(tempDir, '.aios', 'session-memory.json');
      expect(fs.existsSync(storePath)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      expect(Array.isArray(persisted)).toBe(true);
      expect(persisted).toHaveLength(1);
    });

    it('appends to an existing store', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      await sm.recordDecision({ decision: 'first' });
      await sm.recordDecision({ decision: 'second' });

      const persisted = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.aios', 'session-memory.json'), 'utf-8'),
      );
      expect(persisted).toHaveLength(2);
    });
  });

  describe('getDecisions()', () => {
    it('returns {decision, reason, timestamp} shaped items, most recent first', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      const dir = path.join(tempDir, '.aios');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'session-memory.json'),
        JSON.stringify([
          { decision: 'older', reason: 'r1', timestamp: '2026-01-01T00:00:00.000Z' },
          { decision: 'newer', reason: 'r2', timestamp: '2026-06-01T00:00:00.000Z' },
        ]),
      );

      const decisions = await sm.getDecisions();
      expect(decisions).toHaveLength(2);
      expect(decisions[0].decision).toBe('newer');
      expect(decisions[1].decision).toBe('older');
      expect(decisions[0]).toEqual({
        decision: 'newer',
        reason: 'r2',
        timestamp: '2026-06-01T00:00:00.000Z',
      });
    });

    it('respects the limit option', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      for (let i = 0; i < 5; i++) {
        await sm.recordDecision({ decision: `d${i}` });
      }
      const decisions = await sm.getDecisions({ limit: 2 });
      expect(decisions).toHaveLength(2);
    });

    it('falls back to decision-log titles when no store exists', async () => {
      const aiDir = path.join(tempDir, '.ai');
      fs.mkdirSync(aiDir, { recursive: true });
      fs.writeFileSync(path.join(aiDir, 'decision-log-1.md'), '# Adopted worktree isolation\n');

      const sm = new SessionMemory({ projectRoot: tempDir });
      const decisions = await sm.getDecisions();
      expect(decisions.length).toBe(1);
      expect(decisions[0].decision).toBe('Adopted worktree isolation');
      expect(decisions[0]).toHaveProperty('timestamp');
    });

    it('returns [] when neither store nor decision logs exist', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      expect(await sm.getDecisions()).toEqual([]);
    });
  });

  describe('getSessionSummary()', () => {
    it('summarizes decision count, last decision and session start', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      const dir = path.join(tempDir, '.aios');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'session-memory.json'),
        JSON.stringify([
          { decision: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
          { decision: 'last', timestamp: '2026-06-01T00:00:00.000Z' },
        ]),
      );

      const summary = await sm.getSessionSummary();
      expect(summary.decisionCount).toBe(2);
      expect(summary.lastDecision).toBe('last');
      expect(summary.sessionStart).toBe('2026-01-01T00:00:00.000Z');
    });

    it('returns zeroed summary when there are no decisions', async () => {
      const sm = new SessionMemory({ projectRoot: tempDir });
      const summary = await sm.getSessionSummary();
      expect(summary).toEqual({ decisionCount: 0, lastDecision: null, sessionStart: null });
    });

    it('derives sessionStart from session-state.json when no decisions exist', async () => {
      const dir = path.join(tempDir, '.aios');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'session-state.json'),
        JSON.stringify({ currentSession: { startedAt: '2026-07-12T10:00:00.000Z' } }),
      );

      const sm = new SessionMemory({ projectRoot: tempDir });
      const summary = await sm.getSessionSummary();
      expect(summary.decisionCount).toBe(0);
      expect(summary.sessionStart).toBe('2026-07-12T10:00:00.000Z');
    });

    it('tolerates a null currentSession in session-state.json', async () => {
      const dir = path.join(tempDir, '.aios');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'session-state.json'),
        JSON.stringify({ currentSession: null, lastAgent: null }),
      );

      const sm = new SessionMemory({ projectRoot: tempDir });
      const summary = await sm.getSessionSummary();
      expect(summary.sessionStart).toBeNull();
    });
  });
});
