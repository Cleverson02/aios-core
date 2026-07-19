'use strict';

/**
 * AIOS Gateway — Command dispatcher (Story WSB-4.1, AC3/AC4).
 *
 * A *deterministic* dispatcher: the gateway is a client of the CLI, so every
 * command maps to an existing CLI/module source of truth and returns a plain
 * `{ text, buttons? }` payload. ZERO tokens of LLM are spent here:
 *
 *   /status     → autonomy build state (BuildStateManager.formatAllBuilds) + zone-log
 *   /ask <q>    → brain lexical search (BrainIndexer.search) with sources
 *   /handoffs   → list handoff packets under .aios/autonomy/handoffs
 *   /approve id → write .aios/autonomy/escalations/<id>.decision.json (approved)
 *   /reject  id → write .aios/autonomy/escalations/<id>.decision.json (rejected)
 *   /report     → session digest (dry-run) summary
 *   /help,/start,unknown → help
 *
 * Consumed (require-only, never modified): core/execution/build-state-manager,
 * core/brain/indexer, core/brain/digest. Zero new dependencies.
 *
 * @module core/gateway/commands
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

/** Escalation records + decisions live here (matches core/autonomy/escalation.js). */
const ESCALATIONS_SUBDIR = path.join('.aios', 'autonomy', 'escalations');

/** Zone transition log written by ContextBudgetManager. */
const ZONE_LOG_SUBPATH = path.join('.aios', 'autonomy', 'zone-log.json');

/** Handoff packets directory (matches core/autonomy HANDOFF_DIR). */
const HANDOFFS_SUBDIR = path.join('.aios', 'autonomy', 'handoffs');

/** Telegram message budget we target for command replies. */
const REPLY_LIMIT = 4000;

/** Max brain search results surfaced in a /ask reply. */
const ASK_RESULTS = 3;

/**
 * Handle a paired chat's command message.
 *
 * @param {Object} params
 * @param {string|number} params.chatId - Origin chat id.
 * @param {string} params.text - Raw message text.
 * @param {string} [params.cwd] - Workspace root (defaults to process.cwd()).
 * @returns {Promise<{text: string, buttons?: Array, decision?: Object}>}
 */
async function handleCommand({ chatId, text, cwd = process.cwd() } = {}) {
  const raw = String(text || '').trim();
  const firstSpace = raw.search(/\s/);
  const head = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const arg = firstSpace === -1 ? '' : raw.slice(firstSpace + 1).trim();
  // Normalize: strip leading slash and an optional @botname suffix.
  const cmd = head.toLowerCase().replace(/^\//, '').split('@')[0];

  switch (cmd) {
    case 'status':
      return cmdStatus(cwd);
    case 'ask':
      return cmdAsk(cwd, arg);
    case 'handoffs':
      return cmdHandoffs(cwd);
    case 'approve':
      return cmdDecision(cwd, arg, 'approved', chatId);
    case 'reject':
      return cmdDecision(cwd, arg, 'rejected', chatId);
    case 'report':
      return cmdReport(cwd);
    case 'start':
    case 'help':
    case '':
      return cmdHelp();
    default:
      return cmdHelp(cmd);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `/status` — autonomy builds + recent context-zone transitions.
 * @param {string} cwd
 * @returns {Promise<{text: string}>}
 */
async function cmdStatus(cwd) {
  const lines = [];

  try {
    const { BuildStateManager } = require('../execution/build-state-manager');
    const builds = stripAnsi(BuildStateManager.formatAllBuilds(cwd)).trim();
    lines.push(builds || 'Sem builds ativos.');
  } catch (_err) {
    lines.push('Builds: indisponível no momento.');
  }

  const zones = readZoneLog(cwd).slice(-5);
  if (zones.length) {
    lines.push('', 'Zonas de contexto recentes:');
    for (const z of zones) {
      const story = z.storyId ? ` [${z.storyId}]` : '';
      lines.push(`  ${z.timestamp || ''} ${z.from || '·'} → ${z.to}${story}`.trim());
    }
  }

  return { text: truncate(lines.join('\n')) };
}

/**
 * `/ask <pergunta>` — local brain lexical search (no LLM), with sources.
 * @param {string} cwd
 * @param {string} query
 * @returns {Promise<{text: string}>}
 */
async function cmdAsk(cwd, query) {
  if (!query) {
    return { text: 'Uso: /ask <pergunta>' };
  }

  let results = [];
  try {
    const { BrainIndexer } = require('../brain/indexer');
    const indexer = new BrainIndexer({ cwd });
    results = await indexer.search(query, { limit: ASK_RESULTS });
  } catch (_err) {
    return { text: 'Brain indisponível no momento.' };
  }

  if (!results.length) {
    return { text: `Nada encontrado no brain para: "${query}"` };
  }

  const lines = [`🔎 ${results.length} resultado(s) para "${query}":`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.heading || r.file}`);
    lines.push(`   fonte: ${r.file}${r.area ? ` (${r.area})` : ''}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
    lines.push('');
  });
  return { text: truncate(lines.join('\n')) };
}

/**
 * `/handoffs` — list handoff packets awaiting resume.
 * @param {string} cwd
 * @returns {Promise<{text: string}>}
 */
async function cmdHandoffs(cwd) {
  let packets = [];
  try {
    packets = fs
      .readdirSync(path.join(cwd, HANDOFFS_SUBDIR))
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (_err) {
    packets = [];
  }

  if (!packets.length) {
    return { text: 'Nenhum handoff packet pendente.' };
  }

  const lines = [`📦 ${packets.length} handoff packet(s):`, ...packets.slice(-10).map((p) => `  ${p}`)];
  return { text: truncate(lines.join('\n')) };
}

/**
 * `/approve <id>` or `/reject <id>` — persist the human decision for an escalation.
 * @param {string} cwd
 * @param {string} id - Escalation id (filename without .md).
 * @param {'approved'|'rejected'} decision
 * @param {string|number} chatId
 * @returns {Promise<{text: string, decision?: Object}>}
 */
async function cmdDecision(cwd, id, decision, chatId) {
  const escId = String(id || '').trim().replace(/\.md$/, '');
  if (!escId) {
    const verb = decision === 'approved' ? 'approve' : 'reject';
    return { text: `Uso: /${verb} <id-da-escalação>` };
  }

  const result = writeDecision({ cwd, id: escId, decision, chatId });
  const label = decision === 'approved' ? '✅ Aprovado' : '⛔ Rejeitado';
  return {
    text: `${label}: ${escId}\nDecisão gravada — o orquestrador/heartbeat irá consumi-la.`,
    decision: result,
  };
}

/**
 * `/report` — session digest of the day (dry-run: nothing is written).
 * @param {string} cwd
 * @returns {Promise<{text: string}>}
 */
async function cmdReport(cwd) {
  try {
    const { generateDigest } = require('../brain/digest');
    const result = await generateDigest({ cwd, dryRun: true });
    const s = result.sections;
    const lines = [
      '📊 Report do dia (dry-run):',
      `- ${s.commits} commit(s)`,
      `- ${s.files} arquivo(s) alterado(s)`,
      `- ${s.decisions} decisão(ões)`,
      `- ${s.gotchas} aprendizado(s)`,
    ];
    return { text: truncate(lines.join('\n')) };
  } catch (_err) {
    return { text: 'Report indisponível no momento.' };
  }
}

/**
 * Help / unknown-command reply.
 * @param {string} [unknown] - The unrecognized command (if any).
 * @returns {{text: string}}
 */
function cmdHelp(unknown) {
  const header = unknown ? `Comando desconhecido: /${unknown}\n\n` : '';
  const body = [
    '🤖 AIOX Gateway — comandos:',
    '/status — builds e zonas de contexto',
    '/ask <pergunta> — busca no brain (local, sem LLM)',
    '/handoffs — handoff packets pendentes',
    '/approve <id> — aprovar uma escalação',
    '/reject <id> — rejeitar uma escalação',
    '/report — digest do dia',
    '/help — esta ajuda',
  ].join('\n');
  return { text: `${header}${body}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Persist an escalation decision for the orchestrator/heartbeat to consume.
 *
 * @param {Object} params
 * @param {string} [params.cwd]
 * @param {string} params.id - Escalation id (filename without .md).
 * @param {'approved'|'rejected'} params.decision
 * @param {string|number} [params.chatId] - Deciding chat id.
 * @returns {{filePath: string, payload: Object}}
 */
function writeDecision({ cwd = process.cwd(), id, decision, chatId } = {}) {
  const dir = path.join(cwd, ESCALATIONS_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.decision.json`);
  const payload = {
    id,
    decision,
    decidedAt: new Date().toISOString(),
    via: 'telegram',
    chatId: chatId != null ? String(chatId) : null,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { filePath, payload };
}

/**
 * Read the ContextBudgetManager zone-transition log (never throws).
 * @param {string} cwd
 * @returns {Array<Object>}
 */
function readZoneLog(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, ZONE_LOG_SUBPATH), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

/**
 * Strip ANSI color codes (chalk output is meaningless in a Telegram message).
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate to the Telegram-friendly reply budget.
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const s = String(text == null ? '' : text);
  return s.length > REPLY_LIMIT ? `${s.slice(0, REPLY_LIMIT - 1)}…` : s;
}

module.exports = {
  handleCommand,
  writeDecision,
  ESCALATIONS_SUBDIR,
};
