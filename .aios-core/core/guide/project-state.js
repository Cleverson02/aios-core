'use strict';

/**
 * Project State Detection (Story WSB-4.8 — Guided Mode).
 *
 * Deterministic, filesystem-only inspection of a project to answer the
 * question "where am I in the AIOS methodology?". ZERO LLM calls, zero network.
 * Everything below is derived from files on disk and a best-effort `git status`.
 *
 * The output `stage` follows the AIOS lifecycle:
 *   ideation → architecture → planning → development → review → done
 *
 * @module core/guide/project-state
 * @version 1.0.0
 * @author @dev (Dex)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Canonical ordering of the methodology stages. */
const STAGE_ORDER = ['ideation', 'architecture', 'planning', 'development', 'review', 'done'];

/** How many header lines of each story file we read to find the Status field. */
const STORY_HEADER_LINES = 30;

/**
 * Normalize a raw `**Status:**` value into a stable key.
 *
 * @param {string} raw - Raw status text from the story header.
 * @returns {'draft'|'in_progress'|'ready_for_review'|'approved'|'done'|'other'}
 */
function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/[-_]+/g, ' ').trim();
  if (s.includes('progress')) return 'in_progress';
  if (s.includes('ready for review') || s === 'review') return 'ready_for_review';
  if (s.includes('approved')) return 'approved';
  if (s.includes('done') || s.includes('complete')) return 'done';
  if (s.includes('draft')) return 'draft';
  return 'other';
}

/**
 * Recursively collect files matching a predicate under a directory.
 *
 * @param {string} dir - Directory to walk.
 * @param {(name: string) => boolean} match - Predicate over the base filename.
 * @param {string[]} [out] - Accumulator.
 * @returns {string[]} Absolute file paths.
 */
function walk(dir, match, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, match, out);
    } else if (entry.isFile() && match(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True when `docs/prd.md` or a `docs/prd/` directory exists.
 *
 * @param {string} cwd - Project root.
 * @returns {boolean}
 */
function detectPrd(cwd) {
  const docs = path.join(cwd, 'docs');
  return fs.existsSync(path.join(docs, 'prd.md')) || isDir(path.join(docs, 'prd'));
}

/**
 * True when any `docs/architecture*` file or directory exists.
 *
 * @param {string} cwd - Project root.
 * @returns {boolean}
 */
function detectArchitecture(cwd) {
  const docs = path.join(cwd, 'docs');
  if (fs.existsSync(path.join(docs, 'architecture.md')) || isDir(path.join(docs, 'architecture'))) {
    return true;
  }
  let entries;
  try {
    entries = fs.readdirSync(docs);
  } catch {
    return false;
  }
  return entries.some((name) => name.toLowerCase().startsWith('architecture'));
}

/**
 * @param {string} p - Path to test.
 * @returns {boolean} True when `p` is an existing directory.
 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse the Story ID / Status / title from a story markdown file (header only).
 *
 * @param {string} file - Absolute path to the story file.
 * @returns {{ id: string, status: string, title: string, file: string }}
 */
function parseStory(file) {
  let header = '';
  try {
    header = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, STORY_HEADER_LINES).join('\n');
  } catch {
    // Unreadable file → treat as unknown/other.
  }

  const statusMatch = header.match(/\*\*Status:\*\*\s*(.+)/i);
  const idMatch = header.match(/\*\*Story ID:\*\*\s*(.+)/i);
  const titleMatch = header.match(/^#\s+(.+)$/m);

  const idFromName = path.basename(file).replace(/^story[-_]?/i, '').replace(/\.md$/i, '');

  return {
    id: (idMatch ? idMatch[1] : idFromName).trim(),
    status: normalizeStatus(statusMatch ? statusMatch[1] : ''),
    title: (titleMatch ? titleMatch[1] : path.basename(file)).trim(),
    file,
  };
}

/**
 * Scan `docs/stories/**\/story*.md`, returning per-status counts and the most
 * recent actionable story (in-progress preferred, then approved).
 *
 * @param {string} cwd - Project root.
 * @returns {{ total: number, counts: Record<string, number>, items: object[], mostRecentInProgress: object|null, mostRecentActionable: object|null }}
 */
function scanStories(cwd) {
  const storiesDir = path.join(cwd, 'docs', 'stories');
  const files = walk(storiesDir, (name) => /^story.*\.md$/i.test(name));
  const items = files.map(parseStory);

  const counts = {
    draft: 0, in_progress: 0, ready_for_review: 0, approved: 0, done: 0, other: 0,
  };
  for (const item of items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }

  const byIdDesc = (a, b) => b.id.localeCompare(a.id, undefined, { numeric: true, sensitivity: 'base' });
  const inProgress = items.filter((i) => i.status === 'in_progress').sort(byIdDesc);
  const approved = items.filter((i) => i.status === 'approved').sort(byIdDesc);

  const mostRecentInProgress = inProgress[0] || null;
  const mostRecentActionable = mostRecentInProgress || approved[0] || null;

  return { total: items.length, counts, items, mostRecentInProgress, mostRecentActionable };
}

/**
 * Detect autonomous builds still running (`plan/*\/build-state.json` with
 * `status: in_progress`).
 *
 * @param {string} cwd - Project root.
 * @returns {Array<{ dir: string, status: string }>}
 */
function detectActiveBuilds(cwd) {
  const planDir = path.join(cwd, 'plan');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(planDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(planDir, entry.name, 'build-state.json');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (String(state.status || '').toLowerCase() === 'in_progress') {
        out.push({ dir: entry.name, status: state.status });
      }
    } catch {
      // No / invalid build-state.json in this plan dir → skip.
    }
  }
  return out;
}

/**
 * Best-effort `git status --porcelain`. Never throws (returns false on any
 * failure — no repo, git missing, permission error, etc.).
 *
 * @param {string} cwd - Project root.
 * @returns {boolean} True when the working tree has uncommitted changes.
 */
function detectGitDirty(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * True when a `workspace.yaml` is reachable from `cwd` (WSB-1.1 WorkspaceManager).
 *
 * @param {string} cwd - Project root.
 * @returns {boolean}
 */
function detectWorkspace(cwd) {
  try {
    const WorkspaceManager = require('../workspace/workspace-manager');
    return WorkspaceManager.findManifest(cwd) !== null;
  } catch {
    return false;
  }
}

/**
 * True when a brain index exists for `cwd` (WSB-1.2 BrainIndexer default dir).
 *
 * @param {string} cwd - Project root.
 * @returns {boolean}
 */
function detectBrainIndex(cwd) {
  try {
    const BrainIndexer = require('../brain/indexer');
    const brainDir = BrainIndexer.defaultBrainDir(cwd);
    return fs.existsSync(path.join(brainDir, 'index.json'));
  } catch {
    return false;
  }
}

/**
 * Derive the methodology stage from the collected facts (deterministic).
 *
 * @param {object} facts - Collected facts.
 * @returns {'ideation'|'architecture'|'planning'|'development'|'review'|'done'}
 */
function deriveStage(facts) {
  const { hasPrd, hasArchitecture, stories, activeBuilds } = facts;
  const c = stories.counts;

  if (!hasPrd) return 'ideation';
  if (!hasArchitecture) return 'architecture';
  if (stories.total === 0) return 'planning';

  if (activeBuilds.length > 0 || c.in_progress > 0 || c.approved > 0) return 'development';
  if (c.done === stories.total) return 'done';
  if (c.ready_for_review > 0 && c.ready_for_review + c.done === stories.total) return 'review';
  if (c.ready_for_review > 0) return 'review';
  return 'planning'; // only drafts / unknown remain
}

/**
 * Build the human-readable evidence lines (PT) for the current state.
 *
 * @param {object} facts - Collected facts.
 * @returns {string[]}
 */
function buildEvidence(facts) {
  const { hasPrd, hasArchitecture, stories, activeBuilds, gitDirty, hasWorkspace, hasBrainIndex } = facts;
  const c = stories.counts;
  const ev = [];

  ev.push(hasPrd ? 'PRD encontrado em docs/.' : 'Nenhum PRD em docs/ (docs/prd.md ou docs/prd/).');
  ev.push(hasArchitecture ? 'Arquitetura documentada em docs/architecture.' : 'Arquitetura ainda não documentada.');

  if (stories.total === 0) {
    ev.push('Nenhuma story criada ainda.');
  } else {
    ev.push(
      `${stories.total} story(ies): ${c.in_progress} em progresso, ${c.approved} aprovada(s), `
      + `${c.ready_for_review} para review, ${c.done} done.`,
    );
  }

  if (activeBuilds.length > 0) {
    ev.push(`${activeBuilds.length} build(s) autônomo(s) em andamento.`);
  }
  if (gitDirty) {
    ev.push('Working tree com mudanças não commitadas.');
  }
  ev.push(hasWorkspace ? 'Workspace configurado (workspace.yaml).' : 'Sem workspace.yaml (rode aios workspace init).');
  ev.push(hasBrainIndex ? 'Brain indexado (aios brain index).' : 'Brain ainda não indexado (rode aios brain index).');

  return ev;
}

/**
 * Detect the full project state deterministically from the filesystem.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()] - Project root to inspect.
 * @returns {{
 *   stage: string,
 *   evidence: string[],
 *   hasPrd: boolean,
 *   hasArchitecture: boolean,
 *   stories: object,
 *   activeBuilds: Array<{dir: string, status: string}>,
 *   gitDirty: boolean,
 *   hasWorkspace: boolean,
 *   hasBrainIndex: boolean
 * }}
 */
function detectProjectState({ cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd);

  const facts = {
    hasPrd: detectPrd(root),
    hasArchitecture: detectArchitecture(root),
    stories: scanStories(root),
    activeBuilds: detectActiveBuilds(root),
    gitDirty: detectGitDirty(root),
    hasWorkspace: detectWorkspace(root),
    hasBrainIndex: detectBrainIndex(root),
  };

  const stage = deriveStage(facts);
  const evidence = buildEvidence(facts);

  return { stage, evidence, ...facts };
}

module.exports = {
  detectProjectState,
  normalizeStatus,
  deriveStage,
  STAGE_ORDER,
};
