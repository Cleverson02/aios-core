'use strict';

/**
 * Tests — AIOS Routines (Story WSB-5.2).
 *
 * Safety rails:
 * - Every test runs against a throwaway `cwd` (mkdtemp), so `.aios/*` writes never
 *   touch the developer's tree.
 * - Handlers are injected into the exported `TASK_HANDLERS` map so runs never hit
 *   the real brain/radar/gateway modules; the map is restored after each test.
 *
 * Coverage: nextRunAt (daily/weekly/monthly incl. month rollover + monthly@31
 * February clamp); defaults created on first load; enable/disable persists;
 * manual run writes state; catch-up (lastRunAt 3 days ago → 1 run on first tick);
 * tick fires the right handler; Telegram notify graceful without a token.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const yaml = require('js-yaml');

const registry = require('../registry');
const scheduler = require('../scheduler');
const { nextRunAt } = scheduler;

// ───────────────────────────────────────────────────────────────────────────
//                              FIXTURE HELPERS
// ───────────────────────────────────────────────────────────────────────────

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wsb52-'));
}

/** Local-time Date builder mirroring the scheduler's own `at()`. */
function at(y, mo, d, h, mi) {
  return new Date(y, mo, d, h, mi, 0, 0);
}

let ORIGINAL_HANDLERS;

beforeEach(() => {
  ORIGINAL_HANDLERS = { ...scheduler.TASK_HANDLERS };
});

afterEach(() => {
  // Restore the handler map (tests mutate it to inject doubles).
  for (const key of Object.keys(scheduler.TASK_HANDLERS)) delete scheduler.TASK_HANDLERS[key];
  Object.assign(scheduler.TASK_HANDLERS, ORIGINAL_HANDLERS);
  jest.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
//                              nextRunAt — DAILY
// ───────────────────────────────────────────────────────────────────────────

describe('nextRunAt — daily', () => {
  test('same day when the slot is still ahead', () => {
    const from = at(2025, 0, 10, 1, 0); // Jan 10 01:00
    expect(nextRunAt('daily@03:00', from)).toEqual(at(2025, 0, 10, 3, 0));
  });

  test('next day when the slot already passed', () => {
    const from = at(2025, 0, 10, 4, 0); // Jan 10 04:00
    expect(nextRunAt('daily@03:00', from)).toEqual(at(2025, 0, 11, 3, 0));
  });

  test('rolls over the end of the month', () => {
    const from = at(2025, 0, 31, 23, 30); // Jan 31 23:30
    expect(nextRunAt('daily@03:00', from)).toEqual(at(2025, 1, 1, 3, 0)); // Feb 1 03:00
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              nextRunAt — WEEKLY
// ───────────────────────────────────────────────────────────────────────────

describe('nextRunAt — weekly', () => {
  test('next Monday from a mid-week reference', () => {
    // 2025-01-08 is a Wednesday.
    const from = at(2025, 0, 8, 10, 0);
    // Next Monday is 2025-01-13.
    expect(nextRunAt('weekly@mon 09:00', from)).toEqual(at(2025, 0, 13, 9, 0));
  });

  test('same weekday but before the time → today', () => {
    // 2025-01-13 is a Monday.
    const from = at(2025, 0, 13, 8, 0);
    expect(nextRunAt('weekly@mon 09:00', from)).toEqual(at(2025, 0, 13, 9, 0));
  });

  test('same weekday but after the time → +7 days', () => {
    const from = at(2025, 0, 13, 10, 0); // Monday after 09:00
    expect(nextRunAt('weekly@mon 09:00', from)).toEqual(at(2025, 0, 20, 9, 0));
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              nextRunAt — MONTHLY
// ───────────────────────────────────────────────────────────────────────────

describe('nextRunAt — monthly', () => {
  test('this month when the day is still ahead', () => {
    const from = at(2025, 0, 5, 12, 0); // Jan 5
    expect(nextRunAt('monthly@15 09:00', from)).toEqual(at(2025, 0, 15, 9, 0));
  });

  test('rolls to next month once the day passed', () => {
    const from = at(2025, 0, 20, 12, 0); // Jan 20
    expect(nextRunAt('monthly@15 09:00', from)).toEqual(at(2025, 1, 15, 9, 0));
  });

  test('monthly@31 clamps to the last day of February (non-leap)', () => {
    const from = at(2025, 1, 10, 12, 0); // Feb 10 2025 (28-day month)
    expect(nextRunAt('monthly@31 09:00', from)).toEqual(at(2025, 1, 28, 9, 0));
  });

  test('monthly@31 clamps to Feb 29 on a leap year', () => {
    const from = at(2024, 1, 10, 12, 0); // Feb 10 2024 (leap year)
    expect(nextRunAt('monthly@31 09:00', from)).toEqual(at(2024, 1, 29, 9, 0));
  });

  test('monthly@31 rolls Jan 31 → Feb clamp when already past', () => {
    const from = at(2025, 0, 31, 10, 0); // Jan 31 after 09:00
    expect(nextRunAt('monthly@31 09:00', from)).toEqual(at(2025, 1, 28, 9, 0));
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              REGISTRY — DEFAULTS
// ───────────────────────────────────────────────────────────────────────────

describe('registry defaults', () => {
  test('first load creates the AC1 defaults and persists the file', () => {
    const cwd = tmpCwd();
    const file = path.join(cwd, '.aios', 'routines.yaml');
    expect(fs.existsSync(file)).toBe(false);

    const routines = registry.loadRoutines({ cwd });
    expect(fs.existsSync(file)).toBe(true);

    const byName = Object.fromEntries(routines.map((r) => [r.name, r]));
    expect(byName['brain-index']).toMatchObject({
      task: 'brain-index', schedule: 'daily@03:00', notify: 'none', enabled: false,
    });
    expect(byName['brain-digest']).toMatchObject({
      task: 'brain-digest', schedule: 'daily@18:00', notify: 'none', enabled: true,
    });
    expect(byName['radar-scan']).toMatchObject({
      task: 'radar-scan', schedule: 'weekly@mon 09:00', notify: 'telegram', enabled: true,
    });

    // Persisted content round-trips.
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
    expect(parsed.routines).toHaveLength(3);
  });

  test('invalid schedule throws a clear error on load', () => {
    const cwd = tmpCwd();
    fs.mkdirSync(path.join(cwd, '.aios'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.aios', 'routines.yaml'),
      yaml.dump({ version: 1, routines: [{ name: 'bad', task: 'brain-index', schedule: 'hourly@99:99' }] }),
    );
    expect(() => registry.loadRoutines({ cwd })).toThrow(/inválido/i);
  });

  test('setEnabled persists across loads', () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });

    registry.setEnabled({ cwd, name: 'brain-index', enabled: true });
    expect(registry.getRoutine({ cwd, name: 'brain-index' }).enabled).toBe(true);

    // Fresh load from disk reflects the change.
    const reloaded = registry.loadRoutines({ cwd });
    expect(reloaded.find((r) => r.name === 'brain-index').enabled).toBe(true);

    registry.setEnabled({ cwd, name: 'brain-digest', enabled: false });
    expect(registry.getRoutine({ cwd, name: 'brain-digest' }).enabled).toBe(false);
  });

  test('setEnabled on an unknown routine throws', () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    expect(() => registry.setEnabled({ cwd, name: 'nope', enabled: true })).toThrow(/desconhecida/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              RUN — STATE + LOG
// ───────────────────────────────────────────────────────────────────────────

describe('runRoutine', () => {
  test('manual run executes the handler and writes state + log', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });

    const handler = jest.fn(async () => ({ ok: true, summary: 'indexado' }));
    scheduler.TASK_HANDLERS['brain-index'] = handler;

    const result = await scheduler.runRoutine('brain-index', { cwd });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ name: 'brain-index', ok: true, summary: 'indexado' });

    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.aios', 'routines-state.json'), 'utf8'));
    expect(state['brain-index'].lastRunAt).toBeTruthy();
    expect(state['brain-index'].lastResult).toMatchObject({ ok: true, summary: 'indexado' });

    const log = fs.readFileSync(path.join(cwd, '.aios', 'routines', 'log.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"run"/);
  });

  test('unknown routine returns a graceful failure (no throw)', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    const result = await scheduler.runRoutine('ghost', { cwd });
    expect(result).toMatchObject({ ok: false, reason: 'unknown-routine' });
  });

  test('handler failure is captured, not thrown', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    scheduler.TASK_HANDLERS['brain-index'] = jest.fn(async () => {
      throw new Error('boom');
    });
    const result = await scheduler.runRoutine('brain-index', { cwd });
    expect(result).toMatchObject({ ok: false, reason: 'boom' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              NOTIFY — GRACEFUL
// ───────────────────────────────────────────────────────────────────────────

describe('telegram notify', () => {
  test('notify:telegram delivers via gateway, gracefully with no token', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });

    // Mock the gateway so no real Telegram/network is touched.
    const gateway = require('../../gateway');
    const spy = jest
      .spyOn(gateway, 'notifyTelegram')
      .mockResolvedValue({ notified: false, reason: 'no-token', count: 0 });

    scheduler.TASK_HANDLERS['radar-scan'] = jest.fn(async () => ({ ok: true, summary: '3 achados' }));

    // radar-scan default routine has notify:telegram.
    const result = await scheduler.runRoutine('radar-scan', { cwd });
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    expect(arg.title).toContain('radar-scan');
    expect(arg.body).toContain('3 achados');

    // Graceful: a no-token delivery is logged, never thrown.
    const log = fs.readFileSync(path.join(cwd, '.aios', 'routines', 'log.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"notify"/);
    expect(log).toMatch(/no-token/);
  });

  test('notify:none does not call the gateway', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    const gateway = require('../../gateway');
    const spy = jest.spyOn(gateway, 'notifyTelegram').mockResolvedValue({ notified: false });

    scheduler.TASK_HANDLERS['brain-digest'] = jest.fn(async () => ({ ok: true, summary: 'digest' }));
    await scheduler.runRoutine('brain-digest', { cwd });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              TICK / CATCH-UP
// ───────────────────────────────────────────────────────────────────────────

describe('runDueRoutines — tick + catch-up', () => {
  test('a routine last run 3 days ago runs exactly once on the first tick', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    registry.setEnabled({ cwd, name: 'brain-index', enabled: true }); // daily@03:00

    // Seed state: last run 3 days ago.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(
      path.join(cwd, '.aios', 'routines-state.json'),
      JSON.stringify({ 'brain-index': { lastRunAt: threeDaysAgo } }),
    );

    const handler = jest.fn(async () => ({ ok: true, summary: 'ok' }));
    scheduler.TASK_HANDLERS['brain-index'] = handler;

    const first = await scheduler.runDueRoutines({ cwd });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.find((r) => r.name === 'brain-index').due).toBe(true);

    // Second tick immediately after: lastRunAt is now → NOT due again (single catch-up).
    await scheduler.runDueRoutines({ cwd });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('tick fires only the due routine, and the right handler', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    // Only brain-index enabled; make it clearly due by seeding an old lastRunAt.
    registry.setEnabled({ cwd, name: 'brain-index', enabled: true });
    registry.setEnabled({ cwd, name: 'radar-scan', enabled: false });
    registry.setEnabled({ cwd, name: 'brain-digest', enabled: false });

    fs.writeFileSync(
      path.join(cwd, '.aios', 'routines-state.json'),
      JSON.stringify({ 'brain-index': { lastRunAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() } }),
    );

    const indexH = jest.fn(async () => ({ ok: true, summary: 'idx' }));
    const digestH = jest.fn(async () => ({ ok: true, summary: 'dig' }));
    scheduler.TASK_HANDLERS['brain-index'] = indexH;
    scheduler.TASK_HANDLERS['brain-digest'] = digestH;

    await scheduler.runDueRoutines({ cwd });
    expect(indexH).toHaveBeenCalledTimes(1);
    expect(digestH).not.toHaveBeenCalled();
  });

  test('freshly created routine does not fire immediately (ref = createdAt)', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    registry.setEnabled({ cwd, name: 'brain-index', enabled: true });

    const handler = jest.fn(async () => ({ ok: true }));
    scheduler.TASK_HANDLERS['brain-index'] = handler;

    // No state seeded → ref is createdAt (now); daily@03:00 is in the future.
    await scheduler.runDueRoutines({ cwd });
    expect(handler).not.toHaveBeenCalled();
  });

  test('startScheduler exposes a tick controller and stops cleanly', async () => {
    const cwd = tmpCwd();
    registry.loadRoutines({ cwd });
    registry.setEnabled({ cwd, name: 'brain-index', enabled: true });
    fs.writeFileSync(
      path.join(cwd, '.aios', 'routines-state.json'),
      JSON.stringify({ 'brain-index': { lastRunAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() } }),
    );
    const handler = jest.fn(async () => ({ ok: true }));
    scheduler.TASK_HANDLERS['brain-index'] = handler;

    const controller = scheduler.startScheduler({ cwd, intervalMs: 999999, immediate: false });
    await controller.tick();
    controller.stop();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
