'use strict';

/**
 * Tests — AIOS Gateway Telegram (Story WSB-4.1).
 *
 * Safety rails for the whole suite:
 * - `global.fetch` is ALWAYS spied and defaults to rejecting with
 *   'unexpected real fetch' — any accidental real network call fails loudly.
 * - `HOME` is redirected to a throwaway dir per test, so `~/.aiox/*` (pairing,
 *   allowlist, credentials, brain, pid) never touches the developer's machine.
 *
 * Coverage: no-token → isAvailable false + zero fetch; pairing happy / expired /
 * unpaired rejected+logged; /status and /ask (real brain index) fixtures;
 * /approve writes decision.json; watcher detects + dedups; network backoff
 * sequence; notifyTelegram graceful without recipients.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const gateway = require('..');
const { TelegramClient } = require('../telegram-client');
const { watchEscalations } = require('../escalation-watcher');
const { handleCommand, writeDecision } = require('../commands');
const { processUpdate, processCallback } = require('../cli');
const {
  generatePairingCode,
  tryPair,
  isPaired,
  listPaired,
} = require('../pairing');

// ───────────────────────────────────────────────────────────────────────────
//                              FIXTURE HELPERS
// ───────────────────────────────────────────────────────────────────────────

let ORIGINAL_HOME;
let ORIGINAL_TOKEN;
let fetchSpy;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fetch double resolving a JSON Bot API "ok" response. */
function okResponse(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result }),
  };
}

beforeEach(() => {
  ORIGINAL_HOME = process.env.HOME;
  ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const fakeHome = tmp('wsb41-home-');
  process.env.HOME = fakeHome;
  delete process.env.TELEGRAM_BOT_TOKEN;

  // os.homedir() does NOT observe a runtime-mutated $HOME (it may be cached),
  // and consumed modules like BrainIndexer resolve their storage via os.homedir().
  // Spy it so EVERY ~/.aiox write (pairing, brain index, pid) lands in the fake home.
  jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);

  fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unexpected real fetch'));
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TOKEN;
  }
  jest.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
//                              TELEGRAM CLIENT — TOKEN
// ───────────────────────────────────────────────────────────────────────────

describe('TelegramClient — token resolution & availability', () => {
  test('no token anywhere → isAvailable false and ZERO fetch', async () => {
    const client = new TelegramClient({});
    expect(client.isAvailable()).toBe(false);

    await expect(client.getUpdates({})).rejects.toThrow(/sem token/);
    await expect(client.sendMessage(1, 'hi')).rejects.toThrow(/sem token/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('token from TELEGRAM_BOT_TOKEN env → available', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'env-token-123';
    expect(new TelegramClient({}).isAvailable()).toBe(true);
  });

  test('token from ~/.aiox/credentials.json → available', () => {
    const dir = path.join(process.env.HOME, '.aiox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ telegram: { bot_token: 'cred-token-xyz' } }),
    );
    expect(new TelegramClient({}).isAvailable()).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              PAIRING
// ───────────────────────────────────────────────────────────────────────────

describe('Pairing', () => {
  test('happy path: valid code pairs the chat and persists the allowlist', () => {
    const { code } = generatePairingCode({ ttlMs: 60000 });
    expect(code).toMatch(/^\d{6}$/);

    expect(isPaired('555')).toBe(false);
    expect(tryPair('555', code)).toBe(true);
    expect(isPaired('555')).toBe(true);
    expect(listPaired()).toContain('555');

    // Code is one-time: a second attempt with the same code fails.
    expect(tryPair('777', code)).toBe(false);
  });

  test('expired code is rejected', () => {
    const { code } = generatePairingCode({ ttlMs: -1 });
    expect(tryPair('555', code)).toBe(false);
    expect(isPaired('555')).toBe(false);
  });

  test('wrong code is rejected', () => {
    generatePairingCode({ ttlMs: 60000 });
    expect(tryPair('555', '000000')).toBe(false);
    expect(isPaired('555')).toBe(false);
  });

  test('unpaired message is rejected and logged (processUpdate)', async () => {
    const cwd = tmp('wsb41-cwd-');
    const client = { sendMessage: jest.fn().mockResolvedValue({}) };

    await processUpdate({
      update: { update_id: 1, message: { chat: { id: 999 }, text: 'olá' } },
      client,
      cwd,
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][1]).toMatch(/não pareado/i);

    const log = fs.readFileSync(path.join(cwd, '.aios', 'gateway', 'log.jsonl'), 'utf8');
    expect(log).toMatch(/rejected_unpaired/);
    expect(isPaired('999', { homeDir: process.env.HOME })).toBe(false);
  });

  test('valid pairing code sent as a message pairs via processUpdate', async () => {
    const cwd = tmp('wsb41-cwd-');
    const { code } = generatePairingCode({ ttlMs: 60000 });
    const client = { sendMessage: jest.fn().mockResolvedValue({}) };

    await processUpdate({
      update: { update_id: 1, message: { chat: { id: 42 }, text: code } },
      client,
      cwd,
    });

    expect(isPaired('42')).toBe(true);
    expect(client.sendMessage.mock.calls[0][1]).toMatch(/Pareado/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              COMMANDS
// ───────────────────────────────────────────────────────────────────────────

describe('Commands — deterministic dispatcher', () => {
  test('/status reports builds and recent zone transitions (no LLM, no fetch)', async () => {
    const cwd = tmp('wsb41-cwd-');
    const autonomyDir = path.join(cwd, '.aios', 'autonomy');
    fs.mkdirSync(autonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(autonomyDir, 'zone-log.json'),
      JSON.stringify([
        { timestamp: '2026-07-19T10:00:00Z', from: 'GREEN', to: 'YELLOW', storyId: 'WSB-4.1' },
      ]),
    );

    const res = await handleCommand({ chatId: 1, text: '/status', cwd });
    expect(res.text).toMatch(/YELLOW/);
    expect(res.text).toMatch(/WSB-4.1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('/ask searches the real brain index and returns sources', async () => {
    const workspace = tmp('wsb41-ws-');
    fs.writeFileSync(
      path.join(workspace, 'notes.md'),
      '# Gateway\n\nO pareamento do gateway Telegram usa um código de seis dígitos.\n',
    );

    // Build a real lexical index for this workspace (brainDir lives under fake HOME).
    const { BrainIndexer } = require('../../brain/indexer');
    await new BrainIndexer({ cwd: workspace }).index();

    const res = await handleCommand({ chatId: 1, text: '/ask pareamento', cwd: workspace });
    expect(res.text).toMatch(/notes\.md/);
    expect(res.text).toMatch(/fonte:/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('/ask with no query returns usage', async () => {
    const res = await handleCommand({ chatId: 1, text: '/ask', cwd: tmp('wsb41-cwd-') });
    expect(res.text).toMatch(/Uso: \/ask/);
  });

  test('unknown command falls back to help', async () => {
    const res = await handleCommand({ chatId: 1, text: '/frobnicate', cwd: tmp('wsb41-cwd-') });
    expect(res.text).toMatch(/desconhecido/i);
    expect(res.text).toMatch(/\/status/);
  });

  test('/approve writes an escalation decision.json for the orchestrator', async () => {
    const cwd = tmp('wsb41-cwd-');
    const id = '2026-07-19T10-00-00-000Z-stuck';

    const res = await handleCommand({ chatId: 77, text: `/approve ${id}`, cwd });
    expect(res.text).toMatch(/Aprovado/);

    const decisionPath = path.join(cwd, '.aios', 'autonomy', 'escalations', `${id}.decision.json`);
    const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
    expect(decision).toMatchObject({ id, decision: 'approved', via: 'telegram', chatId: '77' });
    expect(decision.decidedAt).toBeTruthy();
  });

  test('inline approve button (callback_query) writes decision.json + acks', async () => {
    const cwd = tmp('wsb41-cwd-');
    // Pair the chat first so the callback is authorized.
    const { code } = generatePairingCode({ ttlMs: 60000 });
    tryPair('88', code);

    const client = {
      answerCallbackQuery: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn().mockResolvedValue({}),
    };
    const id = 'esc-button-1';

    await processCallback({
      cb: { id: 'cbq-1', data: `approve:${id}`, message: { chat: { id: 88 } } },
      client,
      cwd,
    });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith('cbq-1');
    const decision = JSON.parse(
      fs.readFileSync(path.join(cwd, '.aios', 'autonomy', 'escalations', `${id}.decision.json`), 'utf8'),
    );
    expect(decision).toMatchObject({ decision: 'approved', via: 'telegram', chatId: '88' });
  });

  test('/reject writes a rejected decision.json', async () => {
    const cwd = tmp('wsb41-cwd-');
    const id = 'esc-123';
    writeDecision({ cwd, id, decision: 'rejected', chatId: 5 });
    const decision = JSON.parse(
      fs.readFileSync(path.join(cwd, '.aios', 'autonomy', 'escalations', `${id}.decision.json`), 'utf8'),
    );
    expect(decision.decision).toBe('rejected');
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              ESCALATION WATCHER
// ───────────────────────────────────────────────────────────────────────────

describe('Escalation watcher', () => {
  test('detects a new escalation once and deduplicates', async () => {
    const cwd = tmp('wsb41-cwd-');
    const escDir = path.join(cwd, '.aios', 'autonomy', 'escalations');
    fs.mkdirSync(escDir, { recursive: true });

    const seen = [];
    const watcher = watchEscalations({
      cwd,
      onEscalation: (esc) => seen.push(esc.id),
      intervalMs: 60000, // effectively disabled — we drive scanNow manually
    });

    await watcher.scanNow(); // empty dir → nothing
    expect(seen).toHaveLength(0);

    fs.writeFileSync(path.join(escDir, 'esc-1.md'), '# Escalação: stuck\n');
    await watcher.scanNow();
    await watcher.scanNow(); // second scan must NOT re-fire

    watcher.stop();
    expect(seen).toEqual(['esc-1']);
  });

  test('skips escalations that already have a decision', async () => {
    const cwd = tmp('wsb41-cwd-');
    const escDir = path.join(cwd, '.aios', 'autonomy', 'escalations');
    fs.mkdirSync(escDir, { recursive: true });
    fs.writeFileSync(path.join(escDir, 'esc-9.md'), '# Escalação\n');
    fs.writeFileSync(path.join(escDir, 'esc-9.decision.json'), '{"decision":"approved"}');

    const seen = [];
    const watcher = watchEscalations({ cwd, onEscalation: (e) => seen.push(e.id), intervalMs: 60000 });
    await watcher.scanNow();
    watcher.stop();
    expect(seen).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              NETWORK BACKOFF
// ───────────────────────────────────────────────────────────────────────────

describe('TelegramClient — retry/backoff', () => {
  test('exponential backoff on network errors (1s → 2s → 4s), then succeeds', async () => {
    const delays = [];
    const networkError = new TypeError('fetch failed');
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(okResponse([]));

    const client = new TelegramClient({
      token: 'x',
      fetch: fetchImpl,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    const updates = await client.getUpdates({});
    expect(updates).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(fetchSpy).not.toHaveBeenCalled(); // global fetch never touched
  });

  test('HTTP 4xx is not retried', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const client = new TelegramClient({ token: 'x', fetch: fetchImpl, sleep: () => Promise.resolve() });

    await expect(client.getUpdates({})).rejects.toThrow(/HTTP 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              NOTIFY
// ───────────────────────────────────────────────────────────────────────────

describe('notifyTelegram', () => {
  test('no token → graceful, no fetch', async () => {
    const res = await gateway.notifyTelegram({ title: 'x', body: 'y' });
    expect(res).toMatchObject({ notified: false, reason: 'no-token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('token present but no paired chats → graceful, no fetch', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    const res = await gateway.notifyTelegram({ title: 'x', body: 'y' });
    expect(res).toMatchObject({ notified: false, reason: 'no-recipients' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('token + paired chats → sends to each recipient', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    generatePairingCode({ ttlMs: 60000 });
    const { getPairingCode } = require('../pairing');
    tryPair('111', getPairingCode().code);

    const client = { isAvailable: () => true, sendMessage: jest.fn().mockResolvedValue({}) };
    const res = await gateway.notifyTelegram({
      title: 'Escalação',
      body: 'stuck',
      buttons: [{ text: 'ok', data: 'approve:1' }],
      client,
    });

    expect(res).toMatchObject({ notified: true, count: 1 });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][0]).toBe('111');
  });
});
