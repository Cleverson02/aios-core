#!/usr/bin/env node

'use strict';

/**
 * AIOS Routines — CLI handler (Story WSB-5.2, AC4).
 *
 * `aios routines <list|enable|disable|run|start|stop|status>`. Wiring into
 * bin/aios.js is done by the lead; this module exposes `routinesCommand(args)`
 * and, when executed directly (`node cli.js start`), runs the same dispatcher —
 * that is how `--daemon` re-spawns a detached copy of itself (same pattern as the
 * gateway daemon).
 *
 *   list                      table: name, task, schedule, enabled, last, next
 *   enable|disable <name>     toggle a routine (persisted)
 *   run <name>                run a routine immediately, print the result
 *   start [--daemon]          tick loop (foreground) or detached daemon + pid file
 *   stop                      kill the daemon by pid, remove `.aios/routines.pid`
 *   status                    daemon running? + enabled count
 *
 * @module core/routines/cli
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const chalk = require('chalk');

const { loadRoutines, setEnabled } = require('./registry');
const { runRoutine, startScheduler, readState, nextRunAt } = require('./scheduler');

/** Pid file relative to the workspace root (AC4). */
const PID_FILE = path.join('.aios', 'routines.pid');

/** Daemon stdout/stderr log dir relative to the workspace root. */
const ROUTINES_SUBDIR = path.join('.aios', 'routines');

// ═══════════════════════════════════════════════════════════════════════════════
//                              DISPATCH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dispatch a `routines` subcommand.
 *
 * @param {string[]} [args] - Arguments after `routines`.
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function routinesCommand(args = []) {
  const { flags, positionals } = parseArgs(args);
  const [sub, name] = positionals;
  const cwd = process.cwd();

  try {
    switch (sub) {
      case 'list':
      case undefined:
        return listRoutines({ cwd });
      case 'enable':
        return toggleRoutine({ cwd, name, enabled: true });
      case 'disable':
        return toggleRoutine({ cwd, name, enabled: false });
      case 'run':
        return await runOne({ cwd, name });
      case 'start':
        return startDaemon({ cwd, daemon: Boolean(flags.daemon) });
      case 'stop':
        return stopDaemon({ cwd });
      case 'status':
        return statusDaemon({ cwd });
      default:
        printUsage();
        return 1;
    }
  } catch (err) {
    console.error(chalk.red(`✖ ${err.message}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `routines list` — tabular view with last + next execution.
 * @param {Object} params
 * @param {string} params.cwd
 * @returns {number}
 */
function listRoutines({ cwd }) {
  const routines = loadRoutines({ cwd });
  const state = readState(cwd);
  const now = new Date();

  const rows = routines.map((r) => {
    const st = state[r.name] || {};
    let next = '—';
    if (r.enabled) {
      try {
        next = formatWhen(nextRunAt(r.schedule, now));
      } catch (_err) {
        next = 'schedule inválido';
      }
    }
    return {
      name: r.name,
      task: r.task,
      schedule: r.schedule,
      enabled: r.enabled ? 'sim' : 'não',
      last: st.lastRunAt ? formatWhen(new Date(st.lastRunAt)) : '—',
      next,
    };
  });

  const cols = [
    { key: 'name', label: 'NOME' },
    { key: 'task', label: 'TASK' },
    { key: 'schedule', label: 'SCHEDULE' },
    { key: 'enabled', label: 'ENABLED' },
    { key: 'last', label: 'ÚLTIMA' },
    { key: 'next', label: 'PRÓXIMA' },
  ];
  const widths = {};
  for (const c of cols) {
    widths[c.key] = Math.max(c.label.length, ...rows.map((row) => String(row[c.key]).length), 1);
  }

  console.log(chalk.bold('🗓  Rotinas agendadas'));
  console.log('  ' + cols.map((c) => chalk.dim(c.label.padEnd(widths[c.key]))).join('  '));
  for (const row of rows) {
    console.log('  ' + cols.map((c) => String(row[c.key]).padEnd(widths[c.key])).join('  '));
  }
  if (!rows.length) {
    console.log(chalk.dim('  (nenhuma rotina)'));
  }
  return 0;
}

/**
 * `routines enable|disable <name>`.
 * @param {Object} params
 * @param {string} params.cwd
 * @param {string} params.name
 * @param {boolean} params.enabled
 * @returns {number}
 */
function toggleRoutine({ cwd, name, enabled }) {
  if (!name) {
    console.error(chalk.red(`Uso: aios routines ${enabled ? 'enable' : 'disable'} <name>`));
    return 1;
  }
  setEnabled({ cwd, name, enabled });
  console.log(
    enabled
      ? chalk.green(`✓ Rotina "${name}" habilitada.`)
      : chalk.yellow(`○ Rotina "${name}" desabilitada.`),
  );
  return 0;
}

/**
 * `routines run <name>` — immediate manual execution.
 * @param {Object} params
 * @param {string} params.cwd
 * @param {string} params.name
 * @returns {Promise<number>}
 */
async function runOne({ cwd, name }) {
  if (!name) {
    console.error(chalk.red('Uso: aios routines run <name>'));
    return 1;
  }
  console.log(chalk.cyan(`▶ Executando rotina "${name}"…`));
  const result = await runRoutine(name, { cwd });

  if (result.ok) {
    console.log(chalk.green(`✔ ${name} — ${result.summary || 'ok'}`));
    return 0;
  }
  console.log(chalk.red(`✖ ${name} — ${result.reason || 'falhou'}`));
  return 1;
}

/**
 * `routines start [--daemon]` — foreground tick loop or detached daemon.
 * @param {Object} params
 * @param {string} params.cwd
 * @param {boolean} [params.daemon]
 * @returns {number}
 */
function startDaemon({ cwd, daemon = false }) {
  if (daemon) {
    return spawnDaemon(cwd);
  }

  if (isDaemonRunning(cwd)) {
    console.log(chalk.yellow('Scheduler de rotinas já está em execução.'));
    return 0;
  }

  writePid(cwd, process.pid);
  console.log(chalk.green('🗓  Scheduler de rotinas iniciado (tick 60s). Ctrl+C para sair.'));

  // Foreground: do NOT unref, so the process stays alive on the interval.
  const controller = startScheduler({ cwd, unref: false });

  const shutdown = () => {
    controller.stop();
    removePid(cwd);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

/**
 * `routines stop` — kill the daemon and clean the pid file.
 * @param {Object} params
 * @param {string} params.cwd
 * @returns {number}
 */
function stopDaemon({ cwd }) {
  const pid = readPid(cwd);
  if (!pid) {
    console.log(chalk.yellow('Nenhum scheduler de rotinas em execução.'));
    return 0;
  }
  try {
    process.kill(pid);
    console.log(chalk.green(`✓ Scheduler parado (pid ${pid}).`));
  } catch (_err) {
    console.log(chalk.yellow(`Processo ${pid} não encontrado (pid file obsoleto).`));
  }
  removePid(cwd);
  return 0;
}

/**
 * `routines status` — daemon state + enabled count.
 * @param {Object} params
 * @param {string} params.cwd
 * @returns {number}
 */
function statusDaemon({ cwd }) {
  const routines = loadRoutines({ cwd });
  const enabled = routines.filter((r) => r.enabled).length;
  const running = isDaemonRunning(cwd);

  console.log(chalk.bold('🗓  Rotinas — status'));
  console.log(`  Rotinas:  ${routines.length} (${enabled} habilitada(s))`);
  console.log(`  Daemon:   ${running ? chalk.green('rodando') : chalk.dim('parado')}`);
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              DAEMON / PID
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Spawn a detached copy of this CLI running `start` in the foreground.
 * @param {string} cwd
 * @returns {number}
 */
function spawnDaemon(cwd) {
  if (isDaemonRunning(cwd)) {
    console.log(chalk.yellow('Scheduler de rotinas já está em execução.'));
    return 0;
  }

  const logDir = path.join(cwd, ROUTINES_SUBDIR);
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'daemon.out.log'), 'a');

  const child = spawn(process.execPath, [__filename, 'start'], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writePid(cwd, child.pid);

  console.log(chalk.green(`✓ Scheduler daemon iniciado (pid ${child.pid}).`));
  console.log(chalk.dim(`  Logs: ${path.join(ROUTINES_SUBDIR, 'daemon.out.log')} e log.jsonl`));
  return 0;
}

/** @param {string} cwd @returns {string} Absolute pid file path. */
function pidPath(cwd) {
  return path.join(cwd, PID_FILE);
}

/**
 * Persist the daemon pid.
 * @param {string} cwd
 * @param {number} pid
 */
function writePid(cwd, pid) {
  try {
    fs.mkdirSync(path.dirname(pidPath(cwd)), { recursive: true });
    fs.writeFileSync(pidPath(cwd), String(pid), 'utf8');
  } catch (_err) {
    // Non-fatal: status/stop degrade gracefully without a pid file.
  }
}

/** @param {string} cwd @returns {number|null} The recorded pid, or null. */
function readPid(cwd) {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(cwd), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (_err) {
    return null;
  }
}

/** @param {string} cwd Remove the pid file (best-effort). */
function removePid(cwd) {
  try {
    fs.unlinkSync(pidPath(cwd));
  } catch (_err) {
    // Best-effort cleanup.
  }
}

/** @param {string} cwd @returns {boolean} Whether the recorded pid is a live process. */
function isDaemonRunning(cwd) {
  const pid = readPid(cwd);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a Date as `YYYY-MM-DD HH:MM` (local).
 * @param {Date} date
 * @returns {string}
 */
function formatWhen(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

/**
 * Parse a minimal `--flag value` / `--flag` argv slice.
 * @param {string[]} argv
 * @returns {{flags: Object, positionals: string[]}}
 */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

/** Print usage help. */
function printUsage() {
  console.log(chalk.bold('aios routines') + ' — rotinas agendadas (cliente do CLI)\n');
  console.log('  ' + chalk.cyan('list') + '                 tabela com próxima execução');
  console.log('  ' + chalk.cyan('enable <name>') + '        habilita uma rotina');
  console.log('  ' + chalk.cyan('disable <name>') + '       desabilita uma rotina');
  console.log('  ' + chalk.cyan('run <name>') + '           executa uma rotina imediatamente');
  console.log('  ' + chalk.cyan('start [--daemon]') + '     inicia o scheduler (foreground ou daemon)');
  console.log('  ' + chalk.cyan('stop') + '                 para o daemon');
  console.log('  ' + chalk.cyan('status') + '               estado do daemon e contagem');
}

module.exports = {
  routinesCommand,
  isDaemonRunning,
  pidPath,
};

// Direct execution (`node cli.js start`) — used by the --daemon self-spawn.
if (require.main === module) {
  routinesCommand(process.argv.slice(2))
    .then((code) => {
      // `start` (foreground) keeps the loop alive; only exit for one-shot commands.
      if (process.argv[2] !== 'start') {
        process.exit(code);
      }
    })
    .catch(() => process.exit(1));
}
