'use strict';

/**
 * Next Step Resolver (Story WSB-4.8 — Guided Mode).
 *
 * Answers "what should I do next?" by combining:
 *   1. The deterministic project state (project-state.js), and
 *   2. The Workflow Intelligence System (WIS) `getSuggestions` (REUSE) fed with
 *      the current session context (context-loader schema).
 *
 * WIS is consulted first; when it has enough confidence its suggestion wins.
 * Otherwise we fall back to an embedded, deterministic methodology table keyed
 * by stage. ZERO LLM calls anywhere in this path.
 *
 * @module core/guide/next-step
 * @version 1.0.0
 * @author @dev (Dex)
 */

const path = require('path');

const { detectProjectState } = require('./project-state');

/**
 * Minimum WIS confidence required to prefer a suggestion over the methodology
 * fallback. Mirrors WIS `LOW_CONFIDENCE_THRESHOLD` (0.5).
 * @type {number}
 */
const WIS_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Map a bare command name to the agent that owns it. Used to label WIS
 * suggestions (which carry a command but not always a single owning agent).
 * @type {Record<string, string>}
 */
const COMMAND_AGENT = {
  brainstorm: '@analyst',
  'create-prd': '@pm',
  'create-doc': '@pm',
  'create-architecture': '@architect',
  'analyze-impact': '@architect',
  'create-story': '@po',
  'create-next-story': '@sm',
  'create-epic': '@po',
  'validate-next-story': '@po',
  develop: '@dev',
  'develop-story': '@dev',
  'develop-yolo': '@dev',
  'review-qa': '@qa',
  'review-story': '@qa',
  'apply-qa-fixes': '@dev',
  push: '@devops',
  'pre-push-quality-gate': '@devops',
};

/**
 * Read the session context (last commands + previous agent) from the same file
 * the context-loader uses (`<cwd>/.aios/session-state.json`). Never throws.
 *
 * @param {string} cwd - Project root.
 * @returns {{ lastCommands: string[], lastCommand: string|undefined, agentId: string|undefined }|null}
 */
function loadSessionContext(cwd) {
  try {
    const SessionContextLoader = require('../session/context-loader');
    const loader = new SessionContextLoader();
    // Respect the requested cwd (the loader defaults to process.cwd()).
    loader.sessionStatePath = path.join(cwd, '.aios', 'session-state.json');
    const state = loader.loadSessionState();

    const lastCommands = (state.lastCommands || []).map((c) => String(c).replace(/^\*/, ''));
    if (lastCommands.length === 0) {
      return null;
    }
    const sequence = state.agentSequence || [];
    const agentId = sequence.length ? sequence[sequence.length - 1].agentId : undefined;

    return {
      lastCommands,
      lastCommand: lastCommands[lastCommands.length - 1],
      agentId,
    };
  } catch {
    return null;
  }
}

/**
 * Ask WIS for a suggestion. Returns a normalized step or null when WIS is
 * unavailable, has no match, or is below the confidence threshold.
 *
 * @param {object} context - Session context from {@link loadSessionContext}.
 * @param {object} state - Project state from detectProjectState.
 * @returns {object|null}
 */
function tryWis(context, state) {
  if (!context) return null;
  try {
    // Lazy require so a missing WIS never breaks the guide.
    const wis = require('../../workflow-intelligence');
    const suggestions = wis.getSuggestions({
      lastCommand: context.lastCommand,
      lastCommands: context.lastCommands,
      agentId: context.agentId,
      projectState: { stage: state.stage },
    });

    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

    const [top, ...rest] = suggestions;
    if (typeof top.confidence === 'number' && top.confidence < WIS_CONFIDENCE_THRESHOLD) {
      return null;
    }

    return {
      nextAgent: agentForCommand(top),
      nextCommand: formatCommand(top),
      why: top.description || 'Sugerido pelo padrão de workflow que você vem seguindo.',
      source: 'wis',
      alternatives: rest.slice(0, 2).map((s) => ({
        agent: agentForCommand(s),
        command: formatCommand(s),
        when: s.description || 'alternativa do workflow',
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Derive the owning agent for a WIS suggestion.
 *
 * @param {object} suggestion - WIS suggestion.
 * @returns {string} Agent handle (e.g. "@dev").
 */
function agentForCommand(suggestion) {
  const cmd = String(suggestion.command || '').replace(/^\*/, '');
  if (COMMAND_AGENT[cmd]) return COMMAND_AGENT[cmd];
  const seq = suggestion.agentSequence;
  if (Array.isArray(seq) && seq.length > 0) return seq[0];
  return '@dev';
}

/**
 * Render a copy-pasteable command from a WIS suggestion (`*command args`).
 *
 * @param {object} suggestion - WIS suggestion.
 * @returns {string}
 */
function formatCommand(suggestion) {
  const cmd = String(suggestion.command || '').replace(/^\*/, '');
  const args = suggestion.args_template ? ` ${suggestion.args_template}` : '';
  return `*${cmd}${args}`;
}

/**
 * Deterministic methodology fallback keyed by stage.
 *
 * @param {object} state - Project state from detectProjectState.
 * @returns {object} Normalized step (source: 'methodology').
 */
function methodologyStep(state) {
  const { stage, stories, activeBuilds, gitDirty } = state;

  switch (stage) {
    case 'ideation':
      return {
        nextAgent: '@analyst',
        nextCommand: '*brainstorm',
        why: 'Ainda não há PRD — comece explorando a ideia com o analista.',
        source: 'methodology',
        alternatives: [
          { agent: '@pm', command: '*create-prd', when: 'se a ideia já está clara e você quer pular direto para o PRD' },
        ],
      };

    case 'architecture':
      return {
        nextAgent: '@architect',
        nextCommand: '*create-architecture',
        why: 'PRD pronto — desenhe a arquitetura antes de quebrar o trabalho em stories.',
        source: 'methodology',
        alternatives: [
          { agent: '@pm', command: '*create-prd', when: 'se o PRD ainda precisa de ajustes' },
        ],
      };

    case 'planning':
      return {
        nextAgent: '@po',
        nextCommand: '*create-story',
        why: 'Arquitetura definida — quebre o escopo em stories acionáveis.',
        source: 'methodology',
        alternatives: [
          { agent: '@sm', command: '*create-story', when: 'o SM também detalha e prioriza a próxima story' },
        ],
      };

    case 'development': {
      if (activeBuilds.length > 0) {
        return {
          nextAgent: '@dev',
          nextCommand: 'aios run resume',
          why: 'Há um build autônomo em andamento — retome de onde parou.',
          source: 'methodology',
          alternatives: [
            { agent: '@dev', command: '*develop-story', when: 'para assumir a implementação manualmente' },
          ],
        };
      }
      const target = stories.mostRecentActionable;
      const ref = target ? ` ${target.id}` : '';
      return {
        nextAgent: '@dev',
        nextCommand: `*develop-story${ref}`,
        why: target
          ? `A story ${target.id} está pronta para ser implementada.`
          : 'Há stories aprovadas — implemente a próxima.',
        source: 'methodology',
        alternatives: [
          { agent: '@qa', command: '*review-story', when: 'quando a implementação estiver pronta para revisão' },
        ],
      };
    }

    case 'review':
      return {
        nextAgent: '@qa',
        nextCommand: '*review-story',
        why: 'Stories prontas para review — rode o QA antes de publicar.',
        source: 'methodology',
        alternatives: [
          { agent: '@devops', command: '*push', when: 'depois que o QA aprovar, publique as mudanças' },
        ],
      };

    case 'done':
      return {
        nextAgent: gitDirty ? '@devops' : '@po',
        nextCommand: gitDirty ? '*push' : '*create-story',
        why: gitDirty
          ? 'Tudo entregue, mas ainda há commits locais — publique as mudanças.'
          : 'Tudo entregue — puxe a próxima story ou rode aios radar (Fase 5).',
        source: 'methodology',
        alternatives: gitDirty
          ? [{ agent: '@po', command: '*create-story', when: 'para iniciar a próxima entrega' }]
          : [{ agent: '@devops', command: '*push', when: 'se ainda há commits locais para publicar' }],
      };

    default:
      return {
        nextAgent: '@analyst',
        nextCommand: '*brainstorm',
        why: 'Estado indefinido — comece explorando o problema.',
        source: 'methodology',
        alternatives: [],
      };
  }
}

/**
 * Resolve the recommended next step for a project.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()] - Project root.
 * @returns {{
 *   stage: string,
 *   nextAgent: string,
 *   nextCommand: string,
 *   why: string,
 *   source: 'wis'|'methodology',
 *   alternatives: Array<{ agent: string, command: string, when: string }>,
 *   state: object
 * }}
 */
function getNextStep({ cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd);
  const state = detectProjectState({ cwd: root });

  const context = loadSessionContext(root);
  const wisStep = tryWis(context, state);
  const step = wisStep || methodologyStep(state);

  return { stage: state.stage, ...step, state };
}

module.exports = {
  getNextStep,
  methodologyStep,
  WIS_CONFIDENCE_THRESHOLD,
  COMMAND_AGENT,
};
