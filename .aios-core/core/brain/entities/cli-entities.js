#!/usr/bin/env node

/**
 * AIOS Brain — Entities CLI Handler
 *
 * Story: WSB-1.4 - Grafo de Entidades do Negócio
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Command handler for `aios brain entities <sub>`. Wiring into bin/aios.js /
 * brain/cli.js is done by the lead; this module only exposes `entitiesCommand`.
 *
 *   entities list [--type X]
 *   entities show <nome>
 *   entities add <nome> --type X [--alias a,b] [--desc "..."]
 *   entities link <a> <b> --rel tipo
 *   entities scan                         → re-extract + re-build the graph
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const chalk = require('chalk');
const { EntityStore } = require('./entity-store');
const { buildGraph } = require('./entity-graph');
const { getEntity, listEntities } = require('./query');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Dispatch an `entities` subcommand.
 *
 * @param {string[]} [args] - Arguments after `entities` (e.g. ['show', 'Acme']).
 * @param {Object} [options]
 * @param {string} [options.brainDir] - Persistence directory (defaults to the
 *        per-workspace brain dir under ~/.aiox/brain).
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function entitiesCommand(args = [], options = {}) {
  const [subcommand, ...rest] = args;
  const { flags, positionals } = parseArgs(rest);
  const brainDir = options.brainDir || defaultBrainDir(process.cwd());

  switch (subcommand) {
    case 'list':
      return runList(brainDir, flags);
    case 'show':
      return runShow(brainDir, positionals);
    case 'add':
      return runAdd(brainDir, positionals, flags);
    case 'link':
      return runLink(brainDir, positionals, flags);
    case 'scan':
      return runScan(brainDir);
    default:
      printUsage();
      return subcommand ? 1 : 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `entities list [--type X]`
 *
 * @param {string} brainDir - Persistence directory.
 * @param {Object} flags - Parsed flags.
 * @returns {number}
 */
function runList(brainDir, flags) {
  const type = typeof flags.type === 'string' ? flags.type : undefined;
  const entities = listEntities(brainDir, { type });

  if (!entities.length) {
    console.log(chalk.yellow(type ? `Nenhuma entidade do tipo "${type}".` : 'Nenhuma entidade. Rode `entities scan`.'));
    return 0;
  }

  console.log(chalk.cyan(`🧠 ${entities.length} entidade(s)${type ? ` (${type})` : ''}:\n`));
  for (const entity of entities) {
    const aliases = entity.aliases.length ? chalk.dim(` (${entity.aliases.join(', ')})`) : '';
    const origin = entity.origin === 'manual' ? chalk.magenta(' ✎ manual') : '';
    console.log(
      `  ${chalk.bold(entity.name)}${aliases} ${chalk.dim(`[${entity.type}]`)}` +
        `${chalk.dim(` — ${entity.sources.length} fonte(s)`)}${origin}`,
    );
  }
  return 0;
}

/**
 * `entities show <nome>`
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string[]} positionals - Name terms.
 * @returns {number}
 */
function runShow(brainDir, positionals) {
  const name = positionals.join(' ').trim();
  if (!name) {
    console.log(chalk.red('Uso: entities show <nome>'));
    return 1;
  }

  const entity = getEntity(brainDir, name);
  if (!entity) {
    console.log(chalk.yellow(`Entidade não encontrada: "${name}".`));
    return 1;
  }

  console.log(chalk.cyan(`🧠 ${chalk.bold(entity.name)} ${chalk.dim(`[${entity.type}]`)}`));
  if (entity.aliases.length) console.log(`  ${chalk.bold('Aliases:')}      ${entity.aliases.join(', ')}`);
  if (entity.description) console.log(`  ${chalk.bold('Descrição:')}    ${entity.description}`);
  console.log(`  ${chalk.bold('Origem:')}       ${entity.origin}`);

  if (entity.sources.length) {
    console.log(chalk.bold('  Fontes:'));
    for (const source of entity.sources.slice(0, 10)) {
      console.log(`    - ${source.file} ${chalk.dim(`(${source.mentions} menção/ões)`)}`);
    }
  }

  if (entity.relations.length) {
    console.log(chalk.bold('  Relações:'));
    for (const relation of entity.relations) {
      const target = getEntity(brainDir, relation.target);
      const label = target ? target.name : relation.target;
      console.log(`    - ${chalk.dim(relation.type)} → ${label}`);
    }
  }
  return 0;
}

/**
 * `entities add <nome> --type X [--alias a,b] [--desc "..."]`
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string[]} positionals - Name terms.
 * @param {Object} flags - Parsed flags.
 * @returns {number}
 */
function runAdd(brainDir, positionals, flags) {
  const name = positionals.join(' ').trim();
  if (!name) {
    console.log(chalk.red('Uso: entities add <nome> --type X [--alias a,b] [--desc "..."]'));
    return 1;
  }

  const aliases = typeof flags.alias === 'string' ? flags.alias.split(',').map((a) => a.trim()).filter(Boolean) : [];
  const store = new EntityStore({ brainDir }).load();
  const entity = store.upsert(
    {
      name,
      type: typeof flags.type === 'string' ? flags.type : 'other',
      aliases,
      description: typeof flags.desc === 'string' ? flags.desc : '',
      origin: 'manual',
    },
    { preserveManual: false },
  );
  store.save();

  console.log(chalk.green(`✔ Entidade ${entity.origin === 'manual' ? 'curada' : 'salva'}: `) + chalk.bold(entity.name) + chalk.dim(` [${entity.type}]`));
  return 0;
}

/**
 * `entities link <a> <b> --rel tipo`
 *
 * @param {string} brainDir - Persistence directory.
 * @param {string[]} positionals - Two entity names/ids.
 * @param {Object} flags - Parsed flags.
 * @returns {number}
 */
function runLink(brainDir, positionals, flags) {
  const [a, b] = positionals;
  const relType = typeof flags.rel === 'string' ? flags.rel : 'related-to';
  if (!a || !b) {
    console.log(chalk.red('Uso: entities link <a> <b> --rel tipo'));
    return 1;
  }

  const store = new EntityStore({ brainDir }).load();
  const updated = store.link(a, b, relType);
  if (!updated) {
    console.log(chalk.yellow(`Não foi possível ligar "${a}" → "${b}" (entidade ausente).`));
    return 1;
  }
  store.save();

  console.log(chalk.green('✔ Relação criada: ') + chalk.bold(a) + chalk.dim(` --${relType}→ `) + chalk.bold(b));
  return 0;
}

/**
 * `entities scan` — re-extract + re-build the graph.
 *
 * @param {string} brainDir - Persistence directory.
 * @returns {Promise<number>}
 */
async function runScan(brainDir) {
  console.log(chalk.cyan('🧠 Reconstruindo grafo de entidades...'));
  const result = await buildGraph(brainDir);
  console.log(
    chalk.green('✔ Grafo reconstruído') +
      chalk.dim(
        ` — ${result.entities.length} entidade(s), ${result.mentionsScanned} chunk(s) varrido(s), ${result.durationMs}ms`,
      ),
  );
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Compute the per-workspace brain directory (mirrors the indexer default so a
 * standalone `entities` invocation lands on the same store).
 *
 * @param {string} workspacePath - Absolute workspace path.
 * @returns {string}
 */
function defaultBrainDir(workspacePath) {
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 12);
  return path.join(os.homedir(), '.aiox', 'brain', hash);
}

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
  console.log(chalk.bold('aios brain entities') + ' — grafo de entidades do negócio\n');
  console.log('  ' + chalk.cyan('list [--type X]') + '                        lista entidades');
  console.log('  ' + chalk.cyan('show <nome>') + '                            detalhes + fontes + relações');
  console.log('  ' + chalk.cyan('add <nome> --type X [--alias a,b]') + '      cura uma entidade manual');
  console.log('  ' + chalk.cyan('link <a> <b> --rel tipo') + '                cria uma relação');
  console.log('  ' + chalk.cyan('scan') + '                                   re-extrai + reconstrói o grafo');
}

module.exports = { entitiesCommand };
