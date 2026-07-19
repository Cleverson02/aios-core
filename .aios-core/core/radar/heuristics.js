#!/usr/bin/env node

/**
 * AIOS Radar — Deterministic Heuristics
 *
 * Story: WSB-5.1 - Radar de Oportunidades
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Turns a collected snapshot (see collectors.js) into ranked opportunity
 * `findings` — with ZERO LLM. Four rules, each documented and independently
 * testable:
 *
 *   1. automation      — a gotcha seen `occurrences >= 3` OR the SAME decision
 *                        appearing across `>= 2` digests → "automate / standardize X".
 *   2. underused-asset — a brain AREA with `files >= N` (default 10) whose name is
 *                        NOT mentioned in any recent digest → "parked asset".
 *   3. latent-demand   — a `client|product` entity with `mentions >= 5` and NO
 *                        relation to any `project` entity → "demand without a project".
 *   4. process-gap     — an area with files but no `_index.md` indexed, OR `>= 3`
 *                        decisions attributed to the same area within 30 days →
 *                        "process to formalize".
 *
 * Effort / impact are fixed 1-5 per rule (see {@link RULES}) — a curated table so
 * product can reason about the ranking without reading code. `score = impact /
 * effort`; findings are sorted by score desc (ties: impact desc, then title).
 *
 * Each finding carries a STABLE id = slug of its title, so `aios radar brief <id>`
 * resolves the same finding across runs.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RULE PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Curated effort/impact table (both 1-5). Rationale per rule:
 *   - automation:      low effort (the pain is already scripted-out by hand), high
 *                      impact (removes recurring toil / errors).
 *   - latent-demand:   low effort (a project just needs opening), highest impact
 *                      (a mentioned client/product wanting something = revenue).
 *   - underused-asset: medium effort (repositioning/publishing), medium impact.
 *   - process-gap:     medium effort (writing the process down), medium impact.
 *
 * @type {Record<string, {effort: number, impact: number}>}
 */
const RULES = {
  automation: { effort: 2, impact: 4 },
  'latent-demand': { effort: 2, impact: 5 },
  'underused-asset': { effort: 3, impact: 3 },
  'process-gap': { effort: 3, impact: 3 },
};

/** Default thresholds (all overridable through `analyze` options). */
const DEFAULTS = {
  gotchaOccurrences: 3, // automation: gotcha repeat threshold
  repeatedDecisionDigests: 2, // automation: same decision across >= N digests
  minAreaFiles: 10, // underused-asset: files in a brain area
  recentDigestDays: 90, // underused-asset: what "recent digest" means
  entityMentions: 5, // latent-demand: client/product mention threshold
  processDecisions: 3, // process-gap: decisions per area
  processWindowDays: 30, // process-gap: decision window
};

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC — ANALYZE
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Run every heuristic over a collected snapshot and return ranked findings.
 *
 * @param {Object} collected - Output of collectors.collect (any field may be null).
 * @param {Object} [options] - Threshold overrides + `now` injection (tests).
 * @param {number} [options.now] - Reference "now" epoch ms (defaults to Date.now()).
 * @returns {Array<{id: string, type: string, title: string, evidence: string[], area: (string|null), effort: number, impact: number, score: number}>}
 */
function analyze(collected, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const snapshot = collected || {};

  const findings = [
    ...detectAutomation(snapshot, cfg),
    ...detectUnderusedAssets(snapshot, cfg, now),
    ...detectLatentDemand(snapshot, cfg),
    ...detectProcessGaps(snapshot, cfg, now),
  ];

  return rank(dedupe(findings));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RULE 1 — AUTOMATION
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Automation opportunities: recurring gotchas + decisions repeated across digests.
 *
 * @param {Object} snapshot - Collected snapshot.
 * @param {Object} cfg - Effective config.
 * @returns {Array<Object>} Findings.
 */
function detectAutomation(snapshot, cfg) {
  const findings = [];

  // 1a. Recurring gotchas (occurrences >= threshold).
  for (const g of snapshot.gotchas || []) {
    if (g.occurrences >= cfg.gotchaOccurrences) {
      findings.push(
        makeFinding('automation', `Automatizar: ${g.title}`, null, [
          `Gotcha recorrente (${g.occurrences}x, severidade ${g.severity})`,
          `Categoria: ${g.category}`,
        ]),
      );
    }
  }

  // 1b. Same decision appearing across >= N digests.
  const decisionDigests = new Map(); // normalized decision → Set(files)
  const decisionLabel = new Map(); // normalized decision → original text
  for (const d of snapshot.digests || []) {
    for (const decision of d.decisions || []) {
      const key = normalizeText(decision);
      if (!key) continue;
      if (!decisionDigests.has(key)) {
        decisionDigests.set(key, new Set());
        decisionLabel.set(key, decision);
      }
      decisionDigests.get(key).add(d.file);
    }
  }
  for (const [key, files] of decisionDigests) {
    if (files.size >= cfg.repeatedDecisionDigests) {
      const label = decisionLabel.get(key);
      findings.push(
        makeFinding('automation', `Padronizar: ${label}`, null, [
          `Mesma decisão em ${files.size} digests`,
          `Digests: ${[...files].join(', ')}`,
        ]),
      );
    }
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RULE 2 — UNDERUSED ASSETS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Underused assets: brain areas heavy with content but absent from recent digests.
 *
 * @param {Object} snapshot - Collected snapshot.
 * @param {Object} cfg - Effective config.
 * @param {number} now - Reference epoch ms.
 * @returns {Array<Object>} Findings.
 */
function detectUnderusedAssets(snapshot, cfg, now) {
  const brain = snapshot.brainStats;
  if (!brain || !brain.areas) return [];

  const recentDigests = (snapshot.digests || []).filter((d) =>
    isWithinDays(d.date, now, cfg.recentDigestDays),
  );

  const findings = [];
  for (const [area, stat] of Object.entries(brain.areas)) {
    if (!stat || stat.files < cfg.minAreaFiles) continue;
    if (areaMentionedInDigests(area, recentDigests)) continue;

    findings.push(
      makeFinding('underused-asset', `Ativo parado: ${area}`, area, [
        `${stat.files} arquivos indexados na área "${area}"`,
        recentDigests.length
          ? `Sem menção em ${recentDigests.length} digest(s) recente(s)`
          : 'Nenhum digest recente menciona a área',
      ]),
    );
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RULE 3 — LATENT DEMAND
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Latent demand: a much-mentioned client/product with no link to any project.
 *
 * @param {Object} snapshot - Collected snapshot.
 * @param {Object} cfg - Effective config.
 * @returns {Array<Object>} Findings.
 */
function detectLatentDemand(snapshot, cfg) {
  const entities = snapshot.entities;
  if (!entities || !entities.length) return [];

  const byId = new Map(entities.map((e) => [e.id, e]));
  const findings = [];

  for (const entity of entities) {
    if (entity.type !== 'client' && entity.type !== 'product') continue;
    if (entity.mentions < cfg.entityMentions) continue;
    if (hasProjectRelation(entity, byId)) continue;

    findings.push(
      makeFinding(
        'latent-demand',
        `Demanda sem projeto: ${entity.name}`,
        null,
        [
          `${entity.type} mencionado ${entity.mentions}x`,
          'Sem relação com nenhuma entidade do tipo project',
        ],
      ),
    );
  }
  return findings;
}

/**
 * Whether an entity relates (in either direction, since we only hold the outbound
 * edge here) to a `project` entity.
 *
 * @param {Object} entity - Source entity.
 * @param {Map<string, Object>} byId - Entities keyed by id.
 * @returns {boolean}
 */
function hasProjectRelation(entity, byId) {
  for (const rel of entity.relations || []) {
    const target = byId.get(rel.target);
    if (target && target.type === 'project') return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              RULE 4 — PROCESS GAPS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Process gaps: areas lacking an `_index.md`, or areas accumulating many decisions
 * in a short window (a sign the process is ad-hoc and worth formalizing).
 *
 * @param {Object} snapshot - Collected snapshot.
 * @param {Object} cfg - Effective config.
 * @param {number} now - Reference epoch ms.
 * @returns {Array<Object>} Findings.
 */
function detectProcessGaps(snapshot, cfg, now) {
  const findings = [];
  const seenAreas = new Set();
  const brain = snapshot.brainStats;

  // 4a. Areas indexed but missing an `_index.md`.
  if (brain && brain.areas) {
    for (const [area, stat] of Object.entries(brain.areas)) {
      if (!stat || stat.files <= 0 || stat.hasIndex) continue;
      findings.push(
        makeFinding('process-gap', `Processo a formalizar: ${area}`, area, [
          `Área "${area}" com ${stat.files} arquivos e sem _index.md`,
        ]),
      );
      seenAreas.add(area);
    }
  }

  // 4b. >= N decisions attributed to the same area within the window.
  const knownAreas = collectKnownAreaNames(snapshot);
  if (knownAreas.length) {
    const counts = new Map();
    for (const d of snapshot.digests || []) {
      if (!isWithinDays(d.date, now, cfg.processWindowDays)) continue;
      for (const decision of d.decisions || []) {
        for (const area of knownAreas) {
          if (mentions(decision, area)) {
            counts.set(area, (counts.get(area) || 0) + 1);
          }
        }
      }
    }
    for (const [area, count] of counts) {
      if (count < cfg.processDecisions || seenAreas.has(area)) continue;
      findings.push(
        makeFinding('process-gap', `Processo a formalizar: ${area}`, area, [
          `${count} decisões sobre a área "${area}" em ${cfg.processWindowDays} dias`,
          'Decisões repetidas na mesma área sugerem processo não padronizado',
        ]),
      );
      seenAreas.add(area);
    }
  }

  return findings;
}

/**
 * The universe of area names to attribute decisions to: brain areas ∪ entity
 * names of type `area`.
 *
 * @param {Object} snapshot - Collected snapshot.
 * @returns {string[]}
 */
function collectKnownAreaNames(snapshot) {
  const names = new Set();
  if (snapshot.brainStats && snapshot.brainStats.areas) {
    for (const area of Object.keys(snapshot.brainStats.areas)) names.add(area);
  }
  for (const e of snapshot.entities || []) {
    if (e.type === 'area' && e.name) names.add(e.name);
  }
  return [...names];
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              SCORING + HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build a finding with its curated effort/impact and derived score + stable id.
 *
 * @param {string} type - Rule type.
 * @param {string} title - Human title (drives the id slug).
 * @param {string|null} area - Related area, if any.
 * @param {string[]} evidence - Evidence lines.
 * @returns {Object} Finding.
 */
function makeFinding(type, title, area, evidence) {
  const { effort, impact } = RULES[type];
  return {
    id: slug(title),
    type,
    title,
    evidence: evidence.filter(Boolean),
    area: area || null,
    effort,
    impact,
    score: Number((impact / effort).toFixed(3)),
  };
}

/**
 * Sort findings by score desc, then impact desc, then title asc (stable ordering).
 *
 * @param {Array<Object>} findings - Findings to rank.
 * @returns {Array<Object>}
 */
function rank(findings) {
  return [...findings].sort(
    (a, b) => b.score - a.score || b.impact - a.impact || a.title.localeCompare(b.title),
  );
}

/**
 * Drop findings sharing the same id (first wins), keeping ranking deterministic.
 *
 * @param {Array<Object>} findings - Raw findings.
 * @returns {Array<Object>}
 */
function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * Whether any recent digest mentions an area (in front-matter story/entities or a
 * decision title).
 *
 * @param {string} area - Area name.
 * @param {Array<Object>} digests - Recent digests.
 * @returns {boolean}
 */
function areaMentionedInDigests(area, digests) {
  for (const d of digests) {
    if (d.story && mentions(d.story, area)) return true;
    if (d.file && mentions(d.file, area)) return true;
    if ((d.entities || []).some((e) => mentions(e, area) || mentions(area, e))) return true;
    if ((d.decisions || []).some((dec) => mentions(dec, area))) return true;
  }
  return false;
}

/**
 * Case-insensitive substring test (both operands normalized). Used for loose
 * "is X referenced in Y" checks across heterogeneous text.
 *
 * @param {string} haystack - Text to search in.
 * @param {string} needle - Term to find.
 * @returns {boolean}
 */
function mentions(haystack, needle) {
  const h = String(haystack || '').toLowerCase();
  const n = String(needle || '').toLowerCase().trim();
  return Boolean(n) && h.includes(n);
}

/**
 * Whether an ISO date (YYYY-MM-DD) is within `days` of `now`. A missing/invalid
 * date is treated as recent (never filtered out — we prefer surfacing to hiding).
 *
 * @param {string|null} isoDate - Date string.
 * @param {number} now - Reference epoch ms.
 * @param {number} days - Window in days.
 * @returns {boolean}
 */
function isWithinDays(isoDate, now, days) {
  if (!isoDate) return true;
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return true;
  return now - ts <= days * 86400000;
}

/**
 * Normalize free text for equality comparison (lowercase, collapsed whitespace).
 *
 * @param {string} text - Input text.
 * @returns {string}
 */
function normalizeText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derive a stable slug id from a title. Local, dependency-free (kept decoupled
 * from brain/entities on purpose).
 *
 * @param {string} text - Title text.
 * @returns {string}
 */
function slug(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = {
  analyze,
  RULES,
  DEFAULTS,
  // Exposed for tests:
  detectAutomation,
  detectUnderusedAssets,
  detectLatentDemand,
  detectProcessGaps,
  slug,
};
