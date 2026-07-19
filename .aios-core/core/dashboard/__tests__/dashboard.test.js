/**
 * Tests — Dashboard Server (Story WSB-4.7).
 *
 * Boots the real HTTP server on an ephemeral port (port 0) against fixture
 * project roots in os.tmpdir(), then exercises every endpoint with the native
 * `fetch` (Node 18+). No browser is ever launched.
 *
 * Coverage:
 *   - bind is EXACTLY 127.0.0.1 (AC3)
 *   - / returns self-contained HTML containing "AIOX Cortex"
 *   - /api/costs matches telemetry/report.aggregate byte-for-byte
 *   - /api/costs?by=day groups
 *   - /api/agents active + recent shapes
 *   - /api/builds builds + zones + handoffs + pending escalations
 *     (a `.md` with a sibling `.decision.json` is NOT pending)
 *   - /api/telemetry raw calls, newest-first
 *   - /api/health shape
 *   - empty project → 200 with empty arrays, never a crash (AC5)
 *   - unknown route → 404 JSON
 *   - no CORS header is emitted (AC3)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDashboardServer } = require('../server');
const { aggregate } = require('../../telemetry/report');

// ───────────────────────────────────────────────────────────── fixtures ──

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wsb47-dash-'));
}

function writeLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** A fully-populated project root touching every data source. */
function fullFixture() {
  const cwd = makeTmpDir();

  // usage.jsonl — 3 calls, in append order (oldest at top, newest at bottom).
  // costUsd is read directly by aggregate.
  writeLines(path.join(cwd, '.aios', 'telemetry', 'usage.jsonl'), [
    { ts: iso(3000), provider: 'claude', model: 'claude-haiku', inputTokens: 500, outputTokens: 100, cachedInputTokens: 100, costUsd: 0.005, agent: 'dev', storyId: 'WSB-4.6', estimated: false },
    { ts: iso(2000), provider: 'grok', model: 'grok-2', inputTokens: 2000, outputTokens: 400, cachedInputTokens: 0, costUsd: 0.02, agent: 'qa', storyId: 'WSB-4.7', estimated: true },
    { ts: iso(1000), provider: 'claude', model: 'claude-sonnet', inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500, costUsd: 0.01, agent: 'dev', storyId: 'WSB-4.7', estimated: false },
  ]);

  // activity.jsonl — 2 agents inside the 15min window.
  writeLines(path.join(cwd, '.aios', 'telemetry', 'activity.jsonl'), [
    { ts: iso(1000), agent: 'dev', action: 'develop-story', storyId: 'WSB-4.7', project: 'aios-core' },
    { ts: iso(500), agent: 'qa', action: 'review', storyId: 'WSB-4.7', project: 'aios-core' },
  ]);

  // zone-log.json — 2 transitions.
  writeJson(path.join(cwd, '.aios', 'autonomy', 'zone-log.json'), [
    { timestamp: iso(4000), storyId: 'WSB-4.7', from: null, to: 'GREEN', percentUsed: 10 },
    { timestamp: iso(2000), storyId: 'WSB-4.7', from: 'GREEN', to: 'YELLOW', percentUsed: 65 },
  ]);

  // handoffs — one packet twin.
  writeJson(path.join(cwd, '.aios', 'autonomy', 'handoffs', 'WSB-4.7-1.json'), { storyId: 'WSB-4.7', sequence: 1 });
  fs.writeFileSync(path.join(cwd, '.aios', 'autonomy', 'handoffs', 'WSB-4.7-1.md'), '# Handoff', 'utf8');

  // escalations — one PENDING (no decision) + one RESOLVED (has decision).
  const escDir = path.join(cwd, '.aios', 'autonomy', 'escalations');
  fs.mkdirSync(escDir, { recursive: true });
  fs.writeFileSync(path.join(escDir, '2026-07-19T00-00-00-000Z-stuck.md'), '# Escalação: stuck\n', 'utf8');
  fs.writeFileSync(path.join(escDir, '2026-07-18T00-00-00-000Z-red-zone.md'), '# Escalação: red-zone\n', 'utf8');
  writeJson(path.join(escDir, '2026-07-18T00-00-00-000Z-red-zone.decision.json'), { decision: 'skip' });

  // build state — root plan/build-state.json.
  writeJson(path.join(cwd, 'plan', 'build-state.json'), {
    storyId: 'WSB-4.7',
    status: 'in_progress',
    startedAt: iso(100000),
    lastCheckpoint: iso(50000),
    currentPhase: 'implement',
    currentSubtask: '4.7.2',
    completedSubtasks: ['4.7.1'],
    failedAttempts: [],
    checkpoints: [{ id: 'cp-1', timestamp: iso(50000), subtaskId: '4.7.1', status: 'completed', metrics: { duration: 1000, attempts: 1 } }],
    notifications: [],
    metrics: { totalSubtasks: 3, completedSubtasks: 1, totalAttempts: 2, totalFailures: 0, averageTimePerSubtask: 1000, totalDuration: 0 },
    worktree: null,
  });

  return cwd;
}

// ───────────────────────────────────────────────────────── harness ──

async function withServer(cwd, fn) {
  const dashboard = createDashboardServer({ cwd, port: 0 });
  const info = await dashboard.start();
  const base = `http://127.0.0.1:${info.port}`;
  try {
    return await fn(base, dashboard, info);
  } finally {
    await dashboard.stop();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                              BIND / HEALTH
// ═══════════════════════════════════════════════════════════════════════════

describe('bind + health', () => {
  test('binds EXACTLY to 127.0.0.1 (never 0.0.0.0)', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (_base, dashboard, info) => {
      const addr = dashboard.server.address();
      expect(addr.address).toBe('127.0.0.1');
      expect(info.host).toBe('127.0.0.1');
      expect(dashboard.port).toBe(info.port);
      expect(info.port).toBeGreaterThan(0);
    });
  });

  test('GET /api/health returns ok + identity', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');
      expect(body.cwd).toBe(cwd);
      expect(typeof body.uptime).toBe('number');
    });
  });

  test('does NOT emit a CORS header (local-only)', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/api/health`);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              STATIC SPA
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /', () => {
  test('serves self-contained HTML containing "AIOX Cortex"', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('AIOX Cortex');
      expect(html).toContain('<!doctype html>');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              COSTS
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/costs', () => {
  test('by=provider matches telemetry/report.aggregate exactly', async () => {
    const cwd = fullFixture();
    const expected = await aggregate({ cwd, groupBy: 'provider', since: '7d' });
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/api/costs?by=provider&since=7d`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.by).toBe('provider');
      expect(body.since).toBe('7d');
      expect(body.groups).toEqual(expected.groups);
      expect(body.totals).toEqual(expected.totals);
      // Sanity on the fixture math.
      expect(body.totals.calls).toBe(3);
      expect(body.totals.costUsd).toBeCloseTo(0.035, 6);
    });
  });

  test('by=day produces day-keyed groups', async () => {
    const cwd = fullFixture();
    await withServer(cwd, async (base) => {
      const body = await (await fetch(`${base}/api/costs?by=day&since=7d`)).json();
      expect(body.by).toBe('day');
      expect(body.groups.length).toBeGreaterThanOrEqual(1);
      expect(body.groups[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  test('invalid by falls back to provider', async () => {
    const cwd = fullFixture();
    await withServer(cwd, async (base) => {
      const body = await (await fetch(`${base}/api/costs?by=bogus`)).json();
      expect(body.by).toBe('provider');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              AGENTS
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/agents', () => {
  test('returns active agents + newest-first recent activity', async () => {
    const cwd = fullFixture();
    await withServer(cwd, async (base) => {
      const body = await (await fetch(`${base}/api/agents`)).json();
      expect(Array.isArray(body.active)).toBe(true);
      expect(body.active.length).toBe(2);
      expect(body.active.map((a) => a.agent).sort()).toEqual(['dev', 'qa']);
      expect(body.recent.length).toBe(2);
      // Newest first: qa (500ms ago) precedes dev (1000ms ago).
      expect(body.recent[0].agent).toBe('qa');
      expect(body.windowMs).toBe(15 * 60 * 1000);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              BUILDS
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/builds', () => {
  test('returns builds, zones, handoffs and ONLY pending escalations', async () => {
    const cwd = fullFixture();
    await withServer(cwd, async (base) => {
      const body = await (await fetch(`${base}/api/builds`)).json();

      // Build state surfaced via BuildStateManager.
      expect(body.builds.length).toBeGreaterThanOrEqual(1);
      const build = body.builds.find((b) => b.storyId === 'WSB-4.7');
      expect(build).toBeTruthy();
      expect(build.progress.total).toBe(3);
      expect(build.progress.completed).toBe(1);

      // Zone transitions (newest-first).
      expect(body.zones.length).toBe(2);
      expect(body.zones[0].to).toBe('YELLOW');

      // Handoffs.
      expect(body.handoffs.length).toBe(1);
      expect(body.handoffs[0].name).toBe('WSB-4.7-1.json');
      expect(body.handoffs[0].storyId).toBe('WSB-4.7');

      // Only the escalation without a .decision.json sibling is pending.
      expect(body.escalations.length).toBe(1);
      expect(body.escalations[0].name).toBe('2026-07-19T00-00-00-000Z-stuck.md');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/telemetry', () => {
  test('returns raw usage rows, newest-first', async () => {
    const cwd = fullFixture();
    await withServer(cwd, async (base) => {
      const body = await (await fetch(`${base}/api/telemetry?limit=100`)).json();
      expect(body.count).toBe(3);
      expect(body.calls.length).toBe(3);
      // Newest-first: the last-written line (500ms/1000ms ago) leads.
      expect(body.calls[0].provider).toBe('claude');
      expect(body.calls[0].model).toBe('claude-sonnet');
      expect(body.calls[body.calls.length - 1].model).toBe('claude-haiku');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              EMPTY STATES (AC5)
// ═══════════════════════════════════════════════════════════════════════════

describe('empty project (no data)', () => {
  test('every endpoint returns 200 with empty collections — never crashes', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (base) => {
      const costs = await (await fetch(`${base}/api/costs`)).json();
      expect(costs.groups).toEqual([]);
      expect(costs.totals.calls).toBe(0);

      const agents = await (await fetch(`${base}/api/agents`)).json();
      expect(agents.active).toEqual([]);
      expect(agents.recent).toEqual([]);

      const builds = await (await fetch(`${base}/api/builds`)).json();
      expect(builds.builds).toEqual([]);
      expect(builds.zones).toEqual([]);
      expect(builds.handoffs).toEqual([]);
      expect(builds.escalations).toEqual([]);

      const telemetry = await (await fetch(`${base}/api/telemetry`)).json();
      expect(telemetry.calls).toEqual([]);
      expect(telemetry.count).toBe(0);
    });
  });

  test('corrupt zone-log does not crash /api/builds', async () => {
    const cwd = makeTmpDir();
    fs.mkdirSync(path.join(cwd, '.aios', 'autonomy'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.aios', 'autonomy', 'zone-log.json'), '{ this is not json', 'utf8');
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/api/builds`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.zones).toEqual([]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//                              ROUTING
// ═══════════════════════════════════════════════════════════════════════════

describe('routing', () => {
  test('unknown route → 404 JSON', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/api/nope`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(typeof body.error).toBe('string');
    });
  });

  test('non-GET method → 404 JSON', async () => {
    const cwd = makeTmpDir();
    await withServer(cwd, async (base) => {
      const res = await fetch(`${base}/api/health`, { method: 'POST' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
    });
  });
});
