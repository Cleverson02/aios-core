/**
 * Workspace CLI handler.
 *
 * Exposes `workspaceCommand(args)` for the `aios workspace ...` command family.
 * The bin/aios.js wiring is done by the lead — this module only owns the logic.
 *
 * Subcommands:
 *   init [--name X] [--dir path]                     Scaffold a new workspace
 *   add <path> --tier <projects|areas|resources|archives>   Add a root entry
 *   status                                           Print workspace overview
 *
 * NOTE on `add`: js-yaml does NOT preserve comments. Adding a root rewrites
 * workspace.yaml as clean YAML — the header comments from the template are lost.
 * This is an accepted trade-off (documented) to avoid a new dependency.
 *
 * @module core/workspace/cli
 * @created Story WSB-1.1 — Workspace Manager
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');

const { WorkspaceManager, TIER_ORDER, TIER_FOLDERS, MANIFEST_FILENAME } = require('./workspace-manager');

/**
 * Minimal flag/positional parser.
 *
 * @param {string[]} args - Raw args after the subcommand.
 * @returns {{ positionals: string[], flags: Record<string, string|boolean> }}
 */
function parseArgs(args) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/**
 * `aios workspace init` — scaffold a new workspace.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>} Exit code.
 */
async function runInit(flags) {
  const name = typeof flags.name === 'string' ? flags.name : undefined;
  const dir = typeof flags.dir === 'string' ? flags.dir : process.cwd();

  const manager = new WorkspaceManager({ cwd: dir });
  try {
    const result = await manager.init({ name, dir });
    console.log(chalk.green(`✓ Workspace "${result.name}" criado`));
    console.log(`  manifest: ${chalk.cyan(result.manifestPath)}`);
    console.log('  pastas:');
    for (const tier of TIER_ORDER) {
      console.log(`    ${chalk.gray(TIER_FOLDERS[tier])}`);
    }
    console.log(`  área de exemplo: ${chalk.gray(path.join(TIER_FOLDERS.areas, 'exemplo', '_index.md'))}`);
    return 0;
  } catch (error) {
    console.error(chalk.red(`✗ ${error.message}`));
    return 1;
  }
}

/**
 * `aios workspace add <path> --tier <tier>` — add a root to the manifest.
 *
 * @param {string[]} positionals
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>} Exit code.
 */
async function runAdd(positionals, flags) {
  const rootPath = positionals[0];
  const tier = typeof flags.tier === 'string' ? flags.tier : undefined;

  if (!rootPath) {
    console.error(chalk.red('✗ Uso: aios workspace add <path> --tier <projects|areas|resources|archives>'));
    return 1;
  }
  if (!tier || !TIER_ORDER.includes(tier)) {
    console.error(chalk.red(`✗ --tier inválido. Use um de: ${TIER_ORDER.join(', ')}`));
    return 1;
  }

  const manifestPath = WorkspaceManager.findManifest(process.cwd());
  if (!manifestPath) {
    console.error(chalk.red(`✗ Nenhum ${MANIFEST_FILENAME} encontrado. Rode "aios workspace init" primeiro.`));
    return 1;
  }

  try {
    const parsed = yaml.load(fs.readFileSync(manifestPath, 'utf8')) || {};
    if (!parsed.workspace) {
      parsed.workspace = { name: path.basename(path.dirname(manifestPath)), roots: {} };
    }
    if (!parsed.workspace.roots) {
      parsed.workspace.roots = {};
    }
    if (!Array.isArray(parsed.workspace.roots[tier])) {
      parsed.workspace.roots[tier] = [];
    }

    const already = parsed.workspace.roots[tier].some((entry) => entry && entry.path === rootPath);
    if (already) {
      console.error(chalk.yellow(`! "${rootPath}" já está no tier ${tier}. Nada a fazer.`));
      return 0;
    }

    const entry = { path: rootPath };
    if (typeof flags.name === 'string') {
      entry.name = flags.name;
    }
    if (flags.aios === true || flags.aios === 'true') {
      entry.aios = true;
    }
    parsed.workspace.roots[tier].push(entry);

    // js-yaml does not preserve comments — the manifest is rewritten as clean YAML.
    fs.writeFileSync(manifestPath, yaml.dump(parsed, { indent: 2, lineWidth: 100 }), 'utf8');

    console.log(chalk.green(`✓ Adicionado "${rootPath}" ao tier ${chalk.bold(tier)}`));
    console.log(chalk.gray('  (manifest reescrito sem comentários — limitação do js-yaml)'));
    return 0;
  } catch (error) {
    console.error(chalk.red(`✗ ${error.message}`));
    return 1;
  }
}

/**
 * `aios workspace status` — print name, manifest path and roots per tier.
 *
 * @returns {Promise<number>} Exit code.
 */
async function runStatus() {
  const manager = new WorkspaceManager();
  try {
    await manager.load();
  } catch (error) {
    console.error(chalk.red(`✗ ${error.message}`));
    return 1;
  }

  console.log(chalk.bold(`Workspace: ${chalk.cyan(manager.getWorkspaceName())}`));
  if (manager.isDegraded()) {
    console.log(chalk.yellow(`  modo degradado: nenhum ${MANIFEST_FILENAME} encontrado (single-root no cwd)`));
  } else {
    console.log(`  manifest: ${chalk.gray(manager.getManifestPath())}`);
  }
  console.log('');

  for (const tier of TIER_ORDER) {
    const roots = manager.getRoots({ tier });
    const perm = roots.length
      ? `${roots[0].writable ? chalk.green('write') : chalk.red('read-only')}${roots[0].requiresApproval ? chalk.yellow(' +approval') : ''}`
      : '';
    console.log(chalk.bold(`${tier}`) + (perm ? `  ${perm}` : ''));
    if (roots.length === 0) {
      console.log(chalk.gray('  (vazio)'));
    }
    for (const root of roots) {
      const aiosBadge = root.aios ? chalk.blue(' [aios]') : '';
      console.log(`  • ${root.name}${aiosBadge}  ${chalk.gray(root.path)}`);
    }
    console.log('');
  }

  return 0;
}

/**
 * Entry point for the `workspace` command family.
 *
 * @param {string[]} [args=[]] - Args after `workspace` (subcommand + flags).
 * @returns {Promise<number>} Exit code (0 success, 1 failure).
 */
async function workspaceCommand(args = []) {
  const [subcommand, ...rest] = args;
  const { positionals, flags } = parseArgs(rest);

  switch (subcommand) {
    case 'init':
      return runInit(flags);
    case 'add':
      return runAdd(positionals, flags);
    case 'status':
    case undefined:
      return runStatus();
    default:
      console.error(chalk.red(`✗ Subcomando desconhecido: "${subcommand}"`));
      console.error('  Disponíveis: init, add, status');
      return 1;
  }
}

module.exports = { workspaceCommand, parseArgs };
