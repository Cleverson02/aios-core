'use strict';

/**
 * AIOS Gateway — Barrel (Story WSB-4.1).
 *
 * Telegram gateway: a *client of the CLI* (Constitution Art. I). It carries
 * commands to existing deterministic handlers and carries notifications back —
 * zero LLM tokens, zero new dependencies, full graceful degradation.
 *
 * Public surface:
 *   - TelegramClient           → Bot API client (fetch + backoff).
 *   - pairing.*                → generatePairingCode / tryPair / isPaired / listPaired.
 *   - handleCommand, writeDecision → deterministic command dispatcher.
 *   - watchEscalations         → new-escalation watcher.
 *   - gatewayCommand           → `aios gateway <start|stop|pair|status>`.
 *   - notifyTelegram           → convenience push to all paired chats.
 *
 * @module core/gateway
 * @author @dev (Dex)
 * @version 1.0.0
 */

const { TelegramClient } = require('./telegram-client');
const pairing = require('./pairing');
const commands = require('./commands');
const { watchEscalations } = require('./escalation-watcher');
const cli = require('./cli');

/**
 * Send a notification to every paired chat. Convenience wrapper used by the
 * escalation watcher and by any producer that wants to reach the owner.
 *
 * Fully graceful: no token → `{ notified: false, reason: 'no-token' }`; no paired
 * chats → `{ notified: false, reason: 'no-recipients' }`; a per-recipient send
 * failure does not abort the others. Never throws.
 *
 * @param {Object} params
 * @param {string} [params.title] - Bold-ish title line.
 * @param {string} [params.body] - Message body.
 * @param {Array} [params.buttons] - Inline buttons (see TelegramClient.buildInlineKeyboard).
 * @param {TelegramClient} [params.client] - Injected client (else built from env/credentials).
 * @param {string} [params.homeDir] - Home dir override (tests).
 * @returns {Promise<{notified: boolean, reason: string, count: number}>}
 */
async function notifyTelegram({ title, body, buttons, client, homeDir } = {}) {
  try {
    const tg = client || new TelegramClient({ homeDir });
    if (!tg.isAvailable()) {
      return { notified: false, reason: 'no-token', count: 0 };
    }

    const recipients = pairing.listPaired({ homeDir });
    if (!recipients.length) {
      return { notified: false, reason: 'no-recipients', count: 0 };
    }

    const text = [title ? `*${title}*` : '', body || ''].filter(Boolean).join('\n');
    let count = 0;
    for (const chatId of recipients) {
      try {
        await tg.sendMessage(chatId, text, { buttons });
        count += 1;
      } catch (_err) {
        // One bad recipient must not prevent notifying the others.
      }
    }

    return {
      notified: count > 0,
      reason: count > 0 ? 'sent' : 'send-failed',
      count,
    };
  } catch (_err) {
    return { notified: false, reason: 'error', count: 0 };
  }
}

module.exports = {
  TelegramClient,
  // pairing
  generatePairingCode: pairing.generatePairingCode,
  getPairingCode: pairing.getPairingCode,
  tryPair: pairing.tryPair,
  isPaired: pairing.isPaired,
  listPaired: pairing.listPaired,
  addPaired: pairing.addPaired,
  // commands
  handleCommand: commands.handleCommand,
  writeDecision: commands.writeDecision,
  // watcher
  watchEscalations,
  // cli
  gatewayCommand: cli.gatewayCommand,
  startGateway: cli.startGateway,
  pollLoop: cli.pollLoop,
  processUpdate: cli.processUpdate,
  processCallback: cli.processCallback,
  logEvent: cli.logEvent,
  // notifications
  notifyTelegram,
};
