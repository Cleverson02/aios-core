#!/usr/bin/env node

'use strict';

/**
 * AIOS Guided Mode CLI (Story WSB-4.8).
 *
 * Command handler for `aios next` — tells the user which agent/command comes
 * next in the AIOS methodology, with the reason in one sentence. Wiring into
 * bin/aios.js is done by the lead; this module only exposes `nextCommand(args)`.
 *
 *   aios next             → pretty block: current state + next step + alternatives
 *   aios next --explain   → full flow map (ideation → … → done) with ✔ / ▶
 *   aios next --json      → machine-readable output for scripts
 *
 * Exit codes: 0 = ok, 1 = unexpected error. ZERO LLM calls.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const chalk = require('chalk');

const { getNextStep } = require('./next-step');
const { STAGE_ORDER } = require('./project-state');

/**
 * One-line description of each stage and the agent that leads it, used by
 * `--explain` to draw the flow map.
 * @type {Array<{ stage: string, label: string, agent: string, blurb: string }>}
 */
const FLOW = [
  { stage: 'ideation', label: 'Ideação', agent: '@analyst', blurb: 'Explora a ideia e valida o problema (*brainstorm).' },
  { stage: 'architecture', label: 'Arquitetura', agent: '@architect', blurb: 'Desenha a arquitetura a partir do PRD (*create-architecture).' },
  { stage: 'planning', label: 'Planejamento', agent: '@po / @sm', blurb: 'Quebra a arquitetura em stories (*create-story).' },
  { stage: 'development', label: 'Desenvolvimento', agent: '@dev', blurb: 'Implementa cada story aprovada (*develop-story).' },
  { stage: 'review', label: 'Revisão', agent: '@qa', blurb: 'Revisa qualidade e valida os acceptance criteria (*review-story).' },
  { stage: 'done', label: 'Entrega', agent: '@devops / @po', blurb: 'Publica (*push) e puxa a próxima (aios radar).' },
];

/**
 * Handle `aios next [--explain] [--json]`.
 *
 * @param {string[]} [args] - Arguments after `next`.
 * @returns {number} Process-style exit code (0 = ok, 1 = error).
 */
function nextCommand(args = []) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));

  try {
    const step = getNextStep({ cwd: process.cwd() });

    if (flags.has('--json')) {
      // Strip the heavy `state.stories.items` array from JSON to keep it lean.
      const { state, ...rest } = step;
      const lean = {
        ...rest,
        state: {
          stage: state.stage,
          evidence: state.evidence,
          hasPrd: state.hasPrd,
          hasArchitecture: state.hasArchitecture,
          hasWorkspace: state.hasWorkspace,
          hasBrainIndex: state.hasBrainIndex,
          gitDirty: state.gitDirty,
          activeBuilds: state.activeBuilds.length,
          stories: state.stories.counts,
        },
      };
      process.stdout.write(`${JSON.stringify(lean, null, 2)}\n`);
      return 0;
    }

    if (flags.has('--explain')) {
      printExplain(step);
      return 0;
    }

    printNext(step);
    return 0;
  } catch (error) {
    process.stderr.write(chalk.red(`aios next: ${error.message}\n`));
    return 1;
  }
}

/**
 * Render the default pretty block.
 *
 * @param {object} step - Result of getNextStep.
 */
function printNext(step) {
  const { state } = step;
  const out = [];

  out.push('');
  out.push(chalk.bold.cyan('  AIOS · Próximo passo'));
  out.push('');
  out.push(`  ${chalk.dim('Estado atual:')} ${chalk.bold(stageLabel(state.stage))}`);
  for (const line of state.evidence.slice(0, 3)) {
    out.push(`    ${chalk.dim('•')} ${chalk.dim(line)}`);
  }
  out.push('');
  out.push(`  ${chalk.green('▶ PRÓXIMO PASSO')}  ${sourceTag(step.source)}`);
  out.push(`    ${chalk.bold.white(`${step.nextAgent} ${step.nextCommand}`)}`);
  out.push(`    ${chalk.gray(step.why)}`);

  if (step.alternatives && step.alternatives.length > 0) {
    out.push('');
    out.push(`  ${chalk.dim('Alternativas:')}`);
    for (const alt of step.alternatives) {
      out.push(`    ${chalk.dim(`${alt.agent} ${alt.command} — ${alt.when}`)}`);
    }
  }
  out.push('');

  process.stdout.write(`${out.join('\n')}\n`);
}

/**
 * Render the `--explain` flow map with progress markers.
 *
 * @param {object} step - Result of getNextStep.
 */
function printExplain(step) {
  const currentIndex = STAGE_ORDER.indexOf(step.stage);
  const out = [];

  out.push('');
  out.push(chalk.bold.cyan('  AIOS · Mapa do fluxo'));
  out.push(`  ${chalk.dim('Onde você está:')} ${chalk.bold(stageLabel(step.stage))}`);
  out.push('');

  FLOW.forEach((node, index) => {
    let marker;
    let render;
    if (index < currentIndex) {
      marker = chalk.green('✔');
      render = chalk.dim;
    } else if (index === currentIndex) {
      marker = chalk.green('▶');
      render = chalk.bold.white;
    } else {
      marker = chalk.dim('○');
      render = chalk.dim;
    }
    out.push(`  ${marker} ${render(`${node.label.padEnd(16)} ${node.agent}`)}`);
    out.push(`      ${chalk.dim(node.blurb)}`);
  });

  out.push('');
  out.push(`  ${chalk.green('▶')} ${chalk.bold.white(`${step.nextAgent} ${step.nextCommand}`)} ${chalk.gray(`— ${step.why}`)}`);
  out.push('');

  process.stdout.write(`${out.join('\n')}\n`);
}

/**
 * Human label for a stage key.
 *
 * @param {string} stage - Stage key.
 * @returns {string}
 */
function stageLabel(stage) {
  const node = FLOW.find((f) => f.stage === stage);
  return node ? `${node.label} (${stage})` : stage;
}

/**
 * Small tag noting where the recommendation came from.
 *
 * @param {string} source - 'wis' | 'methodology'.
 * @returns {string}
 */
function sourceTag(source) {
  return source === 'wis'
    ? chalk.dim('(via workflow intelligence)')
    : chalk.dim('(via metodologia)');
}

module.exports = { nextCommand };

// CLI entrypoint (works before the lead wires it into bin/aios.js).
if (require.main === module) {
  process.exit(nextCommand(process.argv.slice(2)));
}
