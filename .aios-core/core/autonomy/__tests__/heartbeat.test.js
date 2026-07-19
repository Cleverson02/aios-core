/**
 * Tests — Heartbeat + Escalation (Story WSB-3.3)
 *
 * The fake build loop is a plain EventEmitter emitting the SAME real event
 * names as `execution/autonomous-build-loop.js` (`build_started`,
 * `subtask_completed`, `iteration_completed`, `subtask_failed`).
 *
 * @jest-environment node
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { Heartbeat, HeartbeatMonitor, DEFAULT_INTERVAL_SUBTASKS } = require('../heartbeat');
const { escalate, slugify } = require('../escalation');

/** Fake AutonomousBuildLoop — real event names, nothing else. */
class FakeBuildLoop extends EventEmitter {}

const createdDirs = [];
function tmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb33-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//                              HEARTBEAT — PULSE INTERVAL
// ═══════════════════════════════════════════════════════════════════════════

describe('Heartbeat — pulse interval', () => {
  test('emits `heartbeat` on the 2nd and 4th subtask when intervalSubtasks=2', () => {
    const cwd = tmpCwd();
    const hb = new Heartbeat({
      intervalSubtasks: 2,
      cwd,
      budgetManager: null,
      escalate: jest.fn(),
    });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    const pulses = [];
    hb.on('heartbeat', (p) => pulses.push(p));

    loop.emit('build_started', { storyId: 'WSB-3.3' });

    loop.emit('subtask_completed', { subtaskId: 's1' }); // counter 1
    expect(pulses).toHaveLength(0);

    loop.emit('subtask_completed', { subtaskId: 's2' }); // counter 2 → pulse
    expect(pulses).toHaveLength(1);
    expect(pulses[0].storyId).toBe('WSB-3.3');
    expect(pulses[0].subtasks).toBe(2);

    loop.emit('subtask_completed', { subtaskId: 's3' }); // counter 3
    loop.emit('subtask_completed', { subtaskId: 's4' }); // counter 4 → pulse
    expect(pulses).toHaveLength(2);
    expect(pulses[1].subtasks).toBe(4);
  });

  test('writes a heartbeat marker to .aios/autonomy/heartbeats.json', () => {
    const cwd = tmpCwd();
    const hb = new Heartbeat({ intervalSubtasks: 1, cwd, budgetManager: null, escalate: jest.fn() });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    loop.emit('build_started', { storyId: 'WSB-3.3' });
    loop.emit('subtask_completed', { subtaskId: 's1' });

    const markerPath = path.join(cwd, '.aios', 'autonomy', 'heartbeats.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(doc.storyId).toBe('WSB-3.3');
    expect(Array.isArray(doc.heartbeats)).toBe(true);
    expect(doc.heartbeats[0]).toMatchObject({ storyId: 'WSB-3.3', subtasks: 1, subtaskId: 's1' });
  });

  test('default interval is 3', () => {
    const hb = new Heartbeat();
    expect(hb.intervalSubtasks).toBe(DEFAULT_INTERVAL_SUBTASKS);
    expect(DEFAULT_INTERVAL_SUBTASKS).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              HEARTBEAT — STUCK DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Heartbeat — stuck detection', () => {
  test('same subtask failing twice escalates exactly once with the right context', () => {
    const cwd = tmpCwd();
    const escalateSpy = jest.fn().mockResolvedValue({ notified: false });
    const hb = new Heartbeat({ intervalSubtasks: 3, cwd, budgetManager: null, escalate: escalateSpy });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    const stuck = [];
    hb.on('stuck_detected', (e) => stuck.push(e));

    loop.emit('build_started', { storyId: 'WSB-3.3' });

    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 1, success: false, error: 'boom' });
    expect(escalateSpy).not.toHaveBeenCalled();

    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 2, success: false, error: 'boom2' });
    expect(escalateSpy).toHaveBeenCalledTimes(1);

    const arg = escalateSpy.mock.calls[0][0];
    expect(arg.reason).toBe('stuck');
    expect(arg.cwd).toBe(cwd);
    expect(arg.context).toMatchObject({
      subtaskId: 's1',
      attempts: 2,
      lastError: 'boom2',
      storyId: 'WSB-3.3',
    });

    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ subtaskId: 's1', attempts: 2 });

    // A third failure on the same subtask must NOT escalate again.
    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 3, success: false, error: 'boom3' });
    expect(escalateSpy).toHaveBeenCalledTimes(1);
  });

  test('different subtasks failing once each does NOT escalate', () => {
    const cwd = tmpCwd();
    const escalateSpy = jest.fn();
    const hb = new Heartbeat({ intervalSubtasks: 3, cwd, budgetManager: null, escalate: escalateSpy });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    loop.emit('build_started', { storyId: 'WSB-3.3' });
    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 1, success: false, error: 'e1' });
    loop.emit('iteration_completed', { subtaskId: 's2', iteration: 1, success: false, error: 'e2' });
    loop.emit('iteration_completed', { subtaskId: 's3', iteration: 1, success: false, error: 'e3' });

    expect(escalateSpy).not.toHaveBeenCalled();
    expect(hb.getStats().failing).toBe(3);
  });

  test('a successful completion resets the failure counter for that subtask', () => {
    const cwd = tmpCwd();
    const escalateSpy = jest.fn();
    const hb = new Heartbeat({ intervalSubtasks: 99, cwd, budgetManager: null, escalate: escalateSpy });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    loop.emit('build_started', { storyId: 'WSB-3.3' });
    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 1, success: false, error: 'e1' });
    loop.emit('subtask_completed', { subtaskId: 's1' }); // recovered → reset
    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 1, success: false, error: 'e2' });

    expect(escalateSpy).not.toHaveBeenCalled();
  });

  test('successful (success:true) iterations never count as failures', () => {
    const cwd = tmpCwd();
    const escalateSpy = jest.fn();
    const hb = new Heartbeat({ intervalSubtasks: 99, cwd, budgetManager: null, escalate: escalateSpy });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    loop.emit('build_started', { storyId: 'WSB-3.3' });
    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 1, success: true });
    loop.emit('iteration_completed', { subtaskId: 's1', iteration: 2, success: true });

    expect(escalateSpy).not.toHaveBeenCalled();
    expect(hb.getStats().failing).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              HEARTBEAT — NEVER DERAILS THE BUILD (AC4)
// ═══════════════════════════════════════════════════════════════════════════

describe('Heartbeat — resilience (AC4)', () => {
  test('a throwing escalate handler is swallowed and does not break the build loop', () => {
    const cwd = tmpCwd();
    const throwingEscalate = jest.fn(() => {
      throw new Error('escalate exploded');
    });
    const hb = new Heartbeat({ intervalSubtasks: 3, cwd, budgetManager: null, escalate: throwingEscalate });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    // A separate observer on the SAME event must still run after the heartbeat.
    const other = jest.fn();
    loop.on('iteration_completed', other);

    expect(() => {
      loop.emit('iteration_completed', { subtaskId: 's1', iteration: 1, success: false, error: 'x' });
      loop.emit('iteration_completed', { subtaskId: 's1', iteration: 2, success: false, error: 'y' });
    }).not.toThrow();

    expect(throwingEscalate).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2); // build loop unaffected
  });

  test('a throwing budgetManager during a pulse is swallowed (zone null)', () => {
    const cwd = tmpCwd();
    const boomBudget = {
      evaluate: jest.fn(() => {
        throw new Error('budget exploded');
      }),
    };
    const hb = new Heartbeat({ intervalSubtasks: 1, cwd, budgetManager: boomBudget, escalate: jest.fn() });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    const pulses = [];
    hb.on('heartbeat', (p) => pulses.push(p));

    expect(() => {
      loop.emit('build_started', { storyId: 'X' });
      loop.emit('subtask_completed', { subtaskId: 's1', percentUsed: 90 });
    }).not.toThrow();

    expect(pulses).toHaveLength(1);
    expect(pulses[0].zone).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              HEARTBEAT — ZONE ASSESSMENT & LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe('Heartbeat — zone assessment and lifecycle', () => {
  test('evaluates the context zone via budgetManager when a percent signal is present', () => {
    const cwd = tmpCwd();
    const fakeBudget = {
      evaluate: jest.fn(({ percentUsed }) => ({
        zone: percentUsed > 80 ? 'RED' : 'GREEN',
        percentUsed,
      })),
    };
    const hb = new Heartbeat({ intervalSubtasks: 1, cwd, budgetManager: fakeBudget, escalate: jest.fn() });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    const pulses = [];
    hb.on('heartbeat', (p) => pulses.push(p));

    loop.emit('build_started', { storyId: 'X' });
    loop.emit('subtask_completed', { subtaskId: 's1', percentUsed: 85 });
    expect(fakeBudget.evaluate).toHaveBeenCalledWith({ percentUsed: 85 });
    expect(pulses[0].zone).toEqual({ zone: 'RED', percentUsed: 85 });

    // No percent signal → zone evaluation is skipped.
    loop.emit('subtask_completed', { subtaskId: 's2' });
    expect(pulses[1].zone).toBeNull();
  });

  test('detach() stops the heartbeat from reacting to further events', () => {
    const cwd = tmpCwd();
    const hb = new Heartbeat({ intervalSubtasks: 1, cwd, budgetManager: null, escalate: jest.fn() });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    loop.emit('build_started', { storyId: 'X' });
    loop.emit('subtask_completed', { subtaskId: 's1' });
    expect(hb.getStats().subtasks).toBe(1);

    hb.detach();
    loop.emit('subtask_completed', { subtaskId: 's2' });
    expect(hb.getStats().subtasks).toBe(1); // unchanged
  });

  test('subtask_failed (terminal) is re-surfaced but does not drive stuck detection', () => {
    const cwd = tmpCwd();
    const escalateSpy = jest.fn();
    const hb = new Heartbeat({ intervalSubtasks: 3, cwd, budgetManager: null, escalate: escalateSpy });
    const loop = new FakeBuildLoop();
    hb.attach(loop);

    const terminal = [];
    hb.on('subtask_terminal_failure', (e) => terminal.push(e));

    loop.emit('build_started', { storyId: 'X' });
    loop.emit('subtask_failed', { subtaskId: 's1', attempts: 10, error: 'gave up' });

    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ subtaskId: 's1', attempts: 10 });
    expect(escalateSpy).not.toHaveBeenCalled();
  });

  test('HeartbeatMonitor is exported as a back-compat alias of Heartbeat', () => {
    expect(HeartbeatMonitor).toBe(Heartbeat);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              ESCALATION
// ═══════════════════════════════════════════════════════════════════════════

describe('escalation.escalate', () => {
  test('ALWAYS writes an actionable record under .aios/autonomy/escalations/', async () => {
    const cwd = tmpCwd();
    const res = await escalate({
      reason: 'stuck',
      context: { subtaskId: 's1', attempts: 2, lastError: 'boom', storyId: 'WSB-3.3' },
      cwd,
      notifier: null, // skip notification
      surfaceChecker: null, // skip surface check
    });

    expect(res.filePath).toContain(path.join('.aios', 'autonomy', 'escalations'));
    expect(res.filePath.endsWith('-stuck.md')).toBe(true);
    expect(fs.existsSync(res.filePath)).toBe(true);
    expect(res.notified).toBe(false);
    expect(res.surface).toBeNull();

    const content = fs.readFileSync(res.filePath, 'utf8');
    expect(content).toContain('# Escalação: stuck');
    expect(content).toContain('WSB-3.3'); // story
    expect(content).toContain('s1'); // subtask
    expect(content).toContain('**Tentativas:** 2'); // attempts
    expect(content).toContain('boom'); // last error
    expect(content).toContain('Próximas ações sugeridas'); // suggested actions
  });

  test('returns {notified:false} gracefully when the notification channel is unavailable', async () => {
    const cwd = tmpCwd();
    const throwingNotifier = {
      sendBlockingNotification: jest.fn(async () => {
        throw new Error('channel down');
      }),
    };

    const res = await escalate({
      reason: 'stuck',
      context: { subtaskId: 's1', storyId: 'X' },
      cwd,
      notifier: throwingNotifier,
      surfaceChecker: null,
    });

    expect(res.notified).toBe(false);
    expect(res.channel).toBeNull();
    // File is written even when delivery fails (AC4).
    expect(fs.existsSync(res.filePath)).toBe(true);
  });

  test('reports {notified:true, channel} when the notifier succeeds', async () => {
    const cwd = tmpCwd();
    const okNotifier = {
      sendBlockingNotification: jest.fn(async () => ({
        success: true,
        notificationId: 'notif-1',
        channels: { console: { success: true }, file: { success: true } },
      })),
    };

    const res = await escalate({
      reason: 'stuck',
      context: { subtaskId: 's1', attempts: 2, lastError: 'boom', storyId: 'X' },
      cwd,
      notifier: okNotifier,
      surfaceChecker: null,
    });

    expect(okNotifier.sendBlockingNotification).toHaveBeenCalledTimes(1);
    expect(res.notified).toBe(true);
    expect(res.channel).toContain('file');

    const content = fs.readFileSync(res.filePath, 'utf8');
    expect(content).toContain('**Notificado:** sim');
  });

  test('includes the surface-check result when an injected checker triggers', async () => {
    const cwd = tmpCwd();
    const fakeChecker = {
      shouldSurface: jest.fn(() => ({
        should_surface: true,
        criterion_id: 'C004',
        criterion_name: 'Consecutive Errors',
        severity: 'error',
        message: 'Preciso de ajuda para continuar.',
      })),
    };

    const res = await escalate({
      reason: 'stuck',
      context: { subtaskId: 's1', attempts: 2, lastError: 'boom', storyId: 'X' },
      cwd,
      notifier: null,
      surfaceChecker: fakeChecker,
    });

    expect(fakeChecker.shouldSurface).toHaveBeenCalledTimes(1);
    const passedCtx = fakeChecker.shouldSurface.mock.calls[0][0];
    expect(passedCtx.errors_in_task).toBe(2); // mapped from attempts (C004)
    expect(passedCtx.error_summary).toBe('boom');

    expect(res.surface).toMatchObject({ should_surface: true, criterion_id: 'C004' });
    const content = fs.readFileSync(res.filePath, 'utf8');
    expect(content).toContain('C004');
  });

  test('real bob-surface-criteria.yaml trips C004 for a stuck subtask (2 errors)', async () => {
    const cwd = tmpCwd();
    // surfaceChecker undefined → the real SurfaceChecker loads the real YAML.
    const res = await escalate({
      reason: 'stuck',
      context: { subtaskId: 's1', attempts: 2, lastError: 'boom', storyId: 'X' },
      cwd,
      notifier: null,
    });

    expect(res.surface).not.toBeNull();
    expect(res.surface.should_surface).toBe(true);
    expect(res.surface.criterion_id).toBe('C004');
  });

  test('slugify produces filesystem-safe, non-empty slugs', () => {
    expect(slugify('stuck')).toBe('stuck');
    expect(slugify('Subtask s1 travou 2x!')).toBe('subtask-s1-travou-2x');
    expect(slugify('///')).toBe('escalation');
  });
});
