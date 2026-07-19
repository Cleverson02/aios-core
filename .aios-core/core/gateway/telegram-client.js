'use strict';

/**
 * AIOS Gateway — Telegram Bot API client (Story WSB-4.1, AC1/AC5/AC6).
 *
 * A thin, dependency-free client over the Telegram Bot API using native
 * `fetch` + `AbortController`. It is a *client of the CLI* (Constitution Art. I):
 * it moves bytes, it takes no product decisions and it never touches an LLM.
 *
 * Design guarantees:
 * - Zero new dependencies (native fetch/AbortController only).
 * - Long polling via `getUpdates` with a request timeout slightly larger than
 *   the server-side long-poll window so the socket is never killed prematurely.
 * - Network errors (fetch reject / abort / 5xx) retry with exponential backoff
 *   (1s → 2s → 4s → … capped at 30s); HTTP 4xx never retries (client error).
 * - Graceful degradation: no token → `isAvailable()` is false and NO request is
 *   ever issued (AC6 — "zero requests sem token").
 * - The bot token is NEVER logged nor embedded in any thrown message.
 *
 * @module core/gateway/telegram-client
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Default Telegram Bot API origin. */
const DEFAULT_API_BASE = 'https://api.telegram.org';

/** Backoff base delay (ms). */
const DEFAULT_BASE_DELAY_MS = 1000;

/** Backoff ceiling (ms). */
const DEFAULT_MAX_DELAY_MS = 30000;

/** Retries per request before giving up on a network/5xx error. */
const DEFAULT_MAX_RETRIES = 5;

/** Telegram hard limit for a single text message. */
const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Resolve a bot token from (in order): explicit value → `TELEGRAM_BOT_TOKEN`
 * env → `~/.aiox/credentials.json` (`telegram.bot_token`). Never throws.
 *
 * The credentials file is only *read* here — the credentials store module is
 * owned by another agent; this client merely consumes the file if present.
 *
 * @param {string} [explicit] - Explicitly provided token.
 * @param {Object} [options]
 * @param {string} [options.homeDir] - Override home dir (tests).
 * @returns {string|null}
 */
function resolveToken(explicit, { homeDir } = {}) {
  if (explicit) {
    return String(explicit);
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return String(process.env.TELEGRAM_BOT_TOKEN);
  }
  try {
    const home = homeDir || process.env.HOME || os.homedir();
    const credPath = path.join(home, '.aiox', 'credentials.json');
    if (fs.existsSync(credPath)) {
      const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const token = data && data.telegram && data.telegram.bot_token;
      if (token) {
        return String(token);
      }
    }
  } catch (_err) {
    // Unreadable / malformed credentials → treat as no token (graceful).
  }
  return null;
}

/**
 * Normalize a caller-friendly `buttons` value into a Telegram `inline_keyboard`.
 *
 * Accepts either a flat array (single row) or an array of rows. Each button:
 * `{ text, data }` → callback button (`callback_data`), or `{ text, url }`.
 *
 * @param {Array|undefined} buttons - Buttons spec.
 * @returns {Array<Array<Object>>|null} inline_keyboard rows, or null.
 */
function buildInlineKeyboard(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return null;
  }
  const rows = Array.isArray(buttons[0]) ? buttons : [buttons];
  return rows.map((row) =>
    row.map((b) => {
      const btn = { text: String(b.text) };
      if (b.url) {
        btn.url = String(b.url);
      } else {
        btn.callback_data = String(b.data != null ? b.data : b.callback_data != null ? b.callback_data : b.text);
      }
      return btn;
    }),
  );
}

/**
 * Whether an error is a retryable transport error (network reject, abort/timeout
 * or a tagged 5xx). HTTP 4xx errors are deliberately NOT retryable.
 *
 * @param {Error} err - Caught error.
 * @returns {boolean}
 */
function isRetryable(err) {
  return Boolean(
    err && (err.retryable === true || err.name === 'AbortError' || err.name === 'TypeError'),
  );
}

/**
 * Telegram Bot API client.
 */
class TelegramClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.token] - Explicit token (else env / credentials).
   * @param {string} [options.homeDir] - Override home dir for credentials read (tests).
   * @param {Function} [options.fetch] - Injected fetch (tests); defaults to global.fetch at call time.
   * @param {Function} [options.sleep] - Injected sleep(ms) (tests); defaults to setTimeout.
   * @param {string} [options.apiBase] - API origin override (tests).
   * @param {number} [options.maxRetries] - Max retries per request.
   * @param {number} [options.baseDelayMs] - Backoff base delay.
   * @param {number} [options.maxDelayMs] - Backoff ceiling.
   */
  constructor(options = {}) {
    this.token = resolveToken(options.token, { homeDir: options.homeDir });
    this._fetch = typeof options.fetch === 'function' ? options.fetch : null;
    this.sleep =
      typeof options.sleep === 'function'
        ? options.sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.apiBase = options.apiBase || DEFAULT_API_BASE;
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
    this.baseDelay = options.baseDelayMs || DEFAULT_BASE_DELAY_MS;
    this.maxDelay = options.maxDelayMs || DEFAULT_MAX_DELAY_MS;
  }

  /**
   * True when a token is configured. When false, no request is ever issued.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.token);
  }

  /**
   * Long-poll for updates.
   *
   * @param {Object} [params]
   * @param {number} [params.offset] - `update_id` of the first update to return.
   * @param {number} [params.timeoutSec=50] - Server-side long-poll seconds.
   * @returns {Promise<Array<Object>>} Updates (empty array on none).
   */
  async getUpdates({ offset, timeoutSec = 50 } = {}) {
    const body = { timeout: timeoutSec };
    if (offset != null) {
      body.offset = offset;
    }
    // Give the socket ~10s of slack beyond the server long-poll window.
    const result = await this._request('getUpdates', body, { timeoutMs: timeoutSec * 1000 + 10000 });
    return Array.isArray(result) ? result : [];
  }

  /**
   * Send a text message, optionally with an inline keyboard.
   *
   * @param {string|number} chatId - Target chat id.
   * @param {string} text - Message text (truncated to Telegram's limit).
   * @param {Object} [options]
   * @param {Array} [options.buttons] - Inline buttons (see buildInlineKeyboard).
   * @param {string} [options.parseMode] - e.g. 'Markdown' / 'MarkdownV2'.
   * @returns {Promise<Object>} Sent message.
   */
  async sendMessage(chatId, text, { buttons, parseMode } = {}) {
    const body = { chat_id: chatId, text: truncate(String(text), TELEGRAM_TEXT_LIMIT) };
    if (parseMode) {
      body.parse_mode = parseMode;
    }
    const keyboard = buildInlineKeyboard(buttons);
    if (keyboard) {
      body.reply_markup = { inline_keyboard: keyboard };
    }
    return this._request('sendMessage', body, { timeoutMs: 15000 });
  }

  /**
   * Acknowledge a callback query (stops Telegram's spinner on the button).
   *
   * @param {string} callbackQueryId - The callback query id.
   * @param {Object} [options]
   * @param {string} [options.text] - Optional toast text.
   * @returns {Promise<Object>}
   */
  async answerCallbackQuery(callbackQueryId, { text } = {}) {
    const body = { callback_query_id: callbackQueryId };
    if (text) {
      body.text = text;
    }
    return this._request('answerCallbackQuery', body, { timeoutMs: 15000 });
  }

  /**
   * Issue a Bot API method with retry/backoff. Never logs the token nor the URL.
   *
   * @private
   * @param {string} method - Bot API method name.
   * @param {Object} body - JSON body.
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=15000] - Per-attempt abort timeout.
   * @returns {Promise<*>} The `result` field of the API response.
   */
  async _request(method, body, { timeoutMs = 15000 } = {}) {
    if (!this.isAvailable()) {
      // AC6: zero requests without a token.
      throw new Error(`Telegram indisponível: sem token (método ${method})`);
    }

    const url = `${this.apiBase}/bot${this.token}/${method}`;
    const doFetch = this._fetch || global.fetch;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) {
            // Client error — not retryable (bad token, bad request, ...).
            throw new Error(`Telegram HTTP ${res.status} em ${method}`);
          }
          const serverErr = new Error(`Telegram HTTP ${res.status} em ${method}`);
          serverErr.retryable = true;
          throw serverErr;
        }

        const data = await res.json();
        if (!data || data.ok !== true) {
          throw new Error(`Telegram API erro em ${method}: ${(data && data.description) || 'desconhecido'}`);
        }
        return data.result;
      } catch (err) {
        clearTimeout(timer);
        if (!isRetryable(err) || attempt >= this.maxRetries) {
          throw err;
        }
        const delay = Math.min(this.baseDelay * 2 ** attempt, this.maxDelay);
        attempt += 1;
        await this.sleep(delay);
      }
    }
  }
}

/**
 * Truncate a string to `max` chars, appending an ellipsis when cut.
 *
 * @param {string} text - Input text.
 * @param {number} max - Maximum length.
 * @returns {string}
 */
function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = {
  TelegramClient,
  resolveToken,
  buildInlineKeyboard,
  isRetryable,
  truncate,
};
