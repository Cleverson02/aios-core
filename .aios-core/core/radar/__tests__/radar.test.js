/**
 * AIOS Radar — test suite (Story WSB-5.1).
 *
 * Deterministic, ZERO real LLM / ZERO network. Covers:
 *   - each heuristic firing ONLY in its intended case (+ negative controls);
 *   - ranking by score;
 *   - absent sources → empty scan, no crash;
 *   - deterministic brief without any provider;
 *   - synthesizer: availability-gated skip + parsed brief with a mocked provider;
 *   - collectors light-parse of real fixture files;
 *   - scan persists and report reads it back.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const collectors = require('../collectors');
const heuristics = require('../heuristics');
const synthesizer = require('../synthesizer');
const cli = require('../cli');

const { analyze } = heuristics;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/** Fixed "now" so date-window heuristics are deterministic. */
const NOW = Date.parse('2026-07-19T00:00:00Z');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-'));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    /* ignore */
  }
}

/** Write a brain fixture (entities.json + manifest.json [+ chunks.json]) into brainDir. */
function writeBrain(brainDir, { entities, areas, indexAreas } = {}) {
  fs.mkdirSync(brainDir, { recursive: true });

  if (entities) {
    const map = {};
    for (const e of entities) map[e.id] = e;
    fs.writeFileSync(
      path.join(brainDir, 'entities.json'),
      JSON.stringify({ version: 1, entities: map }),
    );
  }

  if (areas) {
    const files = {};
    let n = 0;
    for (const [area, count] of Object.entries(areas)) {
      for (let i = 0; i < count; i++) {
        files[`/abs/${area}/file-${i}.md`] = { mtime: 1, size: 10, root: 'r', tier: 'projects', area };
      }
      n += count;
    }
    fs.writeFileSync(
      path.join(brainDir, 'manifest.json'),
      JSON.stringify({ version: 1, lastIndexed: '2026-07-18', files, total: n }),
    );

    if (indexAreas && indexAreas.length) {
      const chunks = {};
      indexAreas.forEach((area, i) => {
        chunks[`c${i}`] = { file: `${area}/_index.md`, area };
      });
      fs.writeFileSync(
        path.join(brainDir, 'chunks.json'),
        JSON.stringify({ version: 1, chunks }),
      );
    }
  }
}

/** Write a light digest markdown into <cwd>/docs/digests. */
function writeDigest(cwd, name, { date, story, entities = [], decisions = [] }) {
  const dir = path.join(cwd, 'docs', 'digests');
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---', `date: '${date}'`];
  if (story) fm.push(`story: ${story}`);
  if (entities.length) {
    fm.push('entities:');
    for (const e of entities) fm.push(`  - ${e}`);
  }
  fm.push('---', '');
  const body = ['## Resumo', '', 'x', '', '## Decisões', '', ...decisions.map((d) => `- ${d}`), ''];
  fs.writeFileSync(path.join(dir, name), [...fm, ...body].join('\n'));
}

/** Write a .aios/gotchas.json fixture. */
function writeGotchas(cwd, gotchas) {
  const dir = path.join(cwd, '.aios');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gotchas.json'), JSON.stringify({ version: '1', gotchas }));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HEURISTIC 3 — LATENT DEMAND
// ═══════════════════════════════════════════════════════════════════════════════════

describe('heuristics — latent-demand', () => {
  test('client with 8 mentions and NO project relation fires', () => {
    const collected = {
      entities: [
        { id: 'acme', name: 'Acme', type: 'client', mentions: 8, relations: [], sources: [] },
      ],
    };
    const findings = analyze(collected, { now: NOW });
    const latent = findings.filter((f) => f.type === 'latent-demand');
    expect(latent).toHaveLength(1);
    expect(latent[0].title).toContain('Acme');
    expect(latent[0].id).toBe('demanda-sem-projeto-acme');
  });

  test('client linked to a project does NOT fire', () => {
    const collected = {
      entities: [
        { id: 'acme', name: 'Acme', type: 'client', mentions: 8, relations: [{ type: 'has', target: 'proj' }], sources: [] },
        { id: 'proj', name: 'ProjX', type: 'project', mentions: 1, relations: [], sources: [] },
      ],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'latent-demand')).toHaveLength(0);
  });

  test('client below the mention threshold does NOT fire', () => {
    const collected = {
      entities: [{ id: 'acme', name: 'Acme', type: 'client', mentions: 4, relations: [], sources: [] }],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'latent-demand')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HEURISTIC 1 — AUTOMATION
// ═══════════════════════════════════════════════════════════════════════════════════

describe('heuristics — automation', () => {
  test('gotcha with occurrences >= 3 fires', () => {
    const collected = {
      gotchas: [{ id: 'g1', title: 'Erro X repetido', occurrences: 4, severity: 'high', category: 'build' }],
    };
    const auto = analyze(collected, { now: NOW }).filter((f) => f.type === 'automation');
    expect(auto).toHaveLength(1);
    expect(auto[0].title).toContain('Erro X repetido');
  });

  test('gotcha with occurrences < 3 does NOT fire', () => {
    const collected = {
      gotchas: [{ id: 'g1', title: 'Erro raro', occurrences: 2, severity: 'info', category: 'build' }],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'automation')).toHaveLength(0);
  });

  test('same decision across >= 2 digests fires', () => {
    const collected = {
      digests: [
        { file: 'a.md', date: '2026-07-18', decisions: ['Rodar deploy manual'] },
        { file: 'b.md', date: '2026-07-17', decisions: ['Rodar deploy manual'] },
      ],
    };
    const auto = analyze(collected, { now: NOW }).filter((f) => f.type === 'automation');
    expect(auto).toHaveLength(1);
    expect(auto[0].title).toContain('Rodar deploy manual');
  });

  test('a decision in a single digest does NOT fire', () => {
    const collected = {
      digests: [{ file: 'a.md', date: '2026-07-18', decisions: ['Decisão única'] }],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'automation')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HEURISTIC 2 — UNDERUSED ASSET
// ═══════════════════════════════════════════════════════════════════════════════════

describe('heuristics — underused-asset', () => {
  test('area with many files and no recent digest mention fires', () => {
    const collected = {
      brainStats: { areas: { marketing: { files: 12, hasIndex: true } } },
      digests: [{ file: 'a.md', date: '2026-07-18', decisions: ['algo sobre vendas'], entities: [] }],
    };
    const under = analyze(collected, { now: NOW }).filter((f) => f.type === 'underused-asset');
    expect(under).toHaveLength(1);
    expect(under[0].area).toBe('marketing');
  });

  test('area mentioned in a recent digest does NOT fire', () => {
    const collected = {
      brainStats: { areas: { marketing: { files: 12, hasIndex: true } } },
      digests: [{ file: 'a.md', date: '2026-07-18', decisions: ['revisar marketing Q3'], entities: [] }],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'underused-asset')).toHaveLength(0);
  });

  test('area below the file threshold does NOT fire', () => {
    const collected = {
      brainStats: { areas: { marketing: { files: 3, hasIndex: true } } },
      digests: [],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'underused-asset')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HEURISTIC 4 — PROCESS GAP
// ═══════════════════════════════════════════════════════════════════════════════════

describe('heuristics — process-gap', () => {
  test('area with files but no _index.md fires', () => {
    const collected = {
      brainStats: { areas: { juridico: { files: 5, hasIndex: false } } },
      // mention it in a digest so underused-asset does NOT also fire
      digests: [{ file: 'a.md', date: '2026-07-18', decisions: ['nota juridico'], entities: [] }],
    };
    const gaps = analyze(collected, { now: NOW }).filter((f) => f.type === 'process-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].area).toBe('juridico');
  });

  test('>= 3 decisions about the same area within 30 days fires', () => {
    const collected = {
      brainStats: { areas: { vendas: { files: 2, hasIndex: true } } },
      digests: [
        { file: 'a.md', date: '2026-07-18', decisions: ['ajuste em vendas'], entities: [] },
        { file: 'b.md', date: '2026-07-17', decisions: ['novo fluxo de vendas'], entities: [] },
        { file: 'c.md', date: '2026-07-16', decisions: ['meta de vendas'], entities: [] },
      ],
    };
    const gaps = analyze(collected, { now: NOW }).filter((f) => f.type === 'process-gap');
    expect(gaps.some((g) => g.area === 'vendas')).toBe(true);
  });

  test('decisions outside the 30-day window do NOT fire the count branch', () => {
    const collected = {
      brainStats: { areas: { vendas: { files: 2, hasIndex: true } } },
      digests: [
        { file: 'a.md', date: '2026-01-01', decisions: ['ajuste em vendas'], entities: [] },
        { file: 'b.md', date: '2026-01-02', decisions: ['novo fluxo de vendas'], entities: [] },
        { file: 'c.md', date: '2026-01-03', decisions: ['meta de vendas'], entities: [] },
      ],
    };
    expect(analyze(collected, { now: NOW }).filter((f) => f.type === 'process-gap')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RANKING + EMPTY
// ═══════════════════════════════════════════════════════════════════════════════════

describe('heuristics — ranking + empty sources', () => {
  test('findings are ordered by score desc (latent-demand outranks underused)', () => {
    const collected = {
      entities: [{ id: 'acme', name: 'Acme', type: 'client', mentions: 9, relations: [], sources: [] }],
      brainStats: { areas: { marketing: { files: 20, hasIndex: true } } },
      digests: [],
    };
    const findings = analyze(collected, { now: NOW });
    expect(findings.length).toBeGreaterThanOrEqual(2);
    // scores must be non-increasing
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i - 1].score).toBeGreaterThanOrEqual(findings[i].score);
    }
    expect(findings[0].type).toBe('latent-demand'); // 5/2 = 2.5 is the top score
  });

  test('all sources null → empty findings, no crash', () => {
    expect(analyze({})).toEqual([]);
    expect(analyze(null)).toEqual([]);
    expect(analyze({ entities: null, digests: null, gotchas: null, brainStats: null })).toEqual([]);
  });

  test('stable ids are slugs of the title', () => {
    const collected = { entities: [{ id: 'x', name: 'Café Brasil', type: 'product', mentions: 6, relations: [], sources: [] }] };
    const f = analyze(collected, { now: NOW })[0];
    expect(f.id).toBe('demanda-sem-projeto-cafe-brasil');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              COLLECTORS
// ═══════════════════════════════════════════════════════════════════════════════════

describe('collectors', () => {
  let cwd;
  let brainDir;

  beforeEach(() => {
    cwd = makeTmp();
    brainDir = path.join(cwd, 'brain');
  });
  afterEach(() => rmTmp(cwd));

  test('collect on an empty workspace returns all-null sources without crashing', async () => {
    const snapshot = await collectors.collect({ cwd, brainDir });
    expect(snapshot.entities).toBeNull();
    expect(snapshot.digests).toBeNull();
    expect(snapshot.gotchas).toBeNull();
    expect(snapshot.brainStats).toBeNull();
    expect(snapshot.activity).toBeNull();
  });

  test('collect reads entities, digests, gotchas and per-area brain stats', async () => {
    writeBrain(brainDir, {
      entities: [
        { id: 'acme', name: 'Acme', type: 'client', sources: [{ file: 'a', mentions: 5 }, { file: 'b', mentions: 3 }], relations: [] },
      ],
      areas: { marketing: 12, juridico: 4 },
      indexAreas: ['juridico'],
    });
    writeDigest(cwd, '2026-07-18-x.md', {
      date: '2026-07-18',
      story: 'WSB-9',
      entities: ['Acme'],
      decisions: ['Rodar deploy manual', 'Outra decisão'],
    });
    writeGotchas(cwd, [{ id: 'g1', title: 'Erro repetido', occurrences: 4, severity: 'high', category: 'build' }]);

    const snapshot = await collectors.collect({ cwd, brainDir });

    expect(snapshot.entities).toHaveLength(1);
    expect(snapshot.entities[0].mentions).toBe(8); // 5 + 3

    expect(snapshot.digests).toHaveLength(1);
    expect(snapshot.digests[0].date).toBe('2026-07-18');
    expect(snapshot.digests[0].decisions).toEqual(['Rodar deploy manual', 'Outra decisão']);

    expect(snapshot.gotchas).toHaveLength(1);
    expect(snapshot.gotchas[0].occurrences).toBe(4);

    expect(snapshot.brainStats.areas.marketing.files).toBe(12);
    expect(snapshot.brainStats.areas.marketing.hasIndex).toBe(false);
    expect(snapshot.brainStats.areas.juridico.hasIndex).toBe(true);
  });

  test('gotchas without an occurrences field default to 1 (schema-tolerant)', () => {
    writeGotchas(cwd, [{ id: 'g1', title: 'Legado', severity: 'high' }]);
    const gotchas = collectors.collectGotchas(cwd);
    expect(gotchas[0].occurrences).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SYNTHESIZER (mocked — no network/LLM)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('synthesizer', () => {
  const finding = {
    id: 'demanda-sem-projeto-acme',
    type: 'latent-demand',
    title: 'Demanda sem projeto: Acme',
    evidence: ['client mencionado 8x', 'sem relação com project'],
    area: null,
    effort: 2,
    impact: 5,
    score: 2.5,
  };

  test('no provider available → skipped, findings untouched (zero LLM by default)', async () => {
    const result = await synthesizer.synthesize([finding], {
      availability: () => ({ providers: { xai: { available: false }, anthropic: { available: false } } }),
    });
    expect(result.skipped).toBe(true);
    expect(result.briefs).toEqual([]);
    expect(result.reason).toMatch(/provider/i);
  });

  test('providers module absent → skipped gracefully', async () => {
    const result = await synthesizer.synthesize([finding], { availability: 'not-a-function' });
    expect(result.skipped).toBe(true);
  });

  test('with a mocked available provider → brief parsed from markers', async () => {
    const calls = [];
    const result = await synthesizer.synthesize([finding], {
      availability: () => ({ providers: { xai: { available: true } } }),
      router: { route: () => ({ model: 'grok-4-5', provider: 'xai' }) },
      factory: {
        getProvider: (name) => {
          calls.push(name);
          return {
            executeWithRetry: async () => ({
              output: 'CONTEXTO: Acme aparece muito.\nOPORTUNIDADE: Abrir um projeto.\nPRÓXIMO PASSO: Criar entidade project.',
            }),
          };
        },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.model).toBe('grok-4-5');
    expect(calls).toEqual(['grok']); // xai → grok factory mapping
    expect(result.briefs[0]).toEqual({
      id: 'demanda-sem-projeto-acme',
      context: 'Acme aparece muito.',
      opportunity: 'Abrir um projeto.',
      nextStep: 'Criar entidade project.',
    });
  });

  test('a failing brief does not drop the others', async () => {
    let n = 0;
    const two = [finding, { ...finding, id: 'second', title: 'Segundo' }];
    const result = await synthesizer.synthesize(two, {
      topN: 2,
      availability: () => ({ providers: { xai: { available: true } } }),
      router: { route: () => ({ model: 'grok-4-5', provider: 'xai' }) },
      factory: {
        getProvider: () => ({
          executeWithRetry: async () => {
            n += 1;
            if (n === 1) throw new Error('boom');
            return { output: 'CONTEXTO: ok\nOPORTUNIDADE: ok\nPRÓXIMO PASSO: ok' };
          },
        }),
      },
    });
    expect(result.briefs).toHaveLength(2);
    expect(result.briefs[0].error).toBeTruthy();
    expect(result.briefs[1].context).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CLI — scan persists, report reads, brief deterministic
// ═══════════════════════════════════════════════════════════════════════════════════

describe('cli — radarCommand', () => {
  let cwd;
  let logSpy;

  beforeEach(() => {
    cwd = makeTmp();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmTmp(cwd);
  });

  test('scan on an empty workspace writes an empty scan without crashing', async () => {
    const code = await cli.radarCommand(['scan'], { cwd });
    expect(code).toBe(0);
    const scan = cli.readLatestScan(cwd);
    expect(scan).not.toBeNull();
    expect(scan.findings).toEqual([]);
  });

  test('scan detects a gotcha-driven finding, then report reads the persisted scan', async () => {
    writeGotchas(cwd, [{ id: 'g1', title: 'Deploy manual repetido', occurrences: 5, severity: 'high', category: 'build' }]);

    const scanCode = await cli.radarCommand(['scan'], { cwd });
    expect(scanCode).toBe(0);

    const scan = cli.readLatestScan(cwd);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0].type).toBe('automation');
    expect(scan.counts.automation).toBe(1);

    // a scan file physically exists under .aios/radar
    const radarDir = path.join(cwd, '.aios', 'radar');
    expect(fs.readdirSync(radarDir).some((n) => /^scan-.*\.json$/.test(n))).toBe(true);

    const reportCode = await cli.radarCommand(['report'], { cwd });
    expect(reportCode).toBe(0);
  });

  test('a second scan on the same day does not overwrite the first', async () => {
    writeGotchas(cwd, [{ id: 'g1', title: 'X', occurrences: 5, severity: 'high', category: 'build' }]);
    await cli.radarCommand(['scan'], { cwd });
    await cli.radarCommand(['scan'], { cwd });
    const files = fs.readdirSync(path.join(cwd, '.aios', 'radar')).filter((n) => n.endsWith('.json'));
    expect(files.length).toBe(2);
  });

  test('brief prints a deterministic project brief WITHOUT any provider', async () => {
    writeGotchas(cwd, [{ id: 'g1', title: 'Deploy manual repetido', occurrences: 5, severity: 'high', category: 'build' }]);
    await cli.radarCommand(['scan'], { cwd });
    const scan = cli.readLatestScan(cwd);
    const id = scan.findings[0].id;

    const output = [];
    logSpy.mockImplementation((...a) => output.push(a.join(' ')));

    const code = await cli.radarCommand(['brief', id], { cwd });
    expect(code).toBe(0);
    const joined = output.join('\n');
    expect(joined).toMatch(/Project Brief/);
    expect(joined).toMatch(/Próximo passo sugerido/);
  });

  test('brief --with-llm uses the injected synthesizer', async () => {
    writeGotchas(cwd, [{ id: 'g1', title: 'Deploy manual repetido', occurrences: 5, severity: 'high', category: 'build' }]);
    await cli.radarCommand(['scan'], { cwd });
    const scan = cli.readLatestScan(cwd);
    const id = scan.findings[0].id;

    let received = null;
    const fakeSynthesize = async (findings, opts) => {
      received = { findings, opts };
      return {
        skipped: false,
        model: 'grok-4-5',
        provider: 'xai',
        briefs: [{ id, context: 'c', opportunity: 'o', nextStep: 'n' }],
      };
    };

    const code = await cli.radarCommand(['brief', id, '--with-llm'], { cwd, synthesize: fakeSynthesize });
    expect(code).toBe(0);
    expect(received.findings[0].id).toBe(id);
  });

  test('brief with an unknown id is a friendly error', async () => {
    const code = await cli.radarCommand(['brief', 'nope'], { cwd });
    expect(code).toBe(1);
  });
});
