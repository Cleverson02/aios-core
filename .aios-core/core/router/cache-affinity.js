/**
 * Cache-aware routing economics (Story WSB-4.6).
 *
 * When a chain of subtasks shares an accumulating context, that context sits
 * CACHED in the incumbent provider. Switching to a "cheaper" model re-pays the
 * WHOLE context at full input price (+ a one-off cache write), so a naive
 * cost-first switch can end up MORE expensive in practice. This module puts a
 * price on that decision so the router never destroys cache value by accident.
 *
 * All prices come from the `pricing` blocks added to `capability-matrix.yaml`
 * in WSB-4.5 (USD per MILLION tokens). Models without `pricing` degrade to a
 * NEUTRAL recommendation — cache-affinity never blocks routing on missing data
 * (AC5).
 *
 * The two cost sides (both in absolute USD):
 *
 *   stayCost   = cached × inc.cached_input           (context served from cache)
 *              + newIn  × inc.input                   (fresh input this step)
 *              + out    × inc.output                  (completion)          ÷ 1e6
 *
 *   switchCost = (cached + newIn) × cand.input        (candidate re-pays it ALL
 *              + (cached + newIn) × cand.cache_write    at full price + writes
 *              + out             × cand.output          the whole prompt again) ÷ 1e6
 *
 * @module core/router/cache-affinity
 * @version 1.0.0
 * @created Story WSB-4.6 — Cache-aware routing
 */

/** Default protective margin: only switch when switchCost < stayCost × (1 − 10%). */
const DEFAULT_MARGIN_PCT = 10;

/**
 * Read a model's pricing block from the matrix, or `null` when absent.
 *
 * @param {Object} matrix - Loaded capability matrix.
 * @param {string} modelId - Model id.
 * @returns {Object|null} The `pricing` object or `null`.
 */
function pricingOf(matrix, modelId) {
  const model = matrix && matrix.models && matrix.models[modelId];
  return model && model.pricing ? model.pricing : null;
}

/**
 * Format a USD amount to a stable, human-readable `$0.0000` string.
 *
 * @param {number} amount - Amount in USD.
 * @returns {string}
 */
function formatUsd(amount) {
  return `$${Number(amount).toFixed(4)}`;
}

/**
 * Cost of KEEPING vs SWITCHING a model given a cached context.
 *
 * The `breakEvenTokens` is derived algebraically: it is the number of NEW input
 * tokens `N` at which `stayCost(N) === switchCost(N)` (holding cached/out fixed).
 * Per new token the switch saves `inc.input − cand.input − cand.cache_write`
 * (call it `denom`). If `denom ≤ 0` the switch can NEVER catch up by adding new
 * tokens → `Infinity`. Otherwise:
 *
 *   N* = [ cached × (cand.input + cand.write − inc.cached)
 *          + out  × (cand.output − inc.output) ] / denom
 *
 * clamped at 0 (a negative N* means the switch already wins with zero new
 * tokens). `breakEvenTokens` is the pure crossover point and ignores `marginPct`
 * (the margin only affects the `recommendation`).
 *
 * @param {Object} params
 * @param {string} params.incumbentModel - Currently-cached model id.
 * @param {string} params.candidateModel - Model we might switch to.
 * @param {number} [params.cachedContextTokens=0] - Tokens already cached on the incumbent.
 * @param {number} [params.expectedNewInputTokens=0] - Fresh input tokens this step.
 * @param {number} [params.expectedOutputTokens=0] - Expected completion tokens.
 * @param {Object} params.matrix - Loaded capability matrix (source of pricing).
 * @param {number} [params.marginPct=10] - Only switch if switchCost < stayCost×(1−margin/100).
 * @returns {{ stayCost: number, switchCost: number, saving: number,
 *   recommendation: 'switch'|'stay', breakEvenTokens: number, explanation: string }
 *   | { recommendation: 'neutral', reason: string }}
 */
function switchCost({
  incumbentModel,
  candidateModel,
  cachedContextTokens = 0,
  expectedNewInputTokens = 0,
  expectedOutputTokens = 0,
  matrix,
  marginPct = DEFAULT_MARGIN_PCT,
} = {}) {
  const inc = pricingOf(matrix, incumbentModel);
  const cand = pricingOf(matrix, candidateModel);

  // AC5: missing pricing → neutral, never blocks routing.
  if (!inc || !cand) {
    const missing = !inc ? incumbentModel : candidateModel;
    return {
      recommendation: 'neutral',
      reason: `Modelo "${missing}" sem pricing na matrix — afinidade de cache neutra (não bloqueia a rota).`,
    };
  }

  const cached = Math.max(0, Number(cachedContextTokens) || 0);
  const newIn = Math.max(0, Number(expectedNewInputTokens) || 0);
  const out = Math.max(0, Number(expectedOutputTokens) || 0);

  // A missing cached price falls back to full input; a missing cache_write is free.
  const incCached =
    inc.cached_input_per_mtok !== undefined ? inc.cached_input_per_mtok : inc.input_per_mtok;
  const candWrite = cand.cache_write_per_mtok !== undefined ? cand.cache_write_per_mtok : 0;

  const stayCostVal =
    (cached * incCached + newIn * inc.input_per_mtok + out * inc.output_per_mtok) / 1e6;

  const switchCostVal =
    ((cached + newIn) * cand.input_per_mtok +
      candWrite * (cached + newIn) +
      out * cand.output_per_mtok) /
    1e6;

  const saving = stayCostVal - switchCostVal;
  const threshold = stayCostVal * (1 - marginPct / 100);
  const recommendation = switchCostVal < threshold ? 'switch' : 'stay';

  // Break-even (crossover) in NEW input tokens — see JSDoc for the derivation.
  const denom = inc.input_per_mtok - cand.input_per_mtok - candWrite;
  let breakEvenTokens;
  if (denom <= 0) {
    breakEvenTokens = Infinity;
  } else {
    const numerator =
      cached * (cand.input_per_mtok + candWrite - incCached) +
      out * (cand.output_per_mtok - inc.output_per_mtok);
    breakEvenTokens = Math.max(0, Math.ceil(numerator / denom));
  }

  const breakEvenLabel = breakEvenTokens === Infinity ? '∞' : String(breakEvenTokens);
  const explanation =
    `stay=${formatUsd(stayCostVal)} [${incumbentModel}: ${cached} cached@${incCached} + ` +
    `${newIn} novos@${inc.input_per_mtok} + ${out} out@${inc.output_per_mtok} por Mtok] vs ` +
    `switch=${formatUsd(switchCostVal)} [${candidateModel}: ${cached + newIn} tokens re-pagos@` +
    `${cand.input_per_mtok} + cache_write@${candWrite} + ${out} out@${cand.output_per_mtok} por Mtok]; ` +
    `economia=${formatUsd(saving)}; break-even=${breakEvenLabel} tokens novos; ` +
    `recomendação=${recommendation} (margem ${marginPct}%).`;

  return {
    stayCost: stayCostVal,
    switchCost: switchCostVal,
    saving,
    recommendation,
    breakEvenTokens,
    explanation,
  };
}

module.exports = {
  switchCost,
  pricingOf,
  formatUsd,
  DEFAULT_MARGIN_PCT,
};
