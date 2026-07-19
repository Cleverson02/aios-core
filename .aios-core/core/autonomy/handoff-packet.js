/**
 * Handoff Packet — Autonomy Engine (Story WSB-3.2)
 *
 * When a session reaches the RED context zone, it must migrate to a clean
 * window instead of degrading inside a saturated one. This module snapshots
 * everything the fresh window needs to continue seamlessly:
 *
 *   build state (checkpoints + next subtask) ← build-state-manager (REUSE, 8.4)
 *   story file + open checkboxes             ← docs/stories/**
 *   autonomous decisions                     ← SessionMemory (REUSE, WSB-0.2)
 *   recent decision logs                     ← .ai/*.md
 *   relevant gotchas                         ← GotchasMemory (REUSE, Epic 9)
 *   zone/reason snapshot                     ← caller (Context Budget Manager)
 *
 * The packet is persisted as a Markdown twin (the fresh session's first
 * context) plus a JSON twin (machine resume) under
 * `.aios/autonomy/handoffs/<storyId>-<n>.{md,json}`. `<n>` is incremental and
 * NEVER overwrites a previous handoff.
 *
 * Everything degrades gracefully: any missing source becomes an omitted
 * section, never a crash (AC5). Zero new dependencies.
 *
 * @module core/autonomy/handoff-packet
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Handoff artifacts live under `.aios/autonomy/handoffs/` (relative to cwd). */
const HANDOFF_DIR = path.join('.aios', 'autonomy', 'handoffs');

/** Caps keep the packet small — it must fit in a FRESH window's first prompt. */
const DECISIONS_LIMIT = 10;
const DECISION_LOGS_LIMIT = 5;
const GOTCHAS_LIMIT = 5;
const OPEN_CHECKBOX_RENDER_LIMIT = 15;

const PACKET_SCHEMA_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════════════════════════
//                              GENERATE
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Generate (and persist) a handoff packet for a story.
 *
 * @param {Object} params
 * @param {string} params.storyId - Story being executed (required).
 * @param {string} [params.cwd] - Project root (default process.cwd()).
 * @param {string} [params.reason] - Why the handoff happened (e.g. 'red-zone').
 * @param {Object} [params.zoneSnapshot] - Zone/bracket snapshot from the budget manager.
 * @returns {Promise<{path: string, jsonPath: string, packet: Object}>}
 *          `path` is the Markdown twin; `jsonPath` the JSON twin.
 */
async function generateHandoffPacket({
  cwd = process.cwd(),
  storyId,
  reason = 'red-zone',
  zoneSnapshot = null,
} = {}) {
  if (!storyId) {
    throw new Error('storyId is required to generate a handoff packet');
  }

  const story = collectStoryProgress(storyId, cwd);
  const build = collectBuildState(storyId, cwd);
  const { decisions, decisionLogs } = await collectDecisions(cwd);

  // Task description drives gotcha relevance scoring (story-focused).
  const taskDescription = [storyId, story && story.title, 'handoff', 'resume', 'continuation']
    .filter(Boolean)
    .join(' ');
  const gotchas = collectGotchas(cwd, taskDescription);

  const nextSubtask =
    (build && build.nextSubtask) ||
    (story && story.openCheckboxes && story.openCheckboxes[0]) ||
    null;

  const dir = path.join(cwd, HANDOFF_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const fileId = sanitizeId(storyId);
  const sequence = nextSequence(dir, fileId);

  const packet = {
    schemaVersion: PACKET_SCHEMA_VERSION,
    storyId,
    sequence,
    createdAt: new Date().toISOString(),
    reason,
    zoneSnapshot: zoneSnapshot || null,
    build: build || null,
    nextSubtask,
    story: story || null,
    decisions,
    decisionLogs,
    gotchas,
  };

  const base = `${fileId}-${sequence}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(packet), 'utf8');

  return { path: markdownPath, jsonPath, markdownPath, packet };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              LOAD
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Load a handoff packet by explicit path or by story id (latest sequence).
 *
 * @param {string} storyIdOrPath - A story id, or a `.json`/`.md` packet path.
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root (default process.cwd()).
 * @returns {Promise<{packet: Object, path: string, markdown: (string|null)}|null>}
 *          `path` is the Markdown twin; null when nothing resolves.
 */
async function loadHandoffPacket(storyIdOrPath, { cwd = process.cwd() } = {}) {
  if (!storyIdOrPath) return null;

  if (looksLikePath(storyIdOrPath)) {
    return loadFromPath(storyIdOrPath, cwd);
  }
  return resolveLatest(storyIdOrPath, cwd);
}

/**
 * Backward-compatible resolver for the autonomy barrel/CLI (lead-owned).
 * Returns the newest packet for a story as `{packet, jsonPath}` (sync).
 *
 * @param {Object} [params]
 * @param {string} [params.storyId] - Story to resume.
 * @param {string} [params.projectRoot] - Project root (default process.cwd()).
 * @returns {{packet: Object, jsonPath: string}|null}
 */
function loadLatestHandoffPacket({ storyId, projectRoot = process.cwd() } = {}) {
  if (!storyId) return null;
  const resolved = resolveLatestSync(storyId, projectRoot);
  if (!resolved) return null;
  return { packet: resolved.packet, jsonPath: resolved.jsonPath };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              COLLECTORS (graceful degradation)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build state via BuildStateManager — null when absent/broken (AC5).
 * @private
 * @param {string} storyId
 * @param {string} cwd
 * @returns {Object|null}
 */
function collectBuildState(storyId, cwd) {
  try {
    const { BuildStateManager } = require('../execution/build-state-manager');
    const manager = new BuildStateManager(storyId, { rootPath: cwd });
    const state = manager.loadState();
    if (!state) return null;

    const completedSubtasks = state.completedSubtasks || [];
    let nextSubtask = null;
    if (state.currentSubtask && !completedSubtasks.includes(state.currentSubtask)) {
      nextSubtask = state.currentSubtask;
    }

    const lastCheckpoint = manager.getLastCheckpoint();

    return {
      status: state.status,
      currentSubtask: state.currentSubtask || null,
      nextSubtask,
      completedSubtasks,
      lastCheckpoint: state.lastCheckpoint || null,
      lastCheckpointId: (lastCheckpoint && lastCheckpoint.id) || null,
      checkpointCount: (state.checkpoints || []).length,
      worktree: state.worktree || null,
      metrics: state.metrics || null,
    };
  } catch {
    return null;
  }
}

/**
 * Story file + checkbox progress — null when the story isn't found (AC5).
 * @private
 * @param {string} storyId
 * @param {string} cwd
 * @returns {Object|null}
 */
function collectStoryProgress(storyId, cwd) {
  const storyPath = findStoryFile(storyId, cwd);
  if (!storyPath) return null;

  try {
    const raw = fs.readFileSync(storyPath, 'utf8');
    const openCheckboxes = [];
    let doneCount = 0;

    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
      if (!match) continue;
      if (match[1] === ' ') {
        openCheckboxes.push(match[2].trim());
      } else {
        doneCount += 1;
      }
    }

    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const statusMatch = raw.match(/\*\*Status:\*\*\s*(.+)$/m);

    return {
      path: path.relative(cwd, storyPath),
      title: (titleMatch && titleMatch[1].trim()) || storyId,
      status: (statusMatch && statusMatch[1].trim()) || null,
      openCheckboxes,
      doneCount,
    };
  } catch {
    return null;
  }
}

/**
 * Recursive scan of docs/stories for `story*<storyId>*.md` (case-insensitive).
 * @private
 * @param {string} storyId
 * @param {string} cwd
 * @returns {string|null} Absolute path or null.
 */
function findStoryFile(storyId, cwd) {
  const storiesRoot = path.join(cwd, 'docs', 'stories');
  if (!fs.existsSync(storiesRoot)) return null;

  const needle = String(storyId).toLowerCase();
  const stack = [storiesRoot];
  let fallback = null;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

      const lower = entry.name.toLowerCase();
      if (!lower.includes(needle)) continue;

      // Prefer files that follow the `story*<id>*.md` convention.
      if (lower.startsWith('story')) {
        return full;
      }
      if (!fallback) fallback = full;
    }
  }
  return fallback;
}

/**
 * Autonomous decisions via SessionMemory (WSB-0.2) + recent .ai/*.md titles.
 * @private
 * @param {string} cwd
 * @returns {Promise<{decisions: Array, decisionLogs: Array}>}
 */
async function collectDecisions(cwd) {
  let decisions = [];
  try {
    const SessionMemory = require('../memory/session-memory');
    const memory = new SessionMemory({ projectRoot: cwd });
    decisions = await memory.getDecisions({ limit: DECISIONS_LIMIT });
  } catch {
    decisions = [];
  }

  return { decisions, decisionLogs: recentDecisionLogTitles(cwd) };
}

/**
 * Titles (first markdown header) of the most recent `.ai/*.md` decision logs.
 * @private
 * @param {string} cwd
 * @returns {Array<{title: string, timestamp: string}>}
 */
function recentDecisionLogTitles(cwd) {
  const dir = path.join(cwd, '.ai');
  const results = [];
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => path.join(dir, name));

    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const header = (raw.match(/^#{1,6}\s+(.+)$/m) || [])[1];
        results.push({
          title: (header && header.trim()) || path.basename(file, '.md'),
          timestamp: fs.statSync(file).mtime.toISOString(),
        });
      } catch {
        // Skip unreadable files.
      }
    }
  } catch {
    return [];
  }

  results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return results.slice(0, DECISION_LOGS_LIMIT);
}

/**
 * Gotchas relevant to the story via GotchasMemory (Epic 9) — [] on any failure.
 * @private
 * @param {string} cwd
 * @param {string} taskDescription
 * @returns {Array<{title: string, category: string, severity: string}>}
 */
function collectGotchas(cwd, taskDescription) {
  try {
    const GotchasMemory = require('../memory/gotchas-memory');
    const memory = new GotchasMemory(cwd, { quiet: true });
    const relevant = memory.getContextForTask(taskDescription, []);
    return relevant
      .slice(0, GOTCHAS_LIMIT)
      .map((g) => ({ title: g.title, category: g.category, severity: g.severity }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RENDERING
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Render the packet as the fresh window's initial context (Markdown).
 * Absent sources are omitted entirely (AC5).
 *
 * @param {Object} packet - Handoff packet.
 * @returns {string} Markdown document with YAML front-matter.
 */
function renderMarkdown(packet) {
  const lines = [];

  // Front-matter (AC2).
  lines.push('---');
  lines.push(`storyId: ${packet.storyId}`);
  lines.push(`sequence: ${packet.sequence}`);
  lines.push(`createdAt: ${packet.createdAt}`);
  lines.push(`reason: ${packet.reason}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Handoff Packet — ${packet.storyId} (#${packet.sequence})`);
  lines.push('');
  lines.push(`> Gerado em ${packet.createdAt} · motivo: **${packet.reason}**`);
  lines.push('');

  if (packet.zoneSnapshot) {
    const z = packet.zoneSnapshot;
    lines.push(
      `Janela anterior: zona **${z.zone || '?'}**, ` +
        `${z.percentUsed != null ? `${z.percentUsed}% usado` : 'uso desconhecido'}` +
        `${z.bracket ? ` (bracket ${z.bracket})` : ''}.`,
    );
    lines.push('');
  }

  // Estado do Build.
  if (packet.build) {
    const b = packet.build;
    lines.push('## Estado do Build');
    lines.push('');
    lines.push(`- Status: ${b.status}`);
    lines.push(`- Subtasks concluídas: ${b.completedSubtasks.length}` +
      (b.completedSubtasks.length ? ` (${b.completedSubtasks.join(', ')})` : ''));
    if (b.lastCheckpoint) {
      lines.push(`- Último checkpoint: ${b.lastCheckpoint}` + (b.lastCheckpointId ? ` (${b.lastCheckpointId})` : ''));
    }
    if (b.worktree) lines.push(`- Worktree: ${b.worktree}`);
    lines.push('');
  }

  // Próxima Subtask.
  lines.push('## Próxima Subtask');
  lines.push('');
  lines.push(packet.nextSubtask ? `- ${packet.nextSubtask}` : '- (determinar a partir da story)');
  lines.push('');

  // Story.
  if (packet.story) {
    const s = packet.story;
    lines.push('## Story');
    lines.push('');
    lines.push(`- Arquivo: \`${s.path}\``);
    if (s.status) lines.push(`- Status: ${s.status}`);
    lines.push(`- Checkboxes concluídos: ${s.doneCount}`);
    if (s.openCheckboxes.length) {
      lines.push('- Pendências:');
      for (const item of s.openCheckboxes.slice(0, OPEN_CHECKBOX_RENDER_LIMIT)) {
        lines.push(`  - [ ] ${item}`);
      }
    }
    lines.push('');
  }

  // Decisões.
  if ((packet.decisions && packet.decisions.length) ||
      (packet.decisionLogs && packet.decisionLogs.length)) {
    lines.push('## Decisões');
    lines.push('');
    for (const d of packet.decisions || []) {
      lines.push(`- ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`);
    }
    for (const log of packet.decisionLogs || []) {
      lines.push(`- (log) ${log.title}`);
    }
    lines.push('');
  }

  // Gotchas.
  if (packet.gotchas && packet.gotchas.length) {
    lines.push('## Gotchas');
    lines.push('');
    for (const g of packet.gotchas) {
      lines.push(`- [${g.severity}] ${g.title} (${g.category})`);
    }
    lines.push('');
  }

  // Instruções de Retomada — exactly how to continue, in one paragraph.
  lines.push('## Instruções de Retomada');
  lines.push('');
  lines.push(buildResumeParagraph(packet));
  lines.push('');
  lines.push('```bash');
  lines.push(`aios run resume ${packet.storyId}`);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

/**
 * One-paragraph, prescriptive continuation instruction.
 * @private
 * @param {Object} packet
 * @returns {string}
 */
function buildResumeParagraph(packet) {
  const next = packet.nextSubtask || 'a próxima pendência da story';
  const storyPath = (packet.story && packet.story.path) || 'a story';
  const done =
    packet.build && packet.build.completedSubtasks.length
      ? ` Já estão concluídas as subtasks ${packet.build.completedSubtasks.join(', ')} — não as refaça.`
      : '';
  return (
    'Abra uma janela limpa, ative o agente @dev e leia este pacote por completo antes de agir. ' +
    `Retome exatamente a partir de **${next}**, usando \`${storyPath}\` como fonte de verdade dos ` +
    `critérios de aceite.${done} ` +
    `Rode \`aios run resume ${packet.storyId}\` para recarregar o contexto e siga a ordem ` +
    'Read task → Implement → Test → Validate → marcar checkbox, mantendo a File List da story atualizada.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Compute the next incremental sequence number for a story (never overwrites).
 * @private
 * @param {string} dir - Absolute handoffs directory.
 * @param {string} fileId - Sanitized story id.
 * @returns {number}
 */
function nextSequence(dir, fileId) {
  let max = 0;
  try {
    if (fs.existsSync(dir)) {
      const re = new RegExp(`^${escapeRegex(fileId)}-(\\d+)\\.json$`);
      for (const name of fs.readdirSync(dir)) {
        const m = name.match(re);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
  } catch {
    // Fall through to max = 0.
  }
  return max + 1;
}

/**
 * Resolve the newest packet for a story (async wrapper of resolveLatestSync).
 * @private
 */
async function resolveLatest(storyId, cwd) {
  const resolved = resolveLatestSync(storyId, cwd);
  if (!resolved) return null;
  return {
    packet: resolved.packet,
    path: resolved.markdownPath,
    markdown: resolved.markdown,
  };
}

/**
 * Resolve the newest packet for a story synchronously.
 * @private
 * @returns {{packet: Object, jsonPath: string, markdownPath: string, markdown: (string|null)}|null}
 */
function resolveLatestSync(storyId, cwd) {
  const dir = path.join(cwd, HANDOFF_DIR);
  if (!fs.existsSync(dir)) return null;

  const fileId = sanitizeId(storyId);
  const re = new RegExp(`^${escapeRegex(fileId)}-(\\d+)\\.json$`);

  let best = null;
  let bestSeq = -1;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(re);
      if (m) {
        const seq = parseInt(m[1], 10);
        if (seq > bestSeq) {
          bestSeq = seq;
          best = path.join(dir, name);
        }
      }
    }
  } catch {
    return null;
  }

  if (!best) return null;
  return readTwins(best, best.replace(/\.json$/, '.md'));
}

/**
 * Load a packet from an explicit `.json`/`.md` path (either twin works).
 * @private
 */
function loadFromPath(inputPath, cwd) {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);

  let jsonPath;
  let markdownPath;
  if (abs.endsWith('.json')) {
    jsonPath = abs;
    markdownPath = abs.replace(/\.json$/, '.md');
  } else if (abs.endsWith('.md')) {
    markdownPath = abs;
    jsonPath = abs.replace(/\.md$/, '.json');
  } else {
    return null;
  }

  const twins = readTwins(jsonPath, markdownPath);
  if (!twins) return null;
  return { packet: twins.packet, path: twins.markdownPath, markdown: twins.markdown };
}

/**
 * Read the JSON packet (+ optional Markdown twin) from resolved paths.
 * @private
 * @returns {{packet: Object, jsonPath: string, markdownPath: string, markdown: (string|null)}|null}
 */
function readTwins(jsonPath, markdownPath) {
  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }

  let markdown = null;
  try {
    if (fs.existsSync(markdownPath)) {
      markdown = fs.readFileSync(markdownPath, 'utf8');
    }
  } catch {
    markdown = null;
  }

  return { packet, jsonPath, markdownPath, markdown };
}

/**
 * Heuristic: does the input look like a filesystem path (vs. a bare story id)?
 * @private
 */
function looksLikePath(value) {
  const s = String(value);
  return (
    s.endsWith('.json') ||
    s.endsWith('.md') ||
    s.includes('/') ||
    s.includes('\\')
  );
}

/**
 * Make a story id safe for filenames (keep word chars, dot and hyphen).
 * @private
 */
function sanitizeId(value) {
  return String(value).replace(/[^\w.-]/g, '_');
}

/**
 * Escape a string for literal use inside a RegExp.
 * @private
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  // WSB-3.2 primary API.
  generateHandoffPacket,
  loadHandoffPacket,
  // Backward-compatible re-exports for the lead-owned barrel/CLI.
  loadLatestHandoffPacket,
  renderMarkdown,
  HANDOFF_DIR,
  PACKET_SCHEMA_VERSION,
};
