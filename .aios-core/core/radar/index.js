/**
 * AIOS Radar — module barrel.
 *
 * Story: WSB-5.1 - Radar de Oportunidades
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Single import surface for the opportunity radar:
 *   - `collect`      → deterministic collection from the real brain sources.
 *   - `analyze`      → deterministic heuristics → ranked findings (zero LLM).
 *   - `synthesize`   → OPTIONAL LLM briefs (only with `--with-llm` + a provider).
 *   - `radarCommand` → the `aios radar <scan|report|brief>` CLI handler.
 *
 * Wiring `aios radar` into bin/aios.js is done by the lead.
 *
 * @module core/radar
 * @version 1.0.0
 */

const collectors = require('./collectors');
const heuristics = require('./heuristics');
const synthesizer = require('./synthesizer');
const { radarCommand } = require('./cli');

module.exports = {
  // Collection
  collect: collectors.collect,
  // Heuristics
  analyze: heuristics.analyze,
  RULES: heuristics.RULES,
  DEFAULTS: heuristics.DEFAULTS,
  // Synthesis
  synthesize: synthesizer.synthesize,
  // CLI
  radarCommand,
};
