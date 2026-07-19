/**
 * Fresh Window Spawner — Autonomy Engine (Story WSB-3.2)
 *
 * Companion to handoff-packet.js: given a persisted handoff packet, open a
 * clean window that continues exactly where the previous (context-saturated)
 * session left off. Visual-terminal environments get a real spawn through the
 * cross-platform terminal-spawner (REUSE, 11.2); headless environments
 * (CI/Docker/SSH), an unavailable spawner, or a spawn failure all degrade to
 * `{spawned:false, instructions}` with a ready-to-copy command — never a throw
 * (AC3). Zero new dependencies.
 *
 * @module core/autonomy/fresh-window
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const path = require('path');

/** Task id handed to the spawned agent (alphanumeric+hyphen, spawner-safe). */
const RESUME_TASK = 'resume-story';

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONTINUATION PROMPT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build the continuation prompt for the fresh agent: read the packet, a 3-line
 * state summary, and the next subtask to execute.
 *
 * @param {Object} packet - Handoff packet (from handoff-packet.generateHandoffPacket).
 * @returns {string} Prompt string.
 */
function buildContinuationPrompt(packet) {
  const p = packet || {};
  const story = p.story || {};
  const build = p.build || {};

  const doneCount = Array.isArray(build.completedSubtasks)
    ? build.completedSubtasks.length
    : story.doneCount || 0;
  const nextSubtask =
    p.nextSubtask ||
    (Array.isArray(story.openCheckboxes) && story.openCheckboxes[0]) ||
    '(determinar a partir da story)';

  const storyLine = `1. Story: ${story.title || p.storyId || 'desconhecida'}` +
    `${story.status ? ` — status ${story.status}` : ''}` +
    `${story.path ? ` (${story.path})` : ''}`;
  const buildLine = `2. Build: ${build.status || 'sem build-state'} — ` +
    `${doneCount} subtask(s) concluída(s)` +
    `${build.lastCheckpoint ? `, último checkpoint ${build.lastCheckpoint}` : ''}.`;
  const nextLine = `3. Próxima subtask: ${nextSubtask}`;

  return [
    `Você está retomando a story ${p.storyId || 'desconhecida'} em uma janela limpa (~5% de contexto).`,
    'Leia o handoff packet completo (Markdown + JSON gêmeo em .aios/autonomy/handoffs/) antes de agir.',
    '',
    'Resumo do estado:',
    storyLine,
    buildLine,
    nextLine,
    '',
    'Continue exatamente a partir da próxima subtask acima. Não refaça trabalho já concluído.',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SPAWN
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Open a fresh window primed with a handoff packet.
 *
 * @param {Object} params
 * @param {string} params.packetPath - Path to a persisted packet (`.json`/`.md`).
 * @param {string} [params.agent='dev'] - Agent to activate in the new window.
 * @param {string} [params.cwd] - Project root (default process.cwd()).
 * @param {boolean} [params.dryRun=false] - Build the command without spawning.
 * @returns {Promise<Object>} One of:
 *   - dryRun: `{spawned:false, dryRun:true, command, prompt, storyId}`
 *   - spawned: `{spawned:true, environment, command, result, storyId}`
 *   - fallback: `{spawned:false, instructions, prompt, storyId, environment?, error?}`
 */
async function spawnFreshWindow({
  packetPath,
  agent = 'dev',
  cwd = process.cwd(),
  dryRun = false,
} = {}) {
  // Load the packet to build a rich continuation prompt (graceful if missing).
  let packet = null;
  try {
    const { loadHandoffPacket } = require('./handoff-packet');
    const loaded = await loadHandoffPacket(packetPath, { cwd });
    packet = loaded && loaded.packet;
  } catch {
    packet = null;
  }

  const storyId = (packet && packet.storyId) || deriveStoryIdFromPath(packetPath);
  const command = buildResumeCommand(storyId);
  const prompt = packet
    ? buildContinuationPrompt(packet)
    : `Retome a story ${storyId} em uma janela limpa. Leia o handoff packet em ${packetPath}.`;

  if (dryRun) {
    return { spawned: false, dryRun: true, command, prompt, storyId };
  }

  // Lazy-require the real spawner; unavailable → copy-paste instructions.
  let spawner;
  try {
    spawner = require('../orchestration/terminal-spawner');
  } catch {
    return { spawned: false, instructions: command, prompt, storyId };
  }

  let environment;
  try {
    environment = spawner.detectEnvironment();
  } catch {
    environment = { type: 'UNKNOWN', supportsVisualTerminal: false };
  }

  // Headless environment → no surprise inline execution; hand back the command.
  if (!environment.supportsVisualTerminal) {
    return {
      spawned: false,
      environment: environment.type,
      instructions: command,
      prompt,
      storyId,
    };
  }

  // Visual terminal available → attempt a real spawn, degrading on any failure.
  try {
    const result = await spawner.spawnAgent(agent, RESUME_TASK, {
      params: storyId,
      context: {
        story: (packet && packet.story && packet.story.path) || storyId,
        instructions: prompt,
      },
    });
    return { spawned: true, environment: environment.type, command, result, storyId };
  } catch (error) {
    return {
      spawned: false,
      environment: environment.type,
      instructions: command,
      prompt,
      storyId,
      error: error && error.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Ready-to-copy continuation command for a story.
 * @private
 */
function buildResumeCommand(storyId) {
  return `aios run resume ${storyId}`;
}

/**
 * Derive a story id from a packet filename (`<storyId>-<n>.{json,md}`).
 * @private
 */
function deriveStoryIdFromPath(packetPath) {
  if (!packetPath) return 'unknown';
  const base = path.basename(String(packetPath)).replace(/\.(json|md)$/i, '');
  return base.replace(/-\d+$/, '') || 'unknown';
}

module.exports = {
  spawnFreshWindow,
  buildContinuationPrompt,
};
