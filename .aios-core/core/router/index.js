/**
 * Router module barrel.
 *
 * Public contract consumed by other AIOX modules (dispatcher, CLI wiring).
 *
 * @module core/router
 * @created Story WSB-2.1 + WSB-2.3 — LLM Router
 */

const { LlmRouter, CATEGORY_KEYWORDS, CATEGORY_STRENGTHS, COST_RANK, SPEED_RANK } = require('./router');
const { loadMatrix, clearCache, mergeMatrix, CORE_MATRIX_PATH, PROJECT_MATRIX_RELPATH } = require('./matrix-loader');
const { routeCommand } = require('./cli');

module.exports = {
  LlmRouter,
  routeCommand,
  loadMatrix,
  clearCache,
  mergeMatrix,
  CATEGORY_KEYWORDS,
  CATEGORY_STRENGTHS,
  COST_RANK,
  SPEED_RANK,
  CORE_MATRIX_PATH,
  PROJECT_MATRIX_RELPATH,
};
