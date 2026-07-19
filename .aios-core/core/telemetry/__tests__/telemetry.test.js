/**
 * @fileoverview Tests for the deterministic token & cost telemetry (Story WSB-4.5).
 *
 * Covers: cost math (with/without cache), model-without-pricing → null cost,
 * every groupBy dimension, `since` filtering, streaming a large synthetic file
 * with a corrupt line, estimated-flag propagation, agent activity + active-agent
 * window, and the ai-provider hook (real usage + telemetry-never-breaks-exec).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  recordUsage,
  recordAgentActivity,
  estimateTokens,
  computeCost,
} = require('../ledger');
const { aggregate, getActiveAgents, parseSince } = require('../report');
const { costsCommand } = require('../cli');
const telemetryBarrel = require('../index');
const { AIProvider } = require('../../../infrastructure/integrations/ai-providers/ai-provider');

/** Create a fresh temp project root. */
function makeCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wsb45-'));
}

/** Absolute path to usage.jsonl under a cwd. */
function usagePath(cwd) {
  return path.join(cwd, '.aios', 'telemetry', 'usage.jsonl');
}

/** Absolute path to activity.jsonl under a cwd. */
function activityPath(cwd) {
  return path.join(cwd, '.aios', 'telemetry', 'activity.jsonl');
}

/** Write raw JSONL lines (records already stringified or objects). */
function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records
    .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
    .join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

describe('estimateTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens(null)).toBe(0);
  });
});

describe('computeCost', () => {
  it('returns null without pricing', () => {
    expect(
      computeCost(
        { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 },
        null,
      ),
    ).toBeNull();
  });

  it('computes cost including cache (hand-verified)', () => {
    // grok-4-5 pricing: in 2, out 6, cached 0.5, write 2.5 (USD / Mtok)
    const pricing = {
      input_per_mtok: 2,
      output_per_mtok: 6,
      cached_input_per_mtok: 0.5,
      cache_write_per_mtok: 2.5,
    };
    // (1000*2 + 500*6 + 200*0.5 + 100*2.5) / 1e6 = 5350 / 1e6 = 0.00535
    const cost = computeCost(
      { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, cacheWriteTokens: 100 },
      pricing,
    );
    expect(cost).toBeCloseTo(0.00535, 10);
  });
});

describe('recordUsage', () => {
  it('appends a JSONL line with cost from the matrix (grok-4-5)', () => {
    const cwd = makeCwd();
    const rec = recordUsage(
      {
        provider: 'grok',
        model: 'grok-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 200,
        cacheWriteTokens: 100,
        agent: 'dev',
        source: 'test',
      },
      { cwd },
    );

    expect(rec.costUsd).toBeCloseTo(0.00535, 10);
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const lines = fs.readFileSync(usagePath(cwd), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.provider).toBe('grok');
    expect(parsed.costUsd).toBeCloseTo(0.00535, 10);
  });

  it('records tokens with costUsd null for a model without pricing', () => {
    const cwd = makeCwd();
    const rec = recordUsage(
      { provider: 'mystery', model: 'no-such-model', inputTokens: 999, outputTokens: 1 },
      { cwd },
    );
    expect(rec.costUsd).toBeNull();
    expect(rec.inputTokens).toBe(999);
  });

  it('flags estimated records', () => {
    const cwd = makeCwd();
    const rec = recordUsage(
      { provider: 'claude', model: 'claude-opus-4-8', inputTokens: 10, estimated: true },
      { cwd },
    );
    expect(rec.estimated).toBe(true);
  });
});

describe('aggregate — groupBy dimensions', () => {
  let cwd;

  beforeEach(() => {
    cwd = makeCwd();
    writeJsonl(usagePath(cwd), [
      {
        ts: '2026-07-10T10:00:00.000Z',
        provider: 'grok',
        model: 'grok-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 100,
        costUsd: 0.005,
        agent: 'dev',
        storyId: 'WSB-4.5',
        project: 'aios',
        estimated: false,
      },
      {
        ts: '2026-07-11T10:00:00.000Z',
        provider: 'grok',
        model: 'grok-4-5',
        inputTokens: 2000,
        outputTokens: 1000,
        cachedInputTokens: 0,
        costUsd: 0.01,
        agent: 'qa',
        storyId: 'WSB-4.5',
        project: 'aios',
        estimated: true,
      },
      {
        ts: '2026-07-12T10:00:00.000Z',
        provider: 'claude',
        model: 'claude-opus-4-8',
        inputTokens: 500,
        outputTokens: 100,
        cachedInputTokens: 0,
        costUsd: 0.02,
        agent: 'dev',
        storyId: 'WSB-4.6',
        project: 'aios',
        estimated: false,
      },
    ]);
  });

  it('groups by provider', async () => {
    const { groups, totals } = await aggregate({ cwd, groupBy: 'provider' });
    const grok = groups.find((g) => g.key === 'grok');
    expect(grok.calls).toBe(2);
    expect(grok.inputTokens).toBe(3000);
    expect(grok.costUsd).toBeCloseTo(0.015, 10);
    expect(grok.estimatedPct).toBeCloseTo(50, 6);
    expect(totals.calls).toBe(3);
    expect(totals.costUsd).toBeCloseTo(0.035, 10);
  });

  it('groups by model', async () => {
    const { groups } = await aggregate({ cwd, groupBy: 'model' });
    expect(groups.map((g) => g.key).sort()).toEqual(['claude-opus-4-8', 'grok-4-5']);
  });

  it('groups by agent', async () => {
    const { groups } = await aggregate({ cwd, groupBy: 'agent' });
    const dev = groups.find((g) => g.key === 'dev');
    expect(dev.calls).toBe(2);
  });

  it('groups by storyId', async () => {
    const { groups } = await aggregate({ cwd, groupBy: 'storyId' });
    const s = groups.find((g) => g.key === 'WSB-4.5');
    expect(s.calls).toBe(2);
  });

  it('groups by project', async () => {
    const { groups } = await aggregate({ cwd, groupBy: 'project' });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('aios');
    expect(groups[0].calls).toBe(3);
  });

  it('groups by day', async () => {
    const { groups } = await aggregate({ cwd, groupBy: 'day' });
    expect(groups.map((g) => g.key).sort()).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ]);
  });

  it('falls back to provider for an unknown groupBy', async () => {
    const { groups } = await aggregate({ cwd, groupBy: 'bogus' });
    expect(groups.some((g) => g.key === 'grok')).toBe(true);
  });
});

describe('aggregate — since filtering', () => {
  it('filters records older than the since bound', async () => {
    const cwd = makeCwd();
    const now = Date.parse('2026-07-19T12:00:00.000Z');
    writeJsonl(usagePath(cwd), [
      { ts: '2026-07-01T00:00:00.000Z', provider: 'grok', inputTokens: 1, costUsd: 0.1 },
      { ts: '2026-07-18T00:00:00.000Z', provider: 'grok', inputTokens: 1, costUsd: 0.2 },
    ]);

    const recent = await aggregate({ cwd, since: '7d', now });
    expect(recent.totals.calls).toBe(1);
    expect(recent.totals.costUsd).toBeCloseTo(0.2, 10);

    const all = await aggregate({ cwd, since: null, now });
    expect(all.totals.calls).toBe(2);
  });

  it('parseSince understands d/h/m and ISO', () => {
    const now = 1_000_000_000_000;
    expect(parseSince('7d', now)).toBe(now - 7 * 86400000);
    expect(parseSince('24h', now)).toBe(now - 24 * 3600000);
    expect(parseSince('30m', now)).toBe(now - 30 * 60000);
    expect(parseSince(null, now)).toBe(0);
    expect(parseSince('2026-07-01T00:00:00.000Z')).toBe(Date.parse('2026-07-01T00:00:00.000Z'));
  });
});

describe('aggregate — streaming a large synthetic file with a corrupt line', () => {
  it('reads 5k lines and skips the corrupt one', async () => {
    const cwd = makeCwd();
    const fp = usagePath(cwd);
    fs.mkdirSync(path.dirname(fp), { recursive: true });

    const lines = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(
        JSON.stringify({
          ts: '2026-07-15T10:00:00.000Z',
          provider: 'grok',
          model: 'grok-4-5',
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          costUsd: 0.001,
          estimated: false,
        }),
      );
    }
    lines.push('{ this is not valid json ]'); // 1 corrupt line
    fs.writeFileSync(fp, `${lines.join('\n')}\n`, 'utf8');

    const { totals } = await aggregate({ cwd, groupBy: 'provider' });
    expect(totals.calls).toBe(5000);
    expect(totals.inputTokens).toBe(50000);
    expect(totals.costUsd).toBeCloseTo(5, 6);
  });
});

describe('agent activity', () => {
  it('records activity and lists agents within the window', async () => {
    const cwd = makeCwd();
    const now = Date.parse('2026-07-19T12:00:00.000Z');

    // recent (2 min ago) + stale (20 min ago) written directly for time control
    writeJsonl(activityPath(cwd), [
      { ts: new Date(now - 2 * 60000).toISOString(), agent: 'dev', action: 'develop-story', storyId: 'WSB-4.5', project: 'aios' },
      { ts: new Date(now - 20 * 60000).toISOString(), agent: 'qa', action: 'review', storyId: 'WSB-4.4', project: 'aios' },
    ]);

    const active = await getActiveAgents({ cwd, windowMs: 15 * 60000, now });
    expect(active).toHaveLength(1);
    expect(active[0].agent).toBe('dev');
    expect(active[0].action).toBe('develop-story');
    expect(active[0].lastSeenMsAgo).toBe(2 * 60000);
  });

  it('recordAgentActivity appends to activity.jsonl', () => {
    const cwd = makeCwd();
    const rec = recordAgentActivity(
      { agent: 'dev', action: 'route', storyId: 'WSB-4.5', project: 'aios' },
      { cwd },
    );
    expect(rec.agent).toBe('dev');
    const lines = fs.readFileSync(activityPath(cwd), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).action).toBe('route');
  });
});

describe('costsCommand', () => {
  it('renders a table from a small fixture', async () => {
    const cwd = makeCwd();
    writeJsonl(usagePath(cwd), [
      { ts: '2026-07-18T10:00:00.000Z', provider: 'grok', model: 'grok-4-5', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, costUsd: 0.00535, estimated: false },
    ]);
    let out = '';
    await costsCommand(['summary'], { cwd, log: (s) => { out = s; } });
    expect(out).toContain('grok');
    expect(out).toContain('$0.0053');
    expect(out).toContain('TOTAL');
  });

  it('shows a friendly message when there is no data', async () => {
    const cwd = makeCwd();
    let out = '';
    await costsCommand(['summary'], { cwd, log: (s) => { out = s; } });
    expect(out).toMatch(/Nenhum dado/);
  });

  it('export --json prints parseable JSON', async () => {
    const cwd = makeCwd();
    writeJsonl(usagePath(cwd), [
      { ts: '2026-07-18T10:00:00.000Z', provider: 'grok', inputTokens: 10, costUsd: 0.01 },
    ]);
    let out = '';
    await costsCommand(['export', '--json'], { cwd, log: (s) => { out = s; } });
    const parsed = JSON.parse(out);
    expect(parsed.groupBy).toBe('provider');
    expect(parsed.totals.calls).toBe(1);
  });
});

describe('ai-provider telemetry hook', () => {
  class FakeProvider extends AIProvider {
    constructor(cfg = {}) {
      super({ name: 'grok', command: 'grok', maxRetries: 1, options: { model: 'grok-4-5' } });
      this._response = cfg.response;
      this._throw = cfg.throw;
    }

    async checkAvailability() {
      return true;
    }

    async execute() {
      if (this._throw) throw this._throw;
      return this._response;
    }
  }

  it('records normalized usage from a successful call', async () => {
    const cwd = makeCwd();
    const provider = new FakeProvider({
      response: {
        success: true,
        output: 'hello',
        metadata: {
          model: 'grok-4-5',
          usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } },
        },
      },
    });

    const res = await provider.executeWithRetry('a prompt', { cwd, agent: 'dev', storyId: 'WSB-4.5' });
    expect(res.success).toBe(true);

    const lines = fs.readFileSync(usagePath(cwd), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.source).toBe('ai-provider');
    expect(rec.provider).toBe('grok');
    expect(rec.inputTokens).toBe(1000);
    expect(rec.outputTokens).toBe(500);
    expect(rec.cachedInputTokens).toBe(200);
    expect(rec.agent).toBe('dev');
    expect(rec.costUsd).toBeCloseTo((1000 * 2 + 500 * 6 + 200 * 0.5) / 1e6, 10);
    expect(rec.estimated).toBe(false);
  });

  it('estimates tokens when the provider reports no usage', async () => {
    const cwd = makeCwd();
    const provider = new FakeProvider({
      response: { success: true, output: 'abcdefgh', metadata: { model: 'grok-4-5' } },
    });
    await provider.executeWithRetry('abcd', { cwd });
    const rec = JSON.parse(fs.readFileSync(usagePath(cwd), 'utf8').trim());
    expect(rec.estimated).toBe(true);
    expect(rec.inputTokens).toBe(1); // 'abcd' → 4 chars / 4
    expect(rec.outputTokens).toBe(2); // 'abcdefgh' → 8 chars / 4
  });

  it('never breaks execution when telemetry throws', async () => {
    const cwd = makeCwd();
    const spy = jest.spyOn(telemetryBarrel, 'recordUsage').mockImplementation(() => {
      throw new Error('boom');
    });

    const provider = new FakeProvider({
      response: { success: true, output: 'ok', metadata: { model: 'grok-4-5' } },
    });

    const res = await provider.executeWithRetry('x', { cwd });
    expect(res.success).toBe(true);
    expect(res.output).toBe('ok');

    spy.mockRestore();
  });
});
