#!/usr/bin/env node

/**
 * AIOS Router CLI Handler (Story WSB-2.3 — advisor mode).
 *
 * Command handler for `aios route <suggest|matrix|policies>`. Wiring into
 * bin/aios.js is done by the lead; this module only exposes `routeCommand(args)`.
 *
 *   aios route suggest "<task>" [--policy quality-first|cost-first|speed-first]
 *   aios route matrix                 → per-model capability table
 *   aios route policies               → available routing policies
 *
 * Exit codes: 0 = ok, 1 = usage/validation error.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const chalk = require('chalk');
const { LlmRouter } = require('./router');

/**
 * Dispatch a `route` subcommand.
 *
 * @param {string[]} [args] - Arguments after `route` (e.g. ['suggest', '<task>']).
 * @returns {number} Process-style exit code (0 = ok, 1 = error).
 */
function routeCommand(args = []) {
  const [subcommand, ...rest] = args;
  const { flags, positionals } = parseArgs(rest);

  try {
    switch (subcommand) {
      case 'suggest':
      case 'ask':
        return runSuggest(positionals, flags);
      case 'matrix':
        return runMatrix();
      case 'policies':
        return runPolicies();
      default:
        printUsage();
        return subcommand ? 1 : 0;
    }
  } catch (error) {
    // Graceful degradation: a corrupt matrix or bad policy prints a clear error.
    console.error(chalk.red(`✖ ${error.message}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `route suggest "<task>" [--policy X]` — advisor mode.
 *
 * @param {string[]} positionals - Task terms.
 * @param {Object} flags - Parsed flags.
 * @returns {number}
 */
function runSuggest(positionals, flags) {
  const task = positionals.join(' ').trim();
  if (!task) {
    console.log(chalk.red('Uso: aios route suggest "<task>" [--policy quality-first|cost-first|speed-first]'));
    return 1;
  }

  const policy = typeof flags.policy === 'string' ? flags.policy : undefined;
  const router = new LlmRouter({ projectRoot: process.cwd() });
  const decision = router.route(task, { policy });

  console.log(chalk.cyan(`🧭 Recomendação para: ${chalk.bold(task)}\n`));
  console.log(`  ${chalk.bold('Modelo:')}      ${chalk.green(decision.model)} ${chalk.dim(`(${decision.provider})`)}`);
  console.log(`  ${chalk.bold('Categoria:')}   ${decision.category}`);
  console.log(`  ${chalk.bold('Complexidade:')} ${decision.complexity}`);
  console.log(`  ${chalk.bold('Policy:')}      ${decision.policy}`);
  console.log(`  ${chalk.bold('Razão:')}       ${chalk.dim(decision.reason)}`);

  if (decision.alternatives.length) {
    console.log(chalk.bold('\n  Alternativas:'));
    for (const alt of decision.alternatives) {
      console.log(`    - ${chalk.yellow(alt.model)} ${chalk.dim(`— ${alt.why}`)}`);
    }
  }
  return 0;
}

/**
 * `route matrix` — capability table per model.
 * @returns {number}
 */
function runMatrix() {
  const router = new LlmRouter({ projectRoot: process.cwd() });
  const models = router.listModels();

  console.log(chalk.cyan('🧮 Capability Matrix — modelos\n'));
  for (const m of models) {
    console.log(
      chalk.bold(m.id) +
        chalk.dim(`  (${m.provider}) `) +
        chalk.dim(`[cost: ${m.cost_tier}, speed: ${m.speed_tier}]`),
    );
    console.log(`    ${chalk.bold('strengths:')} ${m.strengths.join(', ')}`);
    if (m.notes) {
      console.log(`    ${chalk.dim(m.notes)}`);
    }
  }
  return 0;
}

/**
 * `route policies` — list routing policies.
 * @returns {number}
 */
function runPolicies() {
  const router = new LlmRouter({ projectRoot: process.cwd() });
  const policies = router.listPolicies();

  console.log(chalk.cyan('🎯 Routing Policies\n'));
  for (const p of policies) {
    const flag = p.isDefault ? chalk.green(' (default)') : '';
    console.log(chalk.bold(p.name) + flag);
    console.log(`  ${chalk.dim(p.description)}`);
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
 * @returns {{ flags: Object, positionals: string[] }}
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
  console.log(chalk.bold('aios route') + ' — conselheiro de roteamento multi-LLM\n');
  console.log('  ' + chalk.cyan('suggest "<task>" [--policy quality-first|cost-first|speed-first]'));
  console.log('  ' + chalk.cyan('matrix') + '                            tabela de capacidades por modelo');
  console.log('  ' + chalk.cyan('policies') + '                          policies de roteamento disponíveis');
}

module.exports = { routeCommand };
