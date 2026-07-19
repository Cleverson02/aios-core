/**
 * Tests for Context Budget Manager (Story WSB-3.1).
 *
 * Covers: zone boundaries, custom thresholds, bracket→zone mapping,
 * evaluate() actions + emitted events, zone-log.json append, and graceful
 * compression via a mocked EpicContextAccumulator.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Mocks ──────────────────────────────────────────────────────────────────
// EpicContextAccumulator is required lazily inside compress(); mock the whole
// module so we control buildAccumulatedContext without touching real state.
const mockBuild = jest.fn();
jest.mock('../../orchestration/epic-context-accumulator', () => ({
  EpicContextAccumulator: jest.fn().mockImplementation(() => ({
    buildAccumulatedContext: mockBuild,
  })),
  estimateTokens: (s) => (s ? Math.ceil(s.length / 3.5) : 0),
  CompressionLevel: {
    FULL_DETAIL: 'full_detail',
    METADATA_PLUS_FILES: 'metadata_plus_files',
    METADATA_ONLY: 'metadata_only',
  },
  TOKEN_LIMIT: 8000,
}));

// SessionState is loaded best-effort by compress(); stub it deterministically.
jest.mock('../../orchestration/session-state', () => ({
  SessionState: jest.fn().mockImplementation(() => ({
    state: null,
    loadSessionState: jest.fn().mockResolvedValue(null),
  })),
}));

const {
  ContextBudgetManager,
  Zone,
  calculateZone,
  BRACKET_TO_ZONE,
} = require('../context-budget-manager');

describe('ContextBudgetManager', () => {
  let tmpDir;
  let mgr;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-'));
    mgr = new ContextBudgetManager({ cwd: tmpDir });
    mockBuild.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // ── AC1: zone boundaries ──────────────────────────────────────────────────
  describe('zoneFor — exact boundaries (default 60/80)', () => {
    it('59.9% used → GREEN', () => {
      expect(mgr.zoneFor(59.9)).toBe(Zone.GREEN);
    });
    it('60% used → YELLOW (>= yellow)', () => {
      expect(mgr.zoneFor(60)).toBe(Zone.YELLOW);
    });
    it('79.9% used → YELLOW', () => {
      expect(mgr.zoneFor(79.9)).toBe(Zone.YELLOW);
    });
    it('80% used → RED (>= red)', () => {
      expect(mgr.zoneFor(80)).toBe(Zone.RED);
    });
    it('0% → GREEN and 100% → RED', () => {
      expect(mgr.zoneFor(0)).toBe(Zone.GREEN);
      expect(mgr.zoneFor(100)).toBe(Zone.RED);
    });
    it('non-numeric usage → RED (conservative)', () => {
      expect(mgr.zoneFor(NaN)).toBe(Zone.RED);
      expect(mgr.zoneFor(undefined)).toBe(Zone.RED);
    });
  });

  describe('custom thresholds', () => {
    it('honors {yellow: 50, red: 70}', () => {
      const custom = new ContextBudgetManager({ cwd: tmpDir, thresholds: { yellow: 50, red: 70 } });
      expect(custom.zoneFor(49.9)).toBe(Zone.GREEN);
      expect(custom.zoneFor(50)).toBe(Zone.YELLOW);
      expect(custom.zoneFor(69.9)).toBe(Zone.YELLOW);
      expect(custom.zoneFor(70)).toBe(Zone.RED);
    });

    it('calculateZone standalone respects overrides', () => {
      expect(calculateZone(65, { yellow: 70, red: 90 })).toBe(Zone.GREEN);
      expect(calculateZone(70, { yellow: 70, red: 90 })).toBe(Zone.YELLOW);
      expect(calculateZone(90, { yellow: 70, red: 90 })).toBe(Zone.RED);
    });
  });

  // ── AC3: bracket → zone ───────────────────────────────────────────────────
  describe('zoneFromBracket — SYNAPSE brackets', () => {
    it('FRESH → GREEN', () => {
      expect(mgr.zoneFromBracket('FRESH')).toBe(Zone.GREEN);
    });
    it('MODERATE → GREEN', () => {
      expect(mgr.zoneFromBracket('MODERATE')).toBe(Zone.GREEN);
    });
    it('DEPLETED → YELLOW', () => {
      expect(mgr.zoneFromBracket('DEPLETED')).toBe(Zone.YELLOW);
    });
    it('CRITICAL → RED', () => {
      expect(mgr.zoneFromBracket('CRITICAL')).toBe(Zone.RED);
    });
    it('unknown/invalid bracket → RED', () => {
      expect(mgr.zoneFromBracket('WHATEVER')).toBe(Zone.RED);
      expect(mgr.zoneFromBracket(null)).toBe(Zone.RED);
    });
    it('is case-insensitive', () => {
      expect(mgr.zoneFromBracket('fresh')).toBe(Zone.GREEN);
    });
    it('mapping table matches the four real brackets', () => {
      expect(BRACKET_TO_ZONE).toEqual({
        FRESH: Zone.GREEN,
        MODERATE: Zone.GREEN,
        DEPLETED: Zone.YELLOW,
        CRITICAL: Zone.RED,
      });
    });
  });

  // ── AC1/AC4: evaluate actions + events ────────────────────────────────────
  describe('evaluate — actions', () => {
    it('GREEN → continue', () => {
      const r = mgr.evaluate({ percentUsed: 10, storyId: 'S1' });
      expect(r.zone).toBe(Zone.GREEN);
      expect(r.action).toBe('continue');
      expect(r.recommendation).toMatch(/continue/i);
    });
    it('YELLOW → compress', () => {
      const r = mgr.evaluate({ percentUsed: 65, storyId: 'S1' });
      expect(r.zone).toBe(Zone.YELLOW);
      expect(r.action).toBe('compress');
    });
    it('RED → handoff', () => {
      const r = mgr.evaluate({ percentUsed: 90, storyId: 'S1' });
      expect(r.zone).toBe(Zone.RED);
      expect(r.action).toBe('handoff');
    });
    it('accepts a bracket when percentUsed is absent', () => {
      const r = mgr.evaluate({ bracket: 'CRITICAL', storyId: 'S1' });
      expect(r.zone).toBe(Zone.RED);
      expect(r.action).toBe('handoff');
    });
    it('percentUsed wins over bracket when both provided', () => {
      const r = mgr.evaluate({ percentUsed: 10, bracket: 'CRITICAL', storyId: 'S1' });
      expect(r.zone).toBe(Zone.GREEN);
    });
  });

  describe('evaluate — events', () => {
    it('emits zone_changed on the first evaluation (from null)', () => {
      const spy = jest.fn();
      mgr.on('zone_changed', spy);
      mgr.evaluate({ percentUsed: 10, storyId: 'S1' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ from: null, to: Zone.GREEN, storyId: 'S1' });
    });

    it('does not re-emit zone_changed when zone is unchanged', () => {
      const spy = jest.fn();
      mgr.on('zone_changed', spy);
      mgr.evaluate({ percentUsed: 10, storyId: 'S1' });
      mgr.evaluate({ percentUsed: 20, storyId: 'S1' }); // still GREEN
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits compress_triggered on YELLOW', () => {
      const spy = jest.fn();
      mgr.on('compress_triggered', spy);
      mgr.evaluate({ percentUsed: 65, storyId: 'S1' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ zone: Zone.YELLOW, storyId: 'S1' });
    });

    it('emits handoff_recommended on RED', () => {
      const spy = jest.fn();
      mgr.on('handoff_recommended', spy);
      mgr.evaluate({ percentUsed: 90, storyId: 'S1' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ zone: Zone.RED });
    });

    it('tracks zone state per storyId independently', () => {
      const spy = jest.fn();
      mgr.on('zone_changed', spy);
      mgr.evaluate({ percentUsed: 10, storyId: 'A' }); // A: null→GREEN
      mgr.evaluate({ percentUsed: 90, storyId: 'B' }); // B: null→RED
      expect(spy).toHaveBeenCalledTimes(2);
      expect(mgr.getState('A').zone).toBe(Zone.GREEN);
      expect(mgr.getState('B').zone).toBe(Zone.RED);
    });
  });

  // ── AC1/AC6: getState ─────────────────────────────────────────────────────
  describe('getState', () => {
    it('returns null before any evaluation', () => {
      expect(mgr.getState('S1')).toBeNull();
    });
    it('returns the last known zone/percent', () => {
      mgr.evaluate({ percentUsed: 72.5, storyId: 'S1', epicId: 'E1' });
      expect(mgr.getState('S1')).toMatchObject({
        zone: Zone.YELLOW,
        percentUsed: 72.5,
        epicId: 'E1',
      });
    });
  });

  // ── AC4: zone-log.json append ─────────────────────────────────────────────
  describe('zone-log.json', () => {
    const logRelPath = path.join('.aios', 'autonomy', 'zone-log.json');

    it('appends an array entry per transition (2 transitions)', () => {
      mgr.evaluate({ percentUsed: 10, storyId: 'S1' }); // null → GREEN (#1)
      mgr.evaluate({ percentUsed: 90, storyId: 'S1' }); // GREEN → RED (#2)

      const logFile = path.join(tmpDir, logRelPath);
      expect(fs.existsSync(logFile)).toBe(true);

      const entries = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toHaveLength(2);

      expect(entries[0]).toMatchObject({ storyId: 'S1', from: null, to: Zone.GREEN, percentUsed: 10 });
      expect(entries[1]).toMatchObject({ storyId: 'S1', from: Zone.GREEN, to: Zone.RED, percentUsed: 90 });
      expect(typeof entries[0].timestamp).toBe('string');
    });

    it('does not append when the zone is unchanged', () => {
      mgr.evaluate({ percentUsed: 10, storyId: 'S1' }); // #1
      mgr.evaluate({ percentUsed: 15, storyId: 'S1' }); // still GREEN, no append

      const entries = mgr.getZoneLog();
      expect(entries).toHaveLength(1);
    });

    it('creates the .aios/autonomy directory when missing', () => {
      expect(fs.existsSync(path.join(tmpDir, '.aios', 'autonomy'))).toBe(false);
      mgr.evaluate({ percentUsed: 90, storyId: 'S1' });
      expect(fs.existsSync(path.join(tmpDir, '.aios', 'autonomy'))).toBe(true);
    });
  });

  // ── AC2/AC5: compress ─────────────────────────────────────────────────────
  describe('compress', () => {
    it('returns {compressedContext, level, estimatedTokens} via the accumulator', async () => {
      mockBuild.mockReturnValue('Epic E1 Context: compressed summary of prior stories');
      const result = await mgr.compress({ epicId: 'E1', storyId: 'S1' });

      expect(result).not.toBeNull();
      expect(result.compressedContext).toContain('compressed');
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(['full_detail', 'metadata_plus_files', 'metadata_only']).toContain(result.level);
      expect(mockBuild).toHaveBeenCalled();
    });

    it('returns null (with warning) when the accumulator throws', async () => {
      mockBuild.mockImplementation(() => {
        throw new Error('accumulator boom');
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await mgr.compress({ epicId: 'E1', storyId: 'S1' });

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
