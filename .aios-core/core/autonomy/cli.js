#!/usr/bin/env node

/**
 * AIOS Autonomy CLI Handler (Fase 3 — Autonomy Engine, WSB-3.1/3.2/3.3).
 *
 * Command handler for `aios run <long|status|resume|handoff>`. Wiring into
 * bin/aios.js is done by the lead; this module only exposes `runCommand(args)`.
 *
 *   aios run long <story-id>              → start/attach a long-run session
 *   aios run --long <story-id>            → alias (epic CLI spec)
 *   aios run status [story-id]            → builds + zones + handoff packets
 *   aios run resume <story-id>            → resume from the latest handoff packet
 *   aios run handoff <story-id> [--spawn] → generate a handoff packet now
 *
 * Exit codes: 0 = ok, 1 = usage/validation error.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const { ContextBudgetManager, Zone, AUTONOMY_DIR } = require('./context-budget-manager');
const {
  generateHandoffPacket,
  loadLatestHandoffPacket,
  HANDOFF_DIR,
} = require('./handoff-packet');
const { spawnFreshWindow } = require('./fresh-window');
const { HeartbeatMonitor, DEFAULT_INTERVAL, DEFAULT_STUCK_THRESHOLD } = require('./heartbeat');

const ZONE_COLORS = {
  [Zone.GREEN]: chalk.green,
  [Zone.YELLOW]: chalk.yellow,
  [Zone.RED]: chalk.red,
};

/**
 * Dispatch a `run` subcommand.
 *
 * @param {string[]} [args] - Arguments after `run`.
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function runCommand(args = []) {
  // `aios run --long <story>` (epic spec) normalizes to the `long` subcommand.
  const normalized = args[0] === '--long' ? ['long', ...args.slice(1)] : args;
  const [subcommand, ...rest] = normalized;
  const { flags, positionals } = parseArgs(rest);

  try {
    switch (subcommand) {
      case 'long':
        return runLong(positionals, flags);
      case 'status':
        return runStatus(positionals);
      case 'resume':
        return runResume(positionals);
      case 'handoff':
        return await runHandoff(positionals, flags);
      default:
        printUsage();
        return subcommand ? 1 : 0;
    }
  } catch (error) {
    console.error(chalk.red(`✖ ${error.message}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SUBCOMMANDS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `run long <story-id>` — start or attach a long-run session: ensures build
 * state exists, reports the context zone and the heartbeat contract the
 * executing agent must honor.
 */
function runLong(positionals, flags) {
  const storyId = positionals[0];
  if (!storyId) {
    console.log(chalk.red('Uso: aios run long <story-id> [--interval N]'));
    return 1;
  }

  const { BuildStateManager } = require('../execution/build-state-manager');
  const manager = new BuildStateManager(storyId, { rootPath: process.cwd() });
  const existing = manager.loadState();
  if (!existing) {
    manager.createState();
    manager.saveState();
    console.log(chalk.green(`✓ Build state criado para ${storyId}`));
  } else {
    console.log(chalk.cyan(`↻ Build state existente (status: ${existing.status})`));
  }

  const budget = new ContextBudgetManager({ cwd: process.cwd() });
  const percentUsed = Number(flags['percent-used']) || 0;
  const evaluation = budget.evaluate({ percentUsed, storyId });
  const interval = Number(flags.interval) || DEFAULT_INTERVAL;

  console.log(chalk.bold(`\n🏃 Long-run: ${storyId}`));
  console.log(`  Zona de contexto:  ${formatZone(evaluation, percentUsed)}`);
  console.log(`  Heartbeat:         checkpoint a cada ${interval} subtasks`);
  console.log(`  Stuck threshold:   ${DEFAULT_STUCK_THRESHOLD} falhas na mesma subtask → escalação`);
  console.log(`  Handoff:           zona ${chalk.red('RED')} → aios run handoff ${storyId}`);
  console.log(chalk.dim(`\n  Status a qualquer momento: aios run status ${storyId}`));
  return 0;
}

/**
 * `run status [story-id]` — builds, context zone transitions and available
 * handoff packets.
 */
function runStatus(positionals) {
  const storyId = positionals[0];
  const { BuildStateManager } = require('../execution/build-state-manager');

  if (storyId) {
    const manager = new BuildStateManager(storyId, { rootPath: process.cwd() });
    console.log(manager.formatStatus());
  } else {
    console.log(BuildStateManager.formatAllBuilds(process.cwd()));
  }

  const transitions = readZoneLog(process.cwd()).slice(-5);
  if (transitions.length) {
    console.log(chalk.bold('Transições de zona recentes:'));
    for (const t of transitions) {
      const color = ZONE_COLORS[t.to] || chalk.gray;
      console.log(
        `  ${chalk.dim(t.timestamp)} ${t.from || '·'} → ${color(t.to)}` +
          (t.storyId ? chalk.dim(` [${t.storyId}]`) : ''),
      );
    }
    console.log('');
  }

  const handoffDir = path.join(process.cwd(), HANDOFF_DIR);
  if (fs.existsSync(handoffDir)) {
    const packets = fs.readdirSync(handoffDir).filter((f) => f.endsWith('.json'));
    if (packets.length) {
      console.log(chalk.bold(`Handoff packets (${packets.length}):`));
      for (const p of packets.slice(-5)) {
        console.log(`  ${chalk.dim(p)}`);
      }
      console.log('');
    }
  }
  return 0;
}

/**
 * `run resume <story-id>` — resume from the latest handoff packet + build
 * checkpoint. Prints the packet's Markdown so a fresh session starts with
 * the full continuation context.
 */
function runResume(positionals) {
  const storyId = positionals[0];
  if (!storyId) {
    console.log(chalk.red('Uso: aios run resume <story-id>'));
    return 1;
  }

  const latest = loadLatestHandoffPacket({ storyId });
  const { BuildStateManager } = require('../execution/build-state-manager');
  const manager = new BuildStateManager(storyId, { rootPath: process.cwd() });

  let resumed = null;
  try {
    resumed = manager.resumeBuild();
  } catch {
    // No build state is fine — the handoff packet alone may carry the context.
  }

  if (!latest && !resumed) {
    console.log(chalk.yellow(`⚠ Nada para retomar: sem handoff packet nem build state para ${storyId}`));
    return 1;
  }

  if (resumed) {
    console.log(chalk.green(`✓ Build retomado (checkpoint: ${resumed.lastCheckpoint?.id || 'início'})`));
    console.log(chalk.dim(`  Subtasks concluídas: ${resumed.completedSubtasks.length}`));
  }

  if (latest) {
    const mdPath = latest.jsonPath.replace(/\.json$/, '.md');
    console.log(chalk.green(`✓ Handoff packet: ${path.relative(process.cwd(), latest.jsonPath)}`));
    if (fs.existsSync(mdPath)) {
      console.log('');
      console.log(fs.readFileSync(mdPath, 'utf8'));
    }
  }
  return 0;
}

/**
 * `run handoff <story-id> [--reason X] [--spawn]` — generate a handoff packet
 * now; with --spawn, also try to open a fresh window (headless envs degrade
 * to printed instructions).
 */
async function runHandoff(positionals, flags) {
  const storyId = positionals[0];
  if (!storyId) {
    console.log(chalk.red('Uso: aios run handoff <story-id> [--reason X] [--spawn]'));
    return 1;
  }

  const reason = typeof flags.reason === 'string' ? flags.reason : 'manual';
  const result = await generateHandoffPacket({ cwd: process.cwd(), storyId, reason });
  const { packet, jsonPath } = result;
  const markdownPath = result.markdownPath || result.path;

  console.log(chalk.green(`✓ Handoff packet gerado para ${storyId}`));
  console.log(chalk.dim(`  JSON:     ${path.relative(process.cwd(), jsonPath)}`));
  console.log(chalk.dim(`  Markdown: ${path.relative(process.cwd(), markdownPath)}`));
  console.log(`  Próxima subtask: ${packet.nextSubtask || chalk.dim('(determinar da story)')}`);

  if (flags.spawn) {
    const spawn = await spawnFreshWindow({ packetPath: jsonPath, cwd: process.cwd() });
    if (spawn.spawned) {
      console.log(chalk.green('✓ Nova janela lançada'));
    } else {
      console.log(chalk.yellow('⚠ Sem terminal visual neste ambiente — comando pronto:'));
      console.log(`  ${spawn.instructions || spawn.command || ''}`);
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/** Format a zone evaluation with color. */
function formatZone(evaluation, percentUsed) {
  const color = ZONE_COLORS[evaluation.zone] || chalk.gray;
  return `${color(evaluation.zone)} (${percentUsed}% usado) → ${evaluation.action}`;
}

/** Read the zone transition log written by ContextBudgetManager. */
function readZoneLog(cwd) {
  try {
    const logPath = path.join(cwd, AUTONOMY_DIR, 'zone-log.json');
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse a minimal `--flag value` / `--flag` argv slice.
 *
 * @param {string[]} argv - Arguments to parse.
 * @returns {{ flags: Object, positionals: string[] }}
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
  console.log(chalk.bold('aios run') + ' — Autonomy Engine (sessões longas sem degradação)\n');
  console.log('  ' + chalk.cyan('long <story-id> [--interval N]') + '     inicia/atacha long-run com heartbeat');
  console.log('  ' + chalk.cyan('status [story-id]') + '                  builds, zonas de contexto e handoffs');
  console.log('  ' + chalk.cyan('resume <story-id>') + '                  retoma do último handoff packet');
  console.log('  ' + chalk.cyan('handoff <story-id> [--spawn]') + '       gera handoff packet (e nova janela)');
}

module.exports = {
  runCommand,
  // re-exported for orchestrators that consume the engine programmatically
  ContextBudgetManager,
  HeartbeatMonitor,
  DEFAULT_INTERVAL,
};
