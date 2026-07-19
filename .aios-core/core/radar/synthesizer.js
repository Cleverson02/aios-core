#!/usr/bin/env node

/**
 * AIOS Radar — Optional LLM Synthesizer
 *
 * Story: WSB-5.1 - Radar de Oportunidades
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * The ONLY place in the radar that may touch an LLM — and only when explicitly
 * asked (`--with-llm`) AND a provider is actually available. It turns the top-N
 * deterministic findings into short business briefs
 * (`{context, opportunity, nextStep}`), routing the model cost-first.
 *
 * Economy contract (Princípio de economia):
 *   1. Check provider availability FIRST (deterministic, network-free cache). No
 *      provider available → `{ skipped: true, reason }` and NOTHING is called. The
 *      deterministic findings upstream are untouched — LLM is pure enrichment.
 *   2. When available, pick the model with the LlmRouter under `cost-first`, then
 *      run it through the ai-provider factory (`executeWithRetry`) with a SHORT,
 *      structured prompt (finding + up to 3 evidences) asking for ~500 tokens.
 *   3. A failure synthesizing ONE brief never drops the others (each is guarded).
 *
 * All foreign modules (providers / router / factory) are injectable so the whole
 * unit is testable with ZERO network + ZERO real LLM.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

/** Matrix provider id → ai-provider factory name. */
const PROVIDER_TO_FACTORY = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  xai: 'grok',
};

/** Output-token budget asked of the model (kept small on purpose). */
const MAX_OUTPUT_TOKENS = 500;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC — SYNTHESIZE
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Synthesize briefs for the top-N findings, IF (and only if) a provider is
 * available. Never throws.
 *
 * @param {Array<Object>} findings - Ranked findings (from heuristics.analyze).
 * @param {Object} [options]
 * @param {string} [options.cwd] - Workspace root (availability cache + routing).
 * @param {number} [options.topN=3] - How many findings to synthesize.
 * @param {Function} [options.availability] - Injectable `getAvailability({cwd})`.
 * @param {Object} [options.router] - Injectable object exposing `route(text, opts)`.
 * @param {Object} [options.factory] - Injectable object exposing `getProvider(name)`.
 * @returns {Promise<{skipped: boolean, reason?: string, model?: string, provider?: string, briefs: Array<Object>}>}
 */
async function synthesize(findings, options = {}) {
  const { cwd, topN = 3 } = options;
  const list = Array.isArray(findings) ? findings.slice(0, Math.max(0, topN)) : [];

  if (!list.length) {
    return { skipped: true, reason: 'Nenhum finding para sintetizar.', briefs: [] };
  }

  // --- Step 1: availability gate (deterministic, no network) -------------------
  const available = resolveAvailableProviders(cwd, options.availability);
  if (available === null) {
    return {
      skipped: true,
      reason:
        'Módulo de providers indisponível — síntese LLM ignorada (findings determinísticos permanecem).',
      briefs: [],
    };
  }
  if (!available.size) {
    return {
      skipped: true,
      reason: 'Nenhum provider disponível — rode `aios providers setup` para habilitar a síntese LLM.',
      briefs: [],
    };
  }

  // --- Step 2: route once (cost-first) -----------------------------------------
  const router = options.router || loadRouter(cwd);
  const factory = options.factory || loadFactory();
  if (!router || !factory) {
    return { skipped: true, reason: 'Router / factory de providers indisponível.', briefs: [] };
  }

  let decision;
  try {
    decision = router.route('resumir oportunidade de negócio', { policy: 'cost-first' });
  } catch (_err) {
    return { skipped: true, reason: 'Falha ao rotear modelo (cost-first).', briefs: [] };
  }

  // If the routed provider is not among the available set, do not attempt a call.
  if (decision && decision.provider && !available.has(decision.provider)) {
    return {
      skipped: true,
      reason: `Modelo roteado (${decision.model}) usa provider indisponível (${decision.provider}).`,
      briefs: [],
    };
  }

  const factoryName = PROVIDER_TO_FACTORY[decision.provider] || decision.provider;
  let provider;
  try {
    provider = factory.getProvider(factoryName);
  } catch (_err) {
    return { skipped: true, reason: `Provider "${factoryName}" não instanciável.`, briefs: [] };
  }

  // --- Step 3: synthesize each finding (guarded individually) -------------------
  const briefs = [];
  for (const finding of list) {
    try {
      const prompt = buildPrompt(finding);
      const response = await provider.executeWithRetry(prompt, {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        cwd,
      });
      const output = (response && response.output) || '';
      briefs.push({ id: finding.id, ...parseBrief(output) });
    } catch (_err) {
      briefs.push({
        id: finding.id,
        error: 'Falha ao sintetizar este brief (os demais não foram afetados).',
        context: null,
        opportunity: null,
        nextStep: null,
      });
    }
  }

  return { skipped: false, model: decision.model, provider: decision.provider, briefs };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PROMPT + PARSING
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build a short, structured prompt for one finding (finding + up to 3 evidences),
 * demanding the three markers so the response is machine-parseable.
 *
 * @param {Object} finding - A ranked finding.
 * @returns {string}
 */
function buildPrompt(finding) {
  const evidence = (finding.evidence || []).slice(0, 3).map((e) => `- ${e}`).join('\n');
  return [
    'Você é um analista de negócios. A partir do achado determinístico abaixo,',
    'escreva um brief CURTO (máx ~500 tokens) em português.',
    'Responda EXATAMENTE com estas três linhas marcadas, nada mais:',
    'CONTEXTO: <1-2 frases>',
    'OPORTUNIDADE: <1-2 frases>',
    'PRÓXIMO PASSO: <1 ação concreta>',
    '',
    `Tipo: ${finding.type}`,
    `Título: ${finding.title}`,
    `Esforço/Impacto: ${finding.effort}/${finding.impact} (score ${finding.score})`,
    'Evidências:',
    evidence || '- (sem evidências)',
  ].join('\n');
}

/**
 * Parse a marked response into `{context, opportunity, nextStep}`. Tolerant to
 * PT/EN markers, casing and extra prose; missing markers → `null` for that field.
 *
 * @param {string} output - Raw model output.
 * @returns {{context: (string|null), opportunity: (string|null), nextStep: (string|null)}}
 */
function parseBrief(output) {
  const text = String(output || '');
  return {
    context: matchMarker(text, ['CONTEXTO', 'CONTEXT']),
    opportunity: matchMarker(text, ['OPORTUNIDADE', 'OPPORTUNITY']),
    nextStep: matchMarker(text, ['PRÓXIMO PASSO', 'PROXIMO PASSO', 'NEXT STEP', 'NEXT']),
  };
}

/**
 * Extract the text following the first matching marker on its line.
 *
 * @param {string} text - Full output.
 * @param {string[]} markers - Accepted marker spellings.
 * @returns {string|null}
 */
function matchMarker(text, markers) {
  for (const line of text.split(/\r?\n/)) {
    for (const marker of markers) {
      const re = new RegExp(`^\\s*${escapeRegex(marker)}\\s*[:\\-–]\\s*(.+)$`, 'i');
      const m = line.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return null;
}

/**
 * Escape a literal string for use inside a RegExp.
 *
 * @param {string} str - Literal.
 * @returns {string}
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DEPENDENCY LOADERS (lazy, guarded)
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the set of AVAILABLE provider ids (matrix ids: anthropic/openai/…).
 * Returns an empty Set when none are available, or `null` when the providers
 * module itself is absent (caller then reports the module as unavailable).
 *
 * @param {string} cwd - Workspace root.
 * @param {Function} [injected] - Injectable `getAvailability({cwd})`.
 * @returns {Set<string>|null}
 */
function resolveAvailableProviders(cwd, injected) {
  let getAvailability = injected;
  if (!getAvailability) {
    try {
       
      getAvailability = require('../providers').getAvailability;
    } catch (_err) {
      return null;
    }
  }
  if (typeof getAvailability !== 'function') return null;

  try {
    const result = getAvailability({ cwd });
    const providers = (result && result.providers) || {};
    const set = new Set();
    for (const [id, rec] of Object.entries(providers)) {
      if (rec && rec.available === true) set.add(id);
    }
    return set;
  } catch (_err) {
    return new Set();
  }
}

/**
 * Lazily construct an LlmRouter (guarded). Returns null on failure.
 *
 * @param {string} cwd - Project root for matrix override.
 * @returns {Object|null}
 */
function loadRouter(cwd) {
  try {
     
    const { LlmRouter } = require('../router');
    return new LlmRouter({ projectRoot: cwd });
  } catch (_err) {
    return null;
  }
}

/**
 * Lazily load the ai-provider factory (guarded). Returns null on failure.
 *
 * @returns {Object|null}
 */
function loadFactory() {
  try {
     
    return require('../../infrastructure/integrations/ai-providers/ai-provider-factory');
  } catch (_err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = {
  synthesize,
  buildPrompt,
  parseBrief,
  PROVIDER_TO_FACTORY,
  MAX_OUTPUT_TOKENS,
};
