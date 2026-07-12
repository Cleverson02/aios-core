#!/usr/bin/env node

/**
 * AIOS Brain CLI Handler
 *
 * Story: WSB-1.2 - Brain Indexer (índice léxico com metadados de origem)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Command handler for `aios brain <index|ask|status>`. Wiring into bin/aios.js
 * is done by the lead; this module only exposes `brainCommand(args)`.
 *
 *   aios brain index [--full]                 → (re)build the index
 *   aios brain ask <query> [--area X] [--tier Y]  → scoped lexical search
 *   aios brain status                         → index statistics
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const chalk = require('chalk');
const { BrainIndexer } = require('./indexer');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Dispatch a `brain` subcommand.
 *
 * @param {string[]} [args] - Arguments after `brain` (e.g. ['ask', 'quality']).
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function brainCommand(args = []) {
  const [subcommand, ...rest] = args;
  const { flags, positionals } = parseArgs(rest);
  const indexer = new BrainIndexer({ cwd: process.cwd() });

  switch (subcommand) {
    case 'index':
      return runIndex(indexer, flags);
    case 'ask':
    case 'search':
      return runAsk(indexer, positionals, flags);
    case 'status':
    case 'stats':
      return runStatus(indexer);
    default:
      printUsage();
      return subcommand ? 1 : 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `brain index [--full]`
 *
 * @param {BrainIndexer} indexer - Indexer instance.
 * @param {Object} flags - Parsed flags.
 * @returns {Promise<number>}
 */
async function runIndex(indexer, flags) {
  const incremental = !flags.full;
  console.log(
    chalk.cyan(`🧠 Indexando workspace (${incremental ? 'incremental' : 'completo'})...`),
  );

  const result = await indexer.index({ incremental });

  console.log(
    chalk.green('✔ Indexação concluída') +
      chalk.dim(
        ` — ${result.filesIndexed} indexados, ${result.filesSkipped} inalterados, ` +
          `${result.chunks} chunks, ${result.durationMs}ms`,
      ),
  );
  for (const warning of result.warnings) {
    console.log(chalk.yellow(`  ⚠ ${warning}`));
  }
  return 0;
}

/**
 * `brain ask <query> [--area X] [--tier Y]`
 *
 * @param {BrainIndexer} indexer - Indexer instance.
 * @param {string[]} positionals - Query terms.
 * @param {Object} flags - Parsed flags.
 * @returns {Promise<number>}
 */
async function runAsk(indexer, positionals, flags) {
  const query = positionals.join(' ').trim();
  if (!query) {
    console.log(chalk.red('Uso: aios brain ask <query> [--area X] [--tier Y]'));
    return 1;
  }

  const results = await indexer.search(query, {
    limit: flags.limit ? Number(flags.limit) : 10,
    area: flags.area,
    tier: flags.tier,
  });

  if (!results.length) {
    console.log(chalk.yellow(`Nenhum resultado para "${query}".`));
    return 0;
  }

  console.log(chalk.cyan(`🔎 ${results.length} resultado(s) para "${query}":\n`));
  for (const r of results) {
    // r.file is root-relative and already starts with the area segment when
    // the area was derived from the path — print tags instead of a prefix.
    const source = `${r.file}${r.heading ? `#${r.heading}` : ''}`;
    const tags = [r.area && `area: ${r.area}`, r.tier && `tier: ${r.tier}`]
      .filter(Boolean)
      .join(', ');
    console.log(chalk.bold(source) + chalk.dim(`  (${tags ? `${tags}, ` : ''}score ${r.score})`));
    console.log(chalk.gray(`  ${r.snippet}\n`));
  }
  return 0;
}

/**
 * `brain status`
 *
 * @param {BrainIndexer} indexer - Indexer instance.
 * @returns {Promise<number>}
 */
async function runStatus(indexer) {
  const stats = await indexer.stats();

  console.log(chalk.cyan('🧠 Brain — status do índice'));
  console.log(`  ${chalk.bold('Arquivos:')}      ${stats.files}`);
  console.log(`  ${chalk.bold('Chunks:')}        ${stats.chunks}`);
  console.log(`  ${chalk.bold('Termos:')}        ${stats.terms}`);
  console.log(`  ${chalk.bold('Último index:')}  ${stats.lastIndexed || chalk.dim('nunca')}`);
  console.log(`  ${chalk.bold('Brain dir:')}     ${chalk.dim(stats.brainDir)}`);

  if (stats.roots.length) {
    console.log(chalk.bold('  Roots:'));
    for (const root of stats.roots) {
      console.log(`    - ${root.name} ${chalk.dim(`[${root.tier}]`)} — ${root.files} arquivo(s)`);
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Parse a minimal `--flag value` / `--flag` argv slice.
 *
 * @param {string[]} argv - Arguments to parse.
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
 * Print usage help.
 */
function printUsage() {
  console.log(chalk.bold('aios brain') + ' — cérebro léxico do workspace\n');
  console.log('  ' + chalk.cyan('index [--full]') + '                    (re)constrói o índice');
  console.log('  ' + chalk.cyan('ask <query> [--area X] [--tier Y]') + ' busca escopada com fonte');
  console.log('  ' + chalk.cyan('status') + '                            estatísticas do índice');
}

module.exports = { brainCommand };
