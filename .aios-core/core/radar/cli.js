#!/usr/bin/env node

/**
 * AIOS Radar — CLI (`aios radar …`)
 *
 * Story: WSB-5.1 - Radar de Oportunidades
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Subcommands:
 *   - scan              → collect + analyze, persist `.aios/radar/scan-<date>.json`
 *                         (never overwrites: `-2`, `-3`, …); prints a per-type count.
 *   - report [--top N]  → read the most recent scan (runs a scan if none exists) and
 *                         print the ranked findings with evidence + effort/impact.
 *   - brief <id> [--with-llm]
 *                       → print a deterministic project-brief for a finding id;
 *                         `--with-llm` additionally enriches it via the synthesizer
 *                         (only if a provider is available — otherwise a friendly note).
 *
 * Wiring `aios radar` into bin/aios.js is done by the lead — this module only
 * exposes `radarCommand(args)`.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const chalk = require('chalk');

const { collect } = require('./collectors');
const { analyze, RULES } = require('./heuristics');
const { synthesize } = require('./synthesizer');

/** `.aios/radar` relative directory holding persisted scans. */
const RADAR_RELDIR = path.join('.aios', 'radar');

/** Human labels per finding type (for printing). */
const TYPE_LABELS = {
  automation: 'Automação',
  'underused-asset': 'Ativo subaproveitado',
  'latent-demand': 'Demanda latente',
  'process-gap': 'Processo a formalizar',
};

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC — COMMAND ROUTER
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `aios radar <scan|report|brief> [...]`.
 *
 * @param {string[]} [args] - Arguments after `radar`.
 * @param {Object} [deps] - Injectable deps for testing (`cwd`, `synthesize`).
 * @returns {Promise<number>} Process-style exit code.
 */
async function radarCommand(args = [], deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const { positionals, flags } = parseArgs(args);
  const sub = positionals[0] || 'report';

  try {
    switch (sub) {
      case 'scan':
        return await runScan({ cwd });
      case 'report':
        return await runReport({ cwd, top: toInt(flags.top) });
      case 'brief':
        return await runBrief({
          cwd,
          id: positionals[1],
          withLlm: Boolean(flags['with-llm']),
          synthesizeFn: deps.synthesize,
        });
      default:
        console.log(chalk.red(`Subcomando desconhecido: ${sub}`));
        console.log(chalk.dim('Use: aios radar <scan|report|brief>'));
        return 1;
    }
  } catch (err) {
    console.log(chalk.red(`Falha no radar: ${err instanceof Error ? err.message : err}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SCAN
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Run collect + analyze, persist the scan and print a per-type count.
 *
 * @param {Object} params
 * @param {string} params.cwd - Workspace root.
 * @returns {Promise<number>}
 */
async function runScan({ cwd }) {
  const { scan, filePath } = await performScan(cwd);

  console.log(chalk.cyan('🛰  Radar scan concluído'));
  console.log(chalk.dim(`  Salvo em: ${path.relative(cwd, filePath)}`));
  console.log(chalk.dim(`  Fontes: ${describeSources(scan.sources)}`));
  printCounts(scan.counts, scan.findings.length);

  if (!scan.findings.length) {
    console.log('');
    printEmptyGuidance(scan.sources);
  }
  return 0;
}

/**
 * Collect, analyze and persist a scan. Shared by `scan` and by `report`/`brief`
 * when no prior scan exists.
 *
 * @param {string} cwd - Workspace root.
 * @returns {Promise<{scan: Object, filePath: string}>}
 */
async function performScan(cwd) {
  const collected = await collect({ cwd });
  const findings = analyze(collected);

  const counts = {};
  for (const type of Object.keys(RULES)) counts[type] = 0;
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;

  const scan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    date: formatDate(new Date()),
    cwd,
    sources: summarizeSources(collected),
    counts,
    findings,
  };

  const filePath = resolveScanPath(cwd, scan.date);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(scan, null, 2)}\n`);

  return { scan, filePath };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              REPORT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Print the ranked findings from the most recent scan (scanning first if needed).
 *
 * @param {Object} params
 * @param {string} params.cwd - Workspace root.
 * @param {number} [params.top] - Max findings to print.
 * @returns {Promise<number>}
 */
async function runReport({ cwd, top }) {
  let scan = readLatestScan(cwd);
  if (!scan) {
    console.log(chalk.dim('Nenhum scan encontrado — rodando `radar scan`…'));
    scan = (await performScan(cwd)).scan;
  }

  const limit = Number.isFinite(top) && top > 0 ? top : scan.findings.length;
  const findings = scan.findings.slice(0, limit);

  console.log(chalk.cyan(`🛰  Radar de Oportunidades — ${scan.date}`));
  console.log(chalk.dim(`  Fontes: ${describeSources(scan.sources)}`));
  printCounts(scan.counts, scan.findings.length);
  console.log('');

  if (!findings.length) {
    printEmptyGuidance(scan.sources);
    return 0;
  }

  findings.forEach((f, i) => printFinding(f, i + 1));
  console.log(chalk.dim('\nGere um brief: aios radar brief <id> [--with-llm]'));
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              BRIEF
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Print a deterministic project-brief for one finding; optionally enrich via LLM.
 *
 * @param {Object} params
 * @param {string} params.cwd - Workspace root.
 * @param {string} params.id - Finding id.
 * @param {boolean} params.withLlm - Whether to attempt LLM synthesis.
 * @param {Function} [params.synthesizeFn] - Injectable synthesizer (tests).
 * @returns {Promise<number>}
 */
async function runBrief({ cwd, id, withLlm, synthesizeFn }) {
  if (!id) {
    console.log(chalk.red('Informe o id do finding: aios radar brief <id>'));
    console.log(chalk.dim('Veja os ids em: aios radar report'));
    return 1;
  }

  let scan = readLatestScan(cwd);
  if (!scan) {
    console.log(chalk.dim('Nenhum scan encontrado — rodando `radar scan`…'));
    scan = (await performScan(cwd)).scan;
  }

  const finding = scan.findings.find((f) => f.id === id);
  if (!finding) {
    console.log(chalk.red(`Finding "${id}" não encontrado no scan mais recente.`));
    console.log(chalk.dim('Veja os ids disponíveis em: aios radar report'));
    return 1;
  }

  printDeterministicBrief(finding);

  if (!withLlm) {
    console.log(chalk.dim('\nDica: use --with-llm para uma síntese narrativa (requer provider).'));
    return 0;
  }

  const runSynthesize = synthesizeFn || synthesize;
  const result = await runSynthesize([finding], { cwd, topN: 1 });

  console.log('');
  if (result.skipped) {
    console.log(chalk.yellow(`⚠ Síntese LLM ignorada: ${result.reason}`));
    console.log(chalk.dim('  O brief determinístico acima permanece válido.'));
    return 0;
  }

  const brief = (result.briefs || []).find((b) => b.id === finding.id) || result.briefs[0];
  console.log(chalk.cyan(`🤖 Síntese LLM (${result.model} / ${result.provider}):`));
  if (!brief || brief.error) {
    console.log(chalk.yellow(`  ${(brief && brief.error) || 'Sem brief gerado.'}`));
    return 0;
  }
  if (brief.context) console.log(`  Contexto: ${brief.context}`);
  if (brief.opportunity) console.log(`  Oportunidade: ${brief.opportunity}`);
  if (brief.nextStep) console.log(`  Próximo passo: ${brief.nextStep}`);
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PRINTING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Print the per-type counts line.
 *
 * @param {Object} counts - Type → count.
 * @param {number} total - Total findings.
 */
function printCounts(counts, total) {
  const parts = Object.keys(RULES).map(
    (type) => `${TYPE_LABELS[type]}: ${counts[type] || 0}`,
  );
  console.log(chalk.bold(`  ${total} oportunidade(s)`) + chalk.dim(` — ${parts.join(' | ')}`));
}

/**
 * Print a single ranked finding block.
 *
 * @param {Object} f - Finding.
 * @param {number} rankNum - 1-based rank.
 */
function printFinding(f, rankNum) {
  console.log(
    chalk.bold(`${rankNum}. [${TYPE_LABELS[f.type] || f.type}] ${f.title}`),
  );
  console.log(
    chalk.dim(
      `   id: ${f.id}  •  score ${f.score} (impacto ${f.impact} / esforço ${f.effort})` +
        (f.area ? `  •  área: ${f.area}` : ''),
    ),
  );
  for (const ev of f.evidence || []) console.log(chalk.dim(`   - ${ev}`));
  console.log('');
}

/**
 * Print the deterministic, PRD-ready project brief for a finding.
 *
 * @param {Object} f - Finding.
 */
function printDeterministicBrief(f) {
  console.log(chalk.cyan(`📋 Project Brief — ${f.title}`));
  console.log(chalk.dim('─'.repeat(60)));
  console.log(`Tipo: ${TYPE_LABELS[f.type] || f.type}`);
  console.log(`Id: ${f.id}`);
  if (f.area) console.log(`Área: ${f.area}`);
  console.log(`Esforço: ${f.effort}/5   Impacto: ${f.impact}/5   Score: ${f.score}`);
  console.log('');
  console.log('Contexto (evidências determinísticas):');
  for (const ev of f.evidence || []) console.log(`  - ${ev}`);
  console.log('');
  console.log('Oportunidade:');
  console.log(`  ${opportunityText(f)}`);
  console.log('');
  console.log('Próximo passo sugerido:');
  console.log(`  ${nextStepText(f)}`);
}

/**
 * Deterministic one-liner describing the opportunity of a finding.
 *
 * @param {Object} f - Finding.
 * @returns {string}
 */
function opportunityText(f) {
  switch (f.type) {
    case 'automation':
      return 'Transformar um trabalho manual recorrente em automação/padrão reutilizável.';
    case 'underused-asset':
      return `Reativar a área "${f.area}" — há conteúdo acumulado sem uso recente.`;
    case 'latent-demand':
      return 'Abrir um projeto para uma entidade muito mencionada e ainda sem projeto associado.';
    case 'process-gap':
      return `Formalizar o processo da área "${f.area}" para reduzir retrabalho e decisões ad-hoc.`;
    default:
      return 'Oportunidade identificada pelo radar determinístico.';
  }
}

/**
 * Deterministic next-step suggestion per finding type.
 *
 * @param {Object} f - Finding.
 * @returns {string}
 */
function nextStepText(f) {
  switch (f.type) {
    case 'automation':
      return 'Criar uma task/rotina AIOS que execute o passo repetido automaticamente.';
    case 'underused-asset':
      return 'Revisar o conteúdo da área e publicá-lo/reaproveitá-lo em uma entrega ativa.';
    case 'latent-demand':
      return 'Criar a entidade project e vinculá-la ao cliente/produto (aios brain entities).';
    case 'process-gap':
      return 'Escrever um _index.md / playbook consolidando as decisões dessa área.';
    default:
      return 'Detalhar a oportunidade em um PRD.';
  }
}

/**
 * Friendly guidance when there are no findings, tailored to which sources were absent.
 *
 * @param {Object} sources - Source presence summary.
 */
function printEmptyGuidance(sources) {
  console.log(chalk.yellow('Nenhuma oportunidade detectada ainda.'));
  const tips = [];
  if (!sources || !sources.brainStats) tips.push('Rode `aios brain index` para indexar o workspace.');
  if (!sources || !sources.entities) tips.push('Rode `aios brain entities scan` para mapear entidades.');
  if (!sources || !sources.digests) tips.push('Gere digests com `aios brain digest` ao fechar sessões.');
  if (!tips.length) tips.push('As fontes existem, mas nenhum padrão cruzou os limiares — siga acumulando sinal.');
  for (const tip of tips) console.log(chalk.dim(`  → ${tip}`));
}

/**
 * Compact human description of which sources were present.
 *
 * @param {Object} sources - Source presence summary.
 * @returns {string}
 */
function describeSources(sources) {
  const s = sources || {};
  const present = [];
  if (s.entities) present.push(`entidades:${s.entities}`);
  if (s.digests) present.push(`digests:${s.digests}`);
  if (s.gotchas) present.push(`gotchas:${s.gotchas}`);
  if (s.brainStats) present.push(`áreas:${s.brainStats}`);
  if (s.activity) present.push('atividade:sim');
  return present.length ? present.join(' | ') : 'nenhuma fonte disponível';
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PERSISTENCE + GENERIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Summarize source presence (counts) for the scan file + printing.
 *
 * @param {Object} collected - Collected snapshot.
 * @returns {{entities: number, digests: number, gotchas: number, brainStats: number, activity: boolean}}
 */
function summarizeSources(collected) {
  const c = collected || {};
  return {
    entities: c.entities ? c.entities.length : 0,
    digests: c.digests ? c.digests.length : 0,
    gotchas: c.gotchas ? c.gotchas.length : 0,
    brainStats: c.brainStats && c.brainStats.areas ? Object.keys(c.brainStats.areas).length : 0,
    activity: Boolean(c.activity),
  };
}

/**
 * Resolve a non-colliding scan path: `<cwd>/.aios/radar/scan-<date>.json`,
 * suffixing `-2`, `-3`, … when the target already exists (never overwrites).
 *
 * @param {string} cwd - Workspace root.
 * @param {string} date - ISO date (YYYY-MM-DD).
 * @returns {string} Absolute path.
 */
function resolveScanPath(cwd, date) {
  const dir = path.join(cwd, RADAR_RELDIR);
  let candidate = path.join(dir, `scan-${date}.json`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `scan-${date}-${counter}.json`);
    counter++;
  }
  return candidate;
}

/**
 * Read the most recent persisted scan (by file name sort). Returns null when none
 * exist or all are unreadable.
 *
 * @param {string} cwd - Workspace root.
 * @returns {Object|null}
 */
function readLatestScan(cwd) {
  try {
    const dir = path.join(cwd, RADAR_RELDIR);
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^scan-.*\.json$/.test(n))
      .sort();
    if (!files.length) return null;

    // Latest by name: date-sorted, `-2`/`-3` suffixes sort after the base name.
    for (let i = files.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
      } catch (_err) {
        // Try the next-most-recent readable scan.
      }
    }
    return null;
  } catch (_err) {
    return null;
  }
}

/**
 * Parse a minimal `--flag value` / `--flag` argv slice.
 *
 * @param {string[]} argv - Arguments.
 * @returns {{flags: Object, positionals: string[]}}
 */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

/**
 * Coerce a flag value to a positive integer, or undefined.
 *
 * @param {*} value - Flag value.
 * @returns {number|undefined}
 */
function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Format a Date as local `YYYY-MM-DD`.
 *
 * @param {Date} date - Date.
 * @returns {string}
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = {
  radarCommand,
  performScan,
  readLatestScan,
  resolveScanPath,
};
