'use strict';

/**
 * AIOS Gateway — Device pairing / allowlist (Story WSB-4.1, AC2/AC6).
 *
 * Security model: the gateway ONLY acts on chats in an explicit allowlist.
 * A chat joins the allowlist by echoing a short-lived 6-digit code that the
 * owner generated locally via `aios gateway pair`. Everything lives under
 * `~/.aiox/` with 0600 perms:
 *   - `gateway-pairing.json` → the pending code + expiry (TTL 5min default).
 *   - `gateway.json`         → `{ allowlist: [chatId, ...] }`.
 *
 * This module does NOT own the credentials store (another agent does); it only
 * manages the pairing/allowlist files. Zero dependencies, never throws on read.
 *
 * @module core/gateway/pairing
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Default pairing code TTL — 5 minutes (AC2). */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve `~/.aiox`.
 *
 * @param {string} [homeDir] - Home dir override (tests).
 * @returns {string}
 */
function aioxDir(homeDir) {
  // Honor an explicit override, then $HOME (respected at runtime, unlike
  // os.homedir() which may be cached), then the OS home dir.
  return path.join(homeDir || process.env.HOME || os.homedir(), '.aiox');
}

/**
 * Path to the pending-pairing file.
 * @param {string} [homeDir]
 * @returns {string}
 */
function pairingPath(homeDir) {
  return path.join(aioxDir(homeDir), 'gateway-pairing.json');
}

/**
 * Path to the allowlist file.
 * @param {string} [homeDir]
 * @returns {string}
 */
function gatewayPath(homeDir) {
  return path.join(aioxDir(homeDir), 'gateway.json');
}

/**
 * Ensure `~/.aiox` exists.
 * @param {string} [homeDir]
 */
function ensureDir(homeDir) {
  fs.mkdirSync(aioxDir(homeDir), { recursive: true });
}

/**
 * Write JSON with 0600 perms (best-effort chmod).
 *
 * @param {string} file - Target path.
 * @param {Object} data - Serializable payload.
 */
function writeSecure(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.chmodSync(file, 0o600);
  } catch (_err) {
    // chmod may not be supported (e.g. some Windows FS) — non-fatal.
  }
}

/**
 * Generate and persist a fresh 6-digit pairing code.
 *
 * @param {Object} [options]
 * @param {number} [options.ttlMs=300000] - Time-to-live in ms.
 * @param {string} [options.homeDir] - Home dir override (tests).
 * @returns {{code: string, expiresAt: number}}
 */
function generatePairingCode({ ttlMs = DEFAULT_TTL_MS, homeDir } = {}) {
  ensureDir(homeDir);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + ttlMs;
  writeSecure(pairingPath(homeDir), { code, expiresAt });
  return { code, expiresAt };
}

/**
 * Read the current pending pairing code (or null if none/malformed).
 *
 * @param {Object} [options]
 * @param {string} [options.homeDir]
 * @returns {{code: string, expiresAt: number}|null}
 */
function getPairingCode({ homeDir } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(pairingPath(homeDir), 'utf8'));
    if (!data || !data.code) {
      return null;
    }
    return { code: String(data.code), expiresAt: Number(data.expiresAt) || 0 };
  } catch (_err) {
    return null;
  }
}

/**
 * Read the allowlist document, always returning a normalized shape.
 *
 * @param {string} [homeDir]
 * @returns {{allowlist: string[]}}
 */
function readGateway(homeDir) {
  try {
    const data = JSON.parse(fs.readFileSync(gatewayPath(homeDir), 'utf8'));
    if (data && Array.isArray(data.allowlist)) {
      return { allowlist: data.allowlist.map(String) };
    }
  } catch (_err) {
    // Missing / malformed → empty allowlist.
  }
  return { allowlist: [] };
}

/**
 * List paired chat ids (as strings).
 *
 * @param {Object} [options]
 * @param {string} [options.homeDir]
 * @returns {string[]}
 */
function listPaired({ homeDir } = {}) {
  return readGateway(homeDir).allowlist;
}

/**
 * Whether a chat id is in the allowlist.
 *
 * @param {string|number} chatId - Chat id.
 * @param {Object} [options]
 * @param {string} [options.homeDir]
 * @returns {boolean}
 */
function isPaired(chatId, { homeDir } = {}) {
  return readGateway(homeDir).allowlist.includes(String(chatId));
}

/**
 * Add a chat id to the allowlist (idempotent).
 *
 * @param {string|number} chatId - Chat id.
 * @param {string} [homeDir]
 */
function addPaired(chatId, homeDir) {
  const gw = readGateway(homeDir);
  const id = String(chatId);
  if (!gw.allowlist.includes(id)) {
    gw.allowlist.push(id);
  }
  ensureDir(homeDir);
  writeSecure(gatewayPath(homeDir), gw);
}

/**
 * Attempt to pair a chat by matching the message text against the pending code.
 * On success the chat is added to the allowlist and the code is consumed.
 *
 * @param {string|number} chatId - Chat id attempting to pair.
 * @param {string} text - Raw message text.
 * @param {Object} [options]
 * @param {string} [options.homeDir]
 * @returns {boolean} True when the chat was paired.
 */
function tryPair(chatId, text, { homeDir } = {}) {
  const pairing = getPairingCode({ homeDir });
  if (!pairing) {
    return false;
  }
  if (Date.now() > pairing.expiresAt) {
    return false;
  }
  if (String(text || '').trim() !== pairing.code) {
    return false;
  }
  addPaired(chatId, homeDir);
  try {
    fs.unlinkSync(pairingPath(homeDir));
  } catch (_err) {
    // Best-effort consumption of the one-time code.
  }
  return true;
}

module.exports = {
  DEFAULT_TTL_MS,
  aioxDir,
  pairingPath,
  gatewayPath,
  generatePairingCode,
  getPairingCode,
  listPaired,
  isPaired,
  addPaired,
  tryPair,
};
