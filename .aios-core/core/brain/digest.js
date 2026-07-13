#!/usr/bin/env node

/**
 * AIOS Brain — Session Digest
 *
 * Story: WSB-1.6 - Session Digest (o cérebro aprende com cada sessão)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * At the end of a session/story a digest is written as a versioned document in
 * the workspace (`docs/digests/YYYY-MM-DD[-<slug>].md`) and re-indexed, so the
 * knowledge produced while working becomes queryable company memory. Digests are
 * SHARED knowledge → they live in the project content (git-versioned, visible to
 * the team) rather than in the local brainDir.
 *
 * A digest gathers, all via graceful degradation (never throws):
 *   - Git commits since the last digest (fallback: last 10 commits).
 *   - Changed files (committed in range + uncommitted via `git status`).
 *   - Autonomous decisions from SessionMemory (WSB-0.2) + recent `.ai/*.md`.
 *   - Recent gotchas (WSB / Epic 9 gotchas memory).
 *   - Business entities (WSB-1.4) mentioned in the digest text → front-matter.
 *
 * Design constraints:
 * - Zero new dependencies: native child_process/fs/path + existing chalk/js-yaml.
 * - Git is invoked via `execFile('git', …)` — never shell-interpolated — and the
 *   whole git path is wrapped in try/catch: no git / errors → sections omitted.
 * - Total graceful degradation: any missing source degrades to an omitted section.
 *
 * Wiring of the `aios brain digest` subcommand into brain/cli.js is done by the
 * lead; this module only exposes `generateDigest` and `digestCommand`.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const chalk = require('chalk');
const yaml = require('js-yaml');

const SessionMemory = require('../memory/session-memory');
const GotchasMemory = require('../memory/gotchas-memory');
const { BrainIndexer } = require('./indexer');
const { EntityStore, slugify } = require('./entities/entity-store');

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

/** Directory (relative to cwd) where shared digests are written. */
const DIGESTS_DIR = path.join('docs', 'digests');

/** Directory (relative to cwd) holding decision-log markdown files. */
const DECISION_LOGS_DIR = '.ai';

/** Buffer ceiling for git output (2 MB — plenty for log/status). */
const GIT_MAX_BUFFER = 2 * 1024 * 1024;

/** Maximum decisions pulled from SessionMemory. */
const DECISIONS_LIMIT = 20;

/** Maximum gotchas surfaced when no base date narrows the window. */
const GOTCHAS_CAP = 10;

/** Fallback commit count when there is no prior digest to anchor a range. */
const COMMITS_FALLBACK = 10;

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC — GENERATE
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Generate (and, unless `dryRun`, persist + re-index) a session digest.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Workspace root (defaults to process.cwd()).
 * @param {string} [options.storyId] - Story id, used for the filename slug + front-matter.
 * @param {string} [options.summary] - Human summary; when absent one is generated from counts.
 * @param {string} [options.agent] - Authoring agent id (front-matter).
 * @param {boolean} [options.dryRun=false] - Build the content but do not write / index.
 * @param {string} [options.brainDir] - Override the brain persistence dir (entities + re-index).
 * @returns {Promise<{path: string, content: string, sections: {commits: number, files: number, decisions: number, gotchas: number}, indexed: boolean}>}
 */
async function generateDigest(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const { storyId = null, summary = null, agent = null, dryRun = false } = options;
  const brainDir = options.brainDir || BrainIndexer.defaultBrainDir(cwd);

  // Base date: the most recent existing digest anchors the "since" window.
  const baseDate = findLastDigestDate(cwd);
  const baseDateMs = baseDate ? Date.parse(baseDate) : 0;

  // --- Collect sources (each fully guarded) ------------------------------------
  const git = await collectGit(cwd, baseDate);
  const decisions = await collectDecisions(cwd, baseDateMs);
  const gotchas = collectGotchas(cwd, baseDateMs);

  // --- Assemble body first (entities are detected from the rendered text) -------
  const today = formatDate(new Date());
  const body = buildBody({
    summary,
    counts: {
      commits: git.commits.length,
      files: git.files.length,
      decisions: decisions.length,
      gotchas: gotchas.length,
    },
    decisions,
    files: git.files,
    commits: git.commits,
    gotchas,
  });

  const entities = detectEntities(body, brainDir);
  const frontMatter = buildFrontMatter({ date: today, story: storyId, agent, entities });
  const content = `${frontMatter}\n${body}`;

  const targetPath = resolveDigestPath(cwd, today, storyId);

  const sections = {
    commits: git.commits.length,
    files: git.files.length,
    decisions: decisions.length,
    gotchas: gotchas.length,
  };

  if (dryRun) {
    return { path: targetPath, content, sections, indexed: false };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');

  // Post-write incremental re-index — a failure here never fails the digest.
  let indexed = false;
  try {
    await new BrainIndexer({ cwd, brainDir }).index({ incremental: true });
    indexed = true;
  } catch (_err) {
    indexed = false;
  }

  return { path: targetPath, content, sections, indexed };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC — CLI
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * `aios brain digest [--story X] [--summary "…"] [--agent Y] [--dry-run]`.
 *
 * @param {string[]} [args] - Arguments after `digest`.
 * @returns {Promise<number>} Process-style exit code (0 = ok, 1 = error).
 */
async function digestCommand(args = []) {
  const { flags } = parseArgs(args);

  try {
    const result = await generateDigest({
      cwd: process.cwd(),
      storyId: typeof flags.story === 'string' ? flags.story : undefined,
      summary: typeof flags.summary === 'string' ? flags.summary : undefined,
      agent: typeof flags.agent === 'string' ? flags.agent : undefined,
      dryRun: Boolean(flags['dry-run']),
    });

    const { sections } = result;
    if (flags['dry-run']) {
      console.log(chalk.cyan('🧠 Digest (dry-run) — nada gravado.'));
      console.log(chalk.dim(`  Destino: ${result.path}`));
    } else {
      console.log(chalk.green('✔ Digest gravado') + chalk.dim(` — ${result.path}`));
      console.log(
        chalk.dim(`  Index incremental: ${result.indexed ? 'ok' : 'ignorado (falhou)'}`),
      );
    }

    console.log(
      chalk.dim(
        `  ${sections.commits} commit(s), ${sections.files} arquivo(s), ` +
          `${sections.decisions} decisão(ões), ${sections.gotchas} aprendizado(s)`,
      ),
    );
    return 0;
  } catch (err) {
    console.log(chalk.red(`Falha ao gerar digest: ${err instanceof Error ? err.message : err}`));
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — GIT
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Collect commits + changed files from git. Fully guarded: a missing repo or any
 * git error yields empty collections (sections omitted downstream).
 *
 * @param {string} cwd - Workspace root.
 * @param {string|null} baseDate - ISO date (YYYY-MM-DD) to anchor `--since`, or null.
 * @returns {Promise<{commits: Array<{hash: string, subject: string, author: string, date: string}>, files: string[]}>}
 */
async function collectGit(cwd, baseDate) {
  const empty = { commits: [], files: [] };

  if (!(await isGitRepo(cwd))) {
    return empty;
  }

  try {
    const rangeArgs = baseDate ? ['--since', baseDate] : ['-n', String(COMMITS_FALLBACK)];

    // Commits: tab-separated fields, one per line.
    const logOut = await runGit(cwd, [
      'log',
      ...rangeArgs,
      '--no-merges',
      '--pretty=format:%h\t%s\t%an\t%ad',
      '--date=short',
    ]);
    const commits = parseCommits(logOut);

    // Changed files committed in the same range (equivalent to the range diff).
    const filesOut = await runGit(cwd, ['log', ...rangeArgs, '--name-only', '--pretty=format:']);
    const committedFiles = parseFileList(filesOut);

    // Uncommitted changes (staged + working tree).
    const statusOut = await runGit(cwd, ['status', '--porcelain']);
    const uncommittedFiles = parseStatusFiles(statusOut);

    const files = uniq([...committedFiles, ...uncommittedFiles]).sort();
    return { commits, files };
  } catch (_err) {
    return empty;
  }
}

/**
 * Whether `cwd` is inside a git work tree (never throws).
 *
 * @param {string} cwd - Directory to probe.
 * @returns {Promise<boolean>}
 */
async function isGitRepo(cwd) {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    return String(out).trim() === 'true';
  } catch (_err) {
    return false;
  }
}

/**
 * Run a git command, returning stdout. Rejects (caught by callers) on failure.
 *
 * @param {string} cwd - Working directory.
 * @param {string[]} args - Git arguments (never shell-interpolated).
 * @returns {Promise<string>} stdout.
 */
async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

/**
 * Parse `git log --pretty=format:%h\t%s\t%an\t%ad` output into commit records.
 *
 * @param {string} out - Raw git output.
 * @returns {Array<{hash: string, subject: string, author: string, date: string}>}
 */
function parseCommits(out) {
  return String(out || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split('\t');
      return {
        hash: hash || '',
        subject: subject || '',
        author: author || '',
        date: date || '',
      };
    })
    .filter((c) => c.hash);
}

/**
 * Parse a `--name-only` file listing (blank-line separated across commits).
 *
 * @param {string} out - Raw git output.
 * @returns {string[]} Unique file paths.
 */
function parseFileList(out) {
  return uniq(
    String(out || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Parse `git status --porcelain` into a list of affected paths (handles renames).
 *
 * @param {string} out - Raw git output.
 * @returns {string[]}
 */
function parseStatusFiles(out) {
  const files = [];
  for (const raw of String(out || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Porcelain: "XY <path>" or "XY <old> -> <new>".
    const rest = raw.slice(3).trim();
    const arrow = rest.split(' -> ');
    files.push((arrow.length > 1 ? arrow[1] : rest).trim());
  }
  return uniq(files.filter(Boolean));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — DECISIONS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Collect decisions from SessionMemory, complemented by recent `.ai/*.md` titles.
 * Fully guarded — any failure degrades to whatever was gathered so far.
 *
 * @param {string} cwd - Workspace root.
 * @param {number} baseDateMs - Epoch ms cut-off (0 = include all).
 * @returns {Promise<Array<{decision: string, reason: (string|null)}>>}
 */
async function collectDecisions(cwd, baseDateMs) {
  const collected = [];
  const seen = new Set();

  const push = (decision, reason) => {
    const text = String(decision || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    collected.push({ decision: text, reason: reason || null });
  };

  // 1. SessionMemory (store or its own .ai fallback).
  try {
    const memory = new SessionMemory({ projectRoot: cwd });
    const decisions = await memory.getDecisions({ limit: DECISIONS_LIMIT });
    for (const d of decisions) push(d.decision, d.reason);
  } catch (_err) {
    // Ignore — SessionMemory unavailable.
  }

  // 2. Complement with recent decision-log titles (mtime > base date).
  try {
    for (const title of recentDecisionLogTitles(cwd, baseDateMs)) {
      push(title, null);
    }
  } catch (_err) {
    // Ignore — decision logs unavailable.
  }

  return collected;
}

/**
 * First-header titles of `.ai/*.md` files modified after the base date.
 *
 * @param {string} cwd - Workspace root.
 * @param {number} baseDateMs - Epoch ms cut-off (0 = include all).
 * @returns {string[]}
 */
function recentDecisionLogTitles(cwd, baseDateMs) {
  const dir = path.join(cwd, DECISION_LOGS_DIR);
  if (!fs.existsSync(dir)) return [];

  const titles = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (baseDateMs && stat.mtimeMs <= baseDateMs) continue;
      const raw = fs.readFileSync(file, 'utf8');
      titles.push(firstHeader(raw) || path.basename(file, '.md'));
    } catch (_err) {
      // Skip unreadable files.
    }
  }
  return titles;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — GOTCHAS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Collect recent gotchas (created/seen after the base date). Fully guarded.
 *
 * @param {string} cwd - Workspace root.
 * @param {number} baseDateMs - Epoch ms cut-off (0 = include the most recent cap).
 * @returns {Array<{title: string, description: string, severity: string}>}
 */
function collectGotchas(cwd, baseDateMs) {
  try {
    const memory = new GotchasMemory(cwd, { quiet: true });
    const list = memory.listGotchas({ unresolved: false });

    const timestamp = (g) => {
      const value = g.createdAt || (g.source && g.source.lastSeen) || (g.source && g.source.firstSeen);
      const ms = value ? Date.parse(value) : NaN;
      return Number.isNaN(ms) ? 0 : ms;
    };

    let recent = list.filter((g) => timestamp(g) > baseDateMs);
    recent.sort((a, b) => timestamp(b) - timestamp(a));
    if (!baseDateMs) recent = recent.slice(0, GOTCHAS_CAP);

    return recent.map((g) => ({
      title: g.title || 'Gotcha',
      description: g.description || '',
      severity: g.severity || 'info',
    }));
  } catch (_err) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — ENTITIES
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Detect business entities (WSB-1.4) mentioned in the digest text. Best-effort:
 * when `entities.json` is absent the result is an empty list.
 *
 * @param {string} content - Rendered digest body.
 * @param {string} brainDir - Brain persistence directory.
 * @returns {string[]} Canonical entity names found (deduped, name-sorted).
 */
function detectEntities(content, brainDir) {
  try {
    if (!fs.existsSync(path.join(brainDir, 'entities.json'))) return [];

    const store = new EntityStore({ brainDir }).load();
    const entities = store.list();
    if (!entities.length) return [];

    const found = new Map();
    for (const entity of entities) {
      const needles = [entity.name, ...(entity.aliases || [])].filter(Boolean);
      if (needles.some((needle) => mentions(content, needle))) {
        found.set(entity.id, entity.name);
      }
    }
    return Array.from(found.values()).sort((a, b) => a.localeCompare(b));
  } catch (_err) {
    return [];
  }
}

/**
 * Whether `needle` appears in `text` on unicode word boundaries (case-insensitive).
 *
 * @param {string} text - Haystack.
 * @param {string} needle - Term to search.
 * @returns {boolean}
 */
function mentions(text, needle) {
  const term = String(needle || '').trim();
  if (!term) return false;
  try {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    return re.test(text);
  } catch (_err) {
    return text.toLowerCase().includes(term.toLowerCase());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — MARKDOWN ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Build the YAML front-matter block. Empty/absent keys are omitted; the output is
 * always valid YAML (via js-yaml) delimited by `---` fences.
 *
 * @param {Object} params
 * @param {string} params.date - ISO date (YYYY-MM-DD).
 * @param {string|null} [params.story] - Story id.
 * @param {string|null} [params.agent] - Authoring agent.
 * @param {string[]} [params.entities] - Detected entity names.
 * @returns {string}
 */
function buildFrontMatter({ date, story, agent, entities }) {
  const data = { date };
  if (story) data.story = story;
  if (agent) data.agent = agent;
  if (entities && entities.length) data.entities = entities;

  const yamlBlock = yaml.dump(data, { lineWidth: -1 }).trimEnd();
  return `---\n${yamlBlock}\n---\n`;
}

/**
 * Build the digest body. Empty sections are omitted entirely (AC2/AC4).
 *
 * @param {Object} params
 * @param {string|null} params.summary - Caller summary (generated from counts when absent).
 * @param {{commits: number, files: number, decisions: number, gotchas: number}} params.counts
 * @param {Array<{decision: string, reason: (string|null)}>} params.decisions
 * @param {string[]} params.files
 * @param {Array<{hash: string, subject: string, author: string, date: string}>} params.commits
 * @param {Array<{title: string, description: string, severity: string}>} params.gotchas
 * @returns {string}
 */
function buildBody({ summary, counts, decisions, files, commits, gotchas }) {
  const parts = [];

  parts.push(`## Resumo\n\n${summary && summary.trim() ? summary.trim() : generateSummary(counts)}`);

  if (decisions.length) {
    const lines = decisions
      .map((d) => `- ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`)
      .join('\n');
    parts.push(`## Decisões\n\n${lines}`);
  }

  if (files.length) {
    const lines = files.map((f) => `- ${f}`).join('\n');
    parts.push(`## Arquivos alterados\n\n${lines}`);
  }

  if (commits.length) {
    const lines = commits
      .map((c) => `- \`${c.hash}\` ${c.subject} (${c.author}, ${c.date})`)
      .join('\n');
    parts.push(`## Commits\n\n${lines}`);
  }

  if (gotchas.length) {
    const lines = gotchas
      .map((g) => `- [${g.severity}] ${g.title}${g.description ? `: ${g.description}` : ''}`)
      .join('\n');
    parts.push(`## Aprendizados (gotchas)\n\n${lines}`);
  }

  return `${parts.join('\n\n')}\n`;
}

/**
 * Generate a one-line summary from the collected counts.
 *
 * @param {{commits: number, files: number, decisions: number, gotchas: number}} counts
 * @returns {string}
 */
function generateSummary(counts) {
  return (
    `Sessão registrada com ${counts.commits} commit(s), ${counts.files} arquivo(s) ` +
    `alterado(s), ${counts.decisions} decisão(ões) e ${counts.gotchas} aprendizado(s).`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — PATHS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a non-colliding digest path: `<cwd>/docs/digests/<date>[-<slug>].md`,
 * suffixing `-2`, `-3`, … when the target already exists (AC6, never overwrites).
 *
 * @param {string} cwd - Workspace root.
 * @param {string} date - ISO date (YYYY-MM-DD).
 * @param {string|null} storyId - Story id used for the slug.
 * @returns {string} Absolute path.
 */
function resolveDigestPath(cwd, date, storyId) {
  const dir = path.join(cwd, DIGESTS_DIR);
  const slug = storyId ? slugify(storyId) : '';
  const base = slug ? `${date}-${slug}` : date;

  let candidate = path.join(dir, `${base}.md`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${counter}.md`);
    counter++;
  }
  return candidate;
}

/**
 * Find the most recent digest date already present in `docs/digests/`, by parsing
 * the leading `YYYY-MM-DD` of each filename. Returns null when none exist.
 *
 * @param {string} cwd - Workspace root.
 * @returns {string|null} ISO date (YYYY-MM-DD) or null.
 */
function findLastDigestDate(cwd) {
  const dir = path.join(cwd, DIGESTS_DIR);
  try {
    if (!fs.existsSync(dir)) return null;
    let latest = null;
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!match) continue;
      if (!latest || match[1] > latest) latest = match[1];
    }
    return latest;
  } catch (_err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL — GENERIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Parse a minimal `--flag value` / `--flag` argv slice.
 * (Duplicated from brain/cli.js by design — this module stays decoupled.)
 *
 * @param {string[]} argv - Arguments to parse.
 * @returns {{flags: Object, positionals: string[]}}
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

/**
 * Format a Date as a local `YYYY-MM-DD` string.
 *
 * @param {Date} date - Date to format.
 * @returns {string}
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Extract the first markdown header from content.
 *
 * @param {string} raw - Markdown content.
 * @returns {string|null}
 */
function firstHeader(raw) {
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.*)$/);
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

/**
 * De-duplicate a list of strings, preserving order.
 *
 * @param {string[]} list - Input list.
 * @returns {string[]}
 */
function uniq(list) {
  return Array.from(new Set(list));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = { generateDigest, digestCommand };
