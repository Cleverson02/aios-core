#!/usr/bin/env node

'use strict';

/**
 * AIOS Gateway — CLI handler (Story WSB-4.1, AC5/AC6).
 *
 * `aios gateway <start|stop|pair|status>`. Wiring into bin/aios.js is done by the
 * lead; this module exposes `gatewayCommand(args)` and, when executed directly
 * (`node cli.js start`), runs the same dispatcher — that is how `--daemon`
 * re-spawns a detached copy of itself.
 *
 *   start [--daemon]  foreground long-poll loop (or detached daemon + pid file)
 *   stop              kill the daemon by pid and remove the pid file
 *   pair              generate + print a pairing code with instructions
 *   status            token ✓/✗, paired chats, daemon running?
 *
 * Every meaningful event is appended to `.aios/gateway/log.jsonl`. The bot token
 * is NEVER logged. The loop never crashes on a network error (the client retries
 * with backoff; the loop additionally guards each iteration).
 *
 * @module core/gateway/cli
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const chalk = require('chalk');

const { TelegramClient } = require('./telegram-client');
const { generatePairingCode, listPaired, isPaired, tryPair } = require('./pairing');
const { handleCommand, writeDecision } = require('./commands');
const { watchEscalations } = require('./escalation-watcher');

/** Gateway log directory (relative to cwd). */
const GATEWAY_SUBDIR = path.join('.aios', 'gateway');

/**
 * Dispatch a `gateway` subcommand.
 *
 * @param {string[]} [args] - Arguments after `gateway`.
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function gatewayCommand(args = []) {
  const [sub, ...rest] = args;
  const { flags } = parseArgs(rest);
  const cwd = process.cwd();

  try {
    switch (sub) {
      case 'start':
        return await startGateway({ daemon: Boolean(flags.daemon), cwd });
      case 'stop':
        return stopGateway({ cwd });
      case 'pair':
        return pairGateway({ cwd });
      case 'status':
        return statusGateway({ cwd });
      default:
        printUsage();
        return sub ? 1 : 0;
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
 * `gateway pair` — generate + display a pairing code.
 * @param {Object} params
 * @param {string} params.cwd
 * @returns {number}
 */
function pairGateway({ cwd }) {
  const { code, expiresAt } = generatePairingCode({});
  const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));

  console.log(chalk.bold('🔗 Pareamento do Gateway Telegram'));
  console.log(`  Código: ${chalk.cyan(code)}  ${chalk.dim(`(expira em ~${mins} min)`)}`);
  console.log('  1. Abra o chat com o seu bot no Telegram.');
  console.log('  2. Envie exatamente este código como mensagem.');
  console.log('  3. O chat entra na allowlist e o gateway passa a responder.');
  // The code itself is short-lived and never persisted to the log.
  logEvent(cwd, { event: 'pair_code_generated' });
  return 0;
}

/**
 * `gateway status` — token, paired chats and daemon state.
 * @param {Object} params
 * @param {string} params.cwd
 * @returns {number}
 */
function statusGateway({ cwd }) {
  const tokenOk = new TelegramClient({}).isAvailable();
  const paired = listPaired({});
  const running = isDaemonRunning();

  console.log(chalk.bold('📡 AIOX Gateway — status'));
  console.log(`  Token:    ${tokenOk ? chalk.green('✓ presente') : chalk.red('✗ ausente')}`);
  console.log(`  Pareados: ${paired.length} chat(s)`);
  console.log(`  Daemon:   ${running ? chalk.green('rodando') : chalk.dim('parado')}`);
  logEvent(cwd, { event: 'status_checked', tokenOk, paired: paired.length, running });
  return 0;
}

/**
 * `gateway stop` — kill the daemon (if any) and clean the pid file.
 * @param {Object} params
 * @param {string} params.cwd
 * @returns {number}
 */
function stopGateway({ cwd }) {
  const pid = readPid();
  if (!pid) {
    console.log(chalk.yellow('Nenhum daemon do gateway em execução.'));
    return 0;
  }
  try {
    process.kill(pid);
    console.log(chalk.green(`✓ Gateway parado (pid ${pid}).`));
  } catch (_err) {
    console.log(chalk.yellow(`Processo ${pid} não encontrado (pid file obsoleto).`));
  }
  try {
    fs.unlinkSync(pidPath());
  } catch (_err) {
    // Best-effort cleanup.
  }
  logEvent(cwd, { event: 'stopped', pid });
  return 0;
}

/**
 * `gateway start` — foreground loop, or spawn a detached daemon with `--daemon`.
 * @param {Object} params
 * @param {boolean} [params.daemon]
 * @param {string} params.cwd
 * @returns {Promise<number>}
 */
async function startGateway({ daemon = false, cwd = process.cwd() } = {}) {
  const client = new TelegramClient({});
  if (!client.isAvailable()) {
    console.log(
      chalk.yellow('⚠ Gateway indisponível: configure TELEGRAM_BOT_TOKEN ou ~/.aiox/credentials.json.'),
    );
    logEvent(cwd, { event: 'start_no_token' });
    return 1;
  }

  if (daemon) {
    return spawnDaemon(cwd);
  }

  writePid(process.pid);
  console.log(chalk.green('🤖 AIOX Gateway iniciado (long polling). Ctrl+C para sair.'));
  logEvent(cwd, { event: 'started', pid: process.pid });

  const watcher = watchEscalations({
    cwd,
    onEscalation: (esc) => notifyEscalation({ cwd, client, esc }),
  });

  const shutdown = () => {
    watcher.stop();
    try {
      fs.unlinkSync(pidPath());
    } catch (_err) {
      // ignore
    }
    logEvent(cwd, { event: 'shutdown' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await pollLoop({ client, cwd });
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              POLLING LOOP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Long-poll Telegram and process updates. Never throws out of the loop: a poll
 * failure is logged, backed off, and the loop continues.
 *
 * @param {Object} params
 * @param {TelegramClient} params.client
 * @param {string} params.cwd
 * @param {number} [params.maxIterations=Infinity] - Test hook to bound the loop.
 * @returns {Promise<void>}
 */
async function pollLoop({ client, cwd, maxIterations = Infinity }) {
  let offset;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations += 1;
    let updates = [];
    try {
      updates = await client.getUpdates({ offset, timeoutSec: 50 });
    } catch (err) {
      logEvent(cwd, { event: 'poll_error', message: err.message });
      // The client already backs off internally; this is a belt-and-suspenders guard.
      await client.sleep(1000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        await processUpdate({ update, client, cwd });
      } catch (err) {
        logEvent(cwd, { event: 'update_error', message: err.message });
      }
    }
  }
}

/**
 * Route a single Telegram update: pairing / command / callback button.
 *
 * @param {Object} params
 * @param {Object} params.update - Telegram update object.
 * @param {TelegramClient} params.client
 * @param {string} params.cwd
 * @returns {Promise<void>}
 */
async function processUpdate({ update, client, cwd }) {
  if (update.callback_query) {
    return processCallback({ cb: update.callback_query, client, cwd });
  }

  const msg = update.message;
  if (!msg || !msg.chat) {
    return;
  }
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (!isPaired(chatId, {})) {
    if (tryPair(chatId, text, {})) {
      logEvent(cwd, { event: 'paired', chatId: String(chatId) });
      await client.sendMessage(chatId, '✅ Pareado! Envie /help para ver os comandos.');
    } else {
      // AC2/AC6: non-paired messages are rejected and logged.
      logEvent(cwd, { event: 'rejected_unpaired', chatId: String(chatId) });
      await client.sendMessage(
        chatId,
        '🔒 Chat não pareado. Rode `aios gateway pair` e envie o código gerado.',
      );
    }
    return;
  }

  logEvent(cwd, { event: 'command', chatId: String(chatId), command: firstWord(text) });
  const response = await handleCommand({ chatId, text, cwd });
  if (response && response.text) {
    await client.sendMessage(chatId, response.text, { buttons: response.buttons });
  }
}

/**
 * Handle an inline-button callback (approve/reject an escalation).
 *
 * @param {Object} params
 * @param {Object} params.cb - Telegram callback_query.
 * @param {TelegramClient} params.client
 * @param {string} params.cwd
 * @returns {Promise<Object|void>}
 */
async function processCallback({ cb, client, cwd }) {
  const chatId = cb.message && cb.message.chat ? cb.message.chat.id : cb.from && cb.from.id;
  const data = String(cb.data || '');

  try {
    await client.answerCallbackQuery(cb.id);
  } catch (_err) {
    // Acknowledging is best-effort; proceed regardless.
  }

  if (!isPaired(chatId, {})) {
    logEvent(cwd, { event: 'rejected_unpaired_callback', chatId: String(chatId) });
    return;
  }

  const [action, id] = data.split(':');
  if ((action === 'approve' || action === 'reject') && id) {
    const decision = action === 'approve' ? 'approved' : 'rejected';
    const result = writeDecision({ cwd, id, decision, chatId });
    logEvent(cwd, { event: 'decision', chatId: String(chatId), id, decision });
    const label = decision === 'approved' ? '✅ Aprovado' : '⛔ Rejeitado';
    await client.sendMessage(chatId, `${label}: ${id}`);
    return result;
  }
}

/**
 * Notify paired chats of a new escalation, with approve/reject buttons.
 *
 * @param {Object} params
 * @param {string} params.cwd
 * @param {TelegramClient} params.client
 * @param {{id: string, content: string}} params.esc
 * @returns {Promise<void>}
 */
async function notifyEscalation({ cwd, client, esc }) {
  // Lazy require avoids a load-time cycle with index.js (which requires this module).
  const { notifyTelegram } = require('./index');
  const buttons = [
    { text: '✅ Aprovar', data: `approve:${esc.id}` },
    { text: '⛔ Rejeitar', data: `reject:${esc.id}` },
  ];
  logEvent(cwd, { event: 'escalation_notified', id: esc.id });
  await notifyTelegram({
    title: `🚨 Escalação: ${esc.id}`,
    body: summarize(esc.content),
    buttons,
    cwd,
    client,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              DAEMON / PID
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Spawn a detached copy of this CLI running `start`, writing its pid file.
 * @param {string} cwd
 * @returns {number}
 */
function spawnDaemon(cwd) {
  if (isDaemonRunning()) {
    console.log(chalk.yellow('Gateway já está em execução.'));
    return 0;
  }

  const logDir = path.join(cwd, GATEWAY_SUBDIR);
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'daemon.out.log'), 'a');

  const child = spawn(process.execPath, [__filename, 'start'], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writePid(child.pid);

  console.log(chalk.green(`✓ Gateway daemon iniciado (pid ${child.pid}).`));
  console.log(chalk.dim(`  Logs: ${path.join(GATEWAY_SUBDIR, 'daemon.out.log')} e log.jsonl`));
  logEvent(cwd, { event: 'daemon_started', pid: child.pid });
  return 0;
}

/** @returns {string} Absolute pid file path. */
function pidPath() {
  return path.join(process.env.HOME || os.homedir(), '.aiox', 'gateway.pid');
}

/**
 * Persist the daemon pid.
 * @param {number} pid
 */
function writePid(pid) {
  try {
    fs.mkdirSync(path.dirname(pidPath()), { recursive: true });
    fs.writeFileSync(pidPath(), String(pid), 'utf8');
  } catch (_err) {
    // Non-fatal: status/stop degrade gracefully without a pid file.
  }
}

/** @returns {number|null} The recorded pid, or null. */
function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (_err) {
    return null;
  }
}

/** @returns {boolean} Whether the recorded pid is a live process. */
function isDaemonRunning() {
  const pid = readPid();
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              LOG / HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Append a JSON line to `.aios/gateway/log.jsonl`. Never throws, never logs the token.
 *
 * @param {string} cwd - Workspace root.
 * @param {Object} event - Serializable event fields.
 */
function logEvent(cwd, event) {
  try {
    const dir = path.join(cwd, GATEWAY_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    fs.appendFileSync(path.join(dir, 'log.jsonl'), line, 'utf8');
  } catch (_err) {
    // Logging is best-effort — never break the gateway over a log write.
  }
}

/**
 * Summarize escalation Markdown into a short notification body.
 * @param {string} content
 * @returns {string}
 */
function summarize(content) {
  const text = String(content || '').trim();
  if (!text) {
    return 'Nova escalação aguardando decisão.';
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.slice(0, 8).join('\n');
  return head.length > 800 ? `${head.slice(0, 799)}…` : head;
}

/** First whitespace-delimited word (used for privacy-preserving command logging). */
function firstWord(text) {
  return String(text || '').trim().split(/\s+/)[0] || '';
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
  console.log(chalk.bold('aios gateway') + ' — Telegram gateway (cliente do CLI)\n');
  console.log('  ' + chalk.cyan('start [--daemon]') + '   inicia o long polling (foreground ou daemon)');
  console.log('  ' + chalk.cyan('stop') + '               para o daemon');
  console.log('  ' + chalk.cyan('pair') + '               gera um código de pareamento (TTL 5min)');
  console.log('  ' + chalk.cyan('status') + '             token, chats pareados e estado do daemon');
}

module.exports = {
  gatewayCommand,
  startGateway,
  pollLoop,
  processUpdate,
  processCallback,
  notifyEscalation,
  logEvent,
  isDaemonRunning,
  pidPath,
};

// Direct execution (`node cli.js start`) — used by the --daemon self-spawn.
if (require.main === module) {
  gatewayCommand(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
