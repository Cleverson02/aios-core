#!/usr/bin/env node

/**
 * AIOS Providers CLI (Story WSB-4.4).
 *
 * Command handler for `aios providers <list|set-key|remove-key|enable|disable|check>`.
 * Wiring into bin/aios.js is done by the lead; this module only exposes
 * `providersCommand(args)` (async — some subcommands prompt via readline).
 *
 *   aios providers list                       → key/CLI/enabled/available table
 *   aios providers set-key <provider>         → hidden prompt (echo muted)
 *   aios providers set-key <provider> --from-env VAR
 *   aios providers remove-key <provider>
 *   aios providers enable|disable <provider>
 *   aios providers check                      → refresh cache, show what changed
 *
 * Key VALUES are never printed. Exit codes: 0 = ok, 1 = usage/validation error.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const readline = require('readline');
const chalk = require('chalk');

const credentials = require('./credentials-store');
const availability = require('./availability');

/**
 * Dispatch a `providers` subcommand.
 *
 * @param {string[]} [args] - Arguments after `providers`.
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function providersCommand(args = []) {
  const [subcommand, ...rest] = args;
  const { flags, positionals } = parseArgs(rest);

  try {
    switch (subcommand) {
      case 'list':
      case 'ls':
        return runList();
      case 'set-key':
        return await runSetKey(positionals[0], flags);
      case 'remove-key':
        return runRemoveKey(positionals[0]);
      case 'enable':
        return runToggle(positionals[0], true);
      case 'disable':
        return runToggle(positionals[0], false);
      case 'check':
        return runCheck();
      default:
        printUsage();
        return subcommand ? 1 : 0;
    }
  } catch (error) {
    console.error(chalk.red(`✖ ${error.message}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `providers list` — table: provider | chave (fonte) | CLI | habilitado | disponível.
 * @returns {number}
 */
function runList() {
  const status = availability.getAvailability({ cwd: process.cwd() }).providers;
  const keyRows = credentials.listProviders();
  const keyByProvider = Object.fromEntries(keyRows.map((r) => [r.provider, r]));

  // Union of credential-known and matrix-known providers (stable order).
  const providers = [...new Set([...keyRows.map((r) => r.provider), ...Object.keys(status)])];

  console.log(chalk.cyan('🔌 Providers\n'));
  console.log(
    '  ' +
      chalk.bold('provider'.padEnd(12)) +
      chalk.bold('chave'.padEnd(14)) +
      chalk.bold('CLI'.padEnd(10)) +
      chalk.bold('habilitado'.padEnd(12)) +
      chalk.bold('disponível'),
  );
  console.log('  ' + chalk.dim('─'.repeat(56)));

  for (const provider of providers) {
    const keyRow = keyByProvider[provider] || { hasKey: false, source: null };
    const av = status[provider];

    const keyCell = keyRow.hasKey
      ? chalk.green(`✓ ${keyRow.source}`)
      : chalk.red('✗');

    let cliCell;
    if (!av || av.cliPresent === null || av.cliPresent === undefined) {
      cliCell = chalk.dim('n/a');
    } else {
      cliCell = av.cliPresent ? chalk.green('✓') : chalk.red('✗');
    }

    const enabledCell = av
      ? av.enabled
        ? chalk.green('sim')
        : chalk.yellow('não')
      : chalk.dim('—');

    const availCell = av
      ? av.available
        ? chalk.green('✓')
        : chalk.red('✗')
      : chalk.dim('—');

    console.log(
      '  ' +
        provider.padEnd(12) +
        padVisible(keyCell, 14) +
        padVisible(cliCell, 10) +
        padVisible(enabledCell, 12) +
        availCell,
    );
  }

  console.log(chalk.dim('\n  env sempre tem precedência sobre a chave salva no store.'));
  return 0;
}

/**
 * `providers set-key <provider>` — store a key without echoing it.
 * With `--from-env VAR`, read the value from the given env var instead of prompting.
 *
 * @param {string} provider - Provider id.
 * @param {Object} flags - Parsed flags.
 * @returns {Promise<number>}
 */
async function runSetKey(provider, flags) {
  if (!provider) {
    console.error(chalk.red('Uso: aios providers set-key <provider> [--from-env VAR]'));
    return 1;
  }

  let key;
  if (flags['from-env']) {
    const varName = flags['from-env'];
    key = process.env[varName];
    if (!key || !String(key).trim()) {
      console.error(chalk.red(`✖ Variável de ambiente "${varName}" está vazia ou não definida.`));
      return 1;
    }
  } else {
    key = await promptHidden(`Cole a API key para ${chalk.bold(provider)} (entrada oculta): `);
    if (!key) {
      console.error(chalk.red('✖ Nenhuma chave informada.'));
      return 1;
    }
  }

  credentials.setKey(provider, key);
  console.log(chalk.green(`✓ Chave de ${provider} salva em ~/.aiox/credentials.json (chmod 600).`));
  return 0;
}

/**
 * `providers remove-key <provider>`.
 * @param {string} provider - Provider id.
 * @returns {number}
 */
function runRemoveKey(provider) {
  if (!provider) {
    console.error(chalk.red('Uso: aios providers remove-key <provider>'));
    return 1;
  }
  const removed = credentials.removeKey(provider);
  console.log(
    removed
      ? chalk.green(`✓ Chave de ${provider} removida do store.`)
      : chalk.yellow(`• ${provider} não tinha chave no store (env vars não são afetadas).`),
  );
  return 0;
}

/**
 * `providers enable|disable <provider>`.
 * @param {string} provider - Provider id.
 * @param {boolean} enabled - Desired flag.
 * @returns {number}
 */
function runToggle(provider, enabled) {
  if (!provider) {
    console.error(chalk.red(`Uso: aios providers ${enabled ? 'enable' : 'disable'} <provider>`));
    return 1;
  }
  availability.setEnabled(provider, enabled);
  console.log(
    enabled
      ? chalk.green(`✓ ${provider} habilitado.`)
      : chalk.yellow(`• ${provider} desabilitado (não será roteado até reabilitar).`),
  );
  // Refresh so the router sees the new state immediately.
  availability.getAvailability({ cwd: process.cwd(), refresh: true });
  return 0;
}

/**
 * `providers check` — refresh the availability cache and report changes.
 * @returns {number}
 */
function runCheck() {
  const before = availability.readAvailabilityCache({ cwd: process.cwd() });
  const after = availability.getAvailability({ cwd: process.cwd(), refresh: true });

  console.log(chalk.cyan('🔍 Re-checando disponibilidade dos providers...\n'));

  const beforeProviders = (before && before.providers) || {};
  let changes = 0;
  for (const [provider, rec] of Object.entries(after.providers)) {
    const prev = beforeProviders[provider];
    const wasAvailable = prev ? prev.available : undefined;
    const mark = rec.available ? chalk.green('disponível') : chalk.red('indisponível');
    let delta = '';
    if (wasAvailable !== undefined && wasAvailable !== rec.available) {
      delta = chalk.yellow(`  (mudou: ${wasAvailable ? 'disponível' : 'indisponível'} → ${rec.available ? 'disponível' : 'indisponível'})`);
      changes++;
    }
    console.log(`  ${provider.padEnd(12)} ${mark}${delta}`);
  }

  console.log(
    changes ? chalk.yellow(`\n  ${changes} mudança(s) detectada(s).`) : chalk.dim('\n  Nenhuma mudança desde o último check.'),
  );
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Prompt for a line of input WITHOUT echoing what the user types (for secrets).
 * Uses native readline with a muted output writer — no extra dependency.
 *
 * @param {string} query - Prompt text (printed visibly).
 * @returns {Promise<string>} Trimmed input.
 */
function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Route all interface writes through a muter; the prompt itself is written
    // manually below so it stays visible.
    rl._writeToOutput = (str) => {
      if (!rl.stdoutMuted) rl.output.write(str);
    };

    rl.stdoutMuted = false;
    process.stdout.write(query);
    rl.stdoutMuted = true;

    rl.question('', (answer) => {
      rl.stdoutMuted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

/**
 * Pad a (possibly ANSI-colored) cell to a visible width. Measures length after
 * stripping ANSI escape codes so colored cells still align.
 *
 * @param {string} cell - Cell content (may contain ANSI codes).
 * @param {number} width - Target visible width.
 * @returns {string}
 */
function padVisible(cell, width) {
  // eslint-disable-next-line no-control-regex
  const visibleLen = cell.replace(/\[[0-9;]*m/g, '').length;
  const pad = Math.max(0, width - visibleLen);
  return cell + ' '.repeat(pad);
}

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
  console.log(chalk.bold('aios providers') + ' — chaves, ativação e disponibilidade de LLMs\n');
  console.log('  ' + chalk.cyan('list') + '                              tabela: chave, CLI, habilitado, disponível');
  console.log('  ' + chalk.cyan('set-key <provider> [--from-env VAR]') + '  cadastra chave (entrada oculta)');
  console.log('  ' + chalk.cyan('remove-key <provider>') + '             remove chave do store');
  console.log('  ' + chalk.cyan('enable|disable <provider>') + '         liga/desliga um provider');
  console.log('  ' + chalk.cyan('check') + '                             re-checa e mostra o que mudou');
}

module.exports = { providersCommand };
