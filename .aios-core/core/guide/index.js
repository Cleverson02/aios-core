'use strict';

/**
 * Guided Mode barrel (Story WSB-4.8).
 *
 * Public surface of the guide module: deterministic project-state detection,
 * the next-step resolver (WIS + methodology fallback) and the `aios next` CLI
 * handler. ZERO LLM calls anywhere in this module.
 *
 * @module core/guide
 * @version 1.0.0
 * @author @dev (Dex)
 */

const { detectProjectState } = require('./project-state');
const { getNextStep } = require('./next-step');
const { nextCommand } = require('./cli');

module.exports = {
  detectProjectState,
  getNextStep,
  nextCommand,
};
