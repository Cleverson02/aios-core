#!/usr/bin/env node

/**
 * Dashboard CLI — `aios dashboard` (Story WSB-4.7).
 *
 * Command handler for the local observability dashboard. Wiring into
 * bin/aios.js is the lead's job; this module only exposes `dashboardCommand`.
 *
 *   aios dashboard start [--port N] [--daemon]   foreground (Ctrl+C) or detached
 *   aios dashboard stop                          stop the daemonized server
 *   aios dashboard status                        report daemon state + URL
 *
 * Foreground mode logs a clickable http://127.0.0.1:PORT and blocks until
 * Ctrl+C. Daemon mode spawns a detached process, writes `.aios/dashboard.pid`
 * and returns immediately.
 *
 * Exit codes: 0 = ok, 1 = usage/runtime error.
 *
 * @module core/dashboard/cli
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chalk = require('chalk');

const { createDashboardServer, DEFAULT_PORT, HOST } = require('./server');

/** PID file for the daemonized dashboard, relative to the project root. */
const PID_RELPATH = path.join('.aios', 'dashboard.pid');

/**
 * Dispatch a `dashboard` subcommand.
 *
 * @param {string[]} [args] - Arguments after `dashboard`.
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function dashboardCommand(args = []) {
  const [subcommand, ...rest] = args;
  const { flags } = parseArgs(rest);
  const cwd = process.cwd();

  try {
    switch (subcommand) {
      // `__serve` is the internal entry the daemon child runs (not documented).
      case '__serve':
      case 'start':
        return await startCommand(cwd, flags, subcommand === '__serve');
      case 'stop':
        return stopCommand(cwd);
      case 'status':
        return statusCommand(cwd);
      default:
        printUsage();
        return subcommand ? 1 : 0;
    }
  } catch (err) {
    console.error(chalk.red(`✖ ${err.message}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `start [--port N] [--daemon]` — run in the foreground (Ctrl+C) or detach.
 *
 * @private
 * @param {string} cwd
 * @param {Object} flags
 * @param {boolean} isDaemonChild - True when invoked as the detached child.
 * @returns {Promise<number>}
 */
async function startCommand(cwd, flags, isDaemonChild) {
  const port = Number(flags.port) || DEFAULT_PORT;

  if (flags.daemon && !isDaemonChild) {
    return spawnDaemon(cwd, port);
  }

  const dashboard = createDashboardServer({ cwd, port });
  const info = await dashboard.start();
  const url = `http://${HOST}:${info.port}`;

  if (isDaemonChild) {
    writePidFile(cwd, { pid: process.pid, port: info.port, url, startedAt: Date.now() });
  } else {
    console.log(chalk.green(`✓ AIOX Cortex — Observability em ${chalk.underline(url)}`));
    console.log(chalk.dim('  Observa, nunca controla · bind 127.0.0.1 · Ctrl+C para parar.'));
  }

  // Keep the process alive until a termination signal arrives.
  await new Promise((resolve) => {
    const shutdown = () => {
      dashboard.stop().finally(() => {
        if (isDaemonChild) removePidFile(cwd);
        resolve();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

/**
 * `stop` — terminate the daemonized dashboard via its PID file.
 *
 * @private
 * @param {string} cwd
 * @returns {number}
 */
function stopCommand(cwd) {
  const info = readPidFile(cwd);
  if (!info || !info.pid) {
    console.log(chalk.yellow('⚠ Nenhum dashboard em execução (sem .aios/dashboard.pid).'));
    return 1;
  }

  try {
    process.kill(info.pid, 'SIGTERM');
    console.log(chalk.green(`✓ Dashboard parado (pid ${info.pid}).`));
  } catch (err) {
    if (err.code === 'ESRCH') {
      console.log(chalk.yellow(`⚠ Processo ${info.pid} não está mais ativo — limpando pid file.`));
    } else {
      throw err;
    }
  }
  removePidFile(cwd);
  return 0;
}

/**
 * `status` — report whether the daemon is alive and where to reach it.
 *
 * @private
 * @param {string} cwd
 * @returns {number}
 */
function statusCommand(cwd) {
  const info = readPidFile(cwd);
  if (!info || !info.pid) {
    console.log(chalk.dim('Dashboard: parado.'));
    console.log(chalk.dim('  Inicie com: aios dashboard start [--daemon]'));
    return 0;
  }

  const alive = isAlive(info.pid);
  if (alive) {
    const url = info.url || `http://${HOST}:${info.port || DEFAULT_PORT}`;
    console.log(chalk.green(`Dashboard: rodando (pid ${info.pid}).`));
    console.log(`  URL: ${chalk.underline(url)}`);
  } else {
    console.log(chalk.yellow(`Dashboard: pid ${info.pid} registrado, mas não está ativo (stale).`));
    console.log(chalk.dim('  Limpe com: aios dashboard stop'));
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DAEMON HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Spawn a detached child running `__serve` and record its PID.
 *
 * @private
 * @param {string} cwd
 * @param {number} port
 * @returns {number}
 */
function spawnDaemon(cwd, port) {
  const existing = readPidFile(cwd);
  if (existing && existing.pid && isAlive(existing.pid)) {
    console.log(chalk.yellow(`⚠ Dashboard já em execução (pid ${existing.pid}).`));
    console.log(`  URL: ${existing.url || `http://${HOST}:${existing.port || port}`}`);
    return 1;
  }

  const child = spawn(process.execPath, [__filename, '__serve', '--port', String(port)], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const url = `http://${HOST}:${port}`;
  // The child writes the authoritative pid file once bound; seed it here too so
  // `status`/`stop` work immediately even before the child's first tick.
  writePidFile(cwd, { pid: child.pid, port, url, startedAt: Date.now() });

  console.log(chalk.green(`✓ Dashboard iniciado em segundo plano (pid ${child.pid}).`));
  console.log(`  URL: ${chalk.underline(url)}`);
  console.log(chalk.dim('  Pare com: aios dashboard stop'));
  return 0;
}

/**
 * Write the daemon PID file (best-effort).
 * @private
 * @param {string} cwd
 * @param {Object} info
 */
function writePidFile(cwd, info) {
  try {
    const file = path.join(cwd, PID_RELPATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf8');
  } catch {
    // Non-fatal: status/stop simply won't find a pid file.
  }
}

/**
 * Read the daemon PID file, or null when absent/corrupt.
 * @private
 * @param {string} cwd
 * @returns {Object|null}
 */
function readPidFile(cwd) {
  try {
    const file = path.join(cwd, PID_RELPATH);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove the daemon PID file (best-effort).
 * @private
 * @param {string} cwd
 */
function removePidFile(cwd) {
  try {
    fs.unlinkSync(path.join(cwd, PID_RELPATH));
  } catch {
    // already gone
  }
}

/**
 * Is a process alive? Uses signal 0 (no-op probe).
 * @private
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours → still alive
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              ARG PARSING / USAGE
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Parse a minimal `--flag value` / `--flag` argv slice.
 * @private
 * @param {string[]} argv
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

/** Print usage help. */
function printUsage() {
  console.log(chalk.bold('aios dashboard') + ' — AIOX Cortex Observability (local-only)\n');
  console.log('  ' + chalk.cyan('start [--port N] [--daemon]') + '   inicia o painel (foreground ou daemon)');
  console.log('  ' + chalk.cyan('stop') + '                          para o painel em daemon');
  console.log('  ' + chalk.cyan('status') + '                        mostra estado e URL');
  console.log(chalk.dim('\n  Bind 127.0.0.1 · observa, nunca controla · sem auth (local-only).'));
}

module.exports = {
  dashboardCommand,
  PID_RELPATH,
};

// Allow the daemon child (and direct invocation) to run standalone.
if (require.main === module) {
  dashboardCommand(process.argv.slice(2)).then((code) => {
    if (code) process.exitCode = code;
  });
}
