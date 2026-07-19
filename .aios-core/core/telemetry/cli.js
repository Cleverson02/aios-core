/**
 * @fileoverview `aios costs` CLI — human-readable telemetry views (Story WSB-4.5).
 *
 * Renders the deterministic ledger aggregates as a chalk-formatted table.
 * Subcommands:
 *   - summary [--since 7d] [--by provider|model|agent|storyId|project|day]
 *   - today                         (alias for `summary --since 24h --by provider`)
 *   - export --json                 (prints the raw aggregate as JSON)
 *
 * Wiring into `bin/aios.js` is out of scope for this story (lead owns it).
 *
 * @module core/telemetry/cli
 * @version 1.0.0
 * @created Story WSB-4.5 — Token Telemetry
 */

const chalk = require('chalk');

const { aggregate } = require('./report');

/** Human labels for the `--by` dimension in the table header. */
const DIMENSION_LABEL = {
  provider: 'PROVIDER',
  model: 'MODEL',
  agent: 'AGENT',
  storyId: 'STORY',
  project: 'PROJECT',
  day: 'DAY',
};

/**
 * Parse a flat argv-style array into { subcommand, flags }.
 * Supports `--flag value` and boolean `--flag`.
 *
 * @param {string[]} args - Arguments (e.g. ['summary', '--since', '7d']).
 * @returns {{subcommand: string, flags: Object}}
 */
function parseArgs(args = []) {
  const flags = {};
  let subcommand = 'summary';
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }

  if (positional.length > 0) subcommand = positional[0];
  return { subcommand, flags };
}

/**
 * Format a USD cost for display (4 decimals, `$` prefix), or `n/a` for null.
 * @param {number|null} value - Cost in USD.
 * @returns {string}
 */
function formatUsd(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return `$${value.toFixed(4)}`;
}

/**
 * Format a percentage (0–100) with a trailing `%`.
 * @param {number} value
 * @returns {string}
 */
function formatPct(value) {
  const n = typeof value === 'number' && !Number.isNaN(value) ? value : 0;
  return `${n.toFixed(0)}%`;
}

/**
 * Compute the cache-hit percentage: cachedInput / (input + cachedInput).
 * @param {Object} row - Group or totals row.
 * @returns {number} 0–100.
 */
function cachePct(row) {
  const denom = (row.inputTokens || 0) + (row.cachedInputTokens || 0);
  if (denom <= 0) return 0;
  return ((row.cachedInputTokens || 0) / denom) * 100;
}

/**
 * Render an aggregate result into a chalk-formatted table string.
 *
 * @param {{groups: Array, totals: Object}} result - Aggregate output.
 * @param {string} dimension - The groupBy dimension used.
 * @returns {string} Multi-line table.
 */
function renderTable(result, dimension) {
  const label = DIMENSION_LABEL[dimension] || dimension.toUpperCase();
  const header = [
    label.padEnd(18),
    'CALLS'.padStart(7),
    'INPUT'.padStart(10),
    'OUTPUT'.padStart(10),
    'CACHED'.padStart(10),
    'COST'.padStart(12),
    'CACHE%'.padStart(7),
    'EST%'.padStart(6),
  ].join('  ');

  const lines = [chalk.bold(header), chalk.dim('-'.repeat(header.length))];

  for (const g of result.groups) {
    lines.push(
      [
        String(g.key).slice(0, 18).padEnd(18),
        String(g.calls).padStart(7),
        String(g.inputTokens).padStart(10),
        String(g.outputTokens).padStart(10),
        String(g.cachedInputTokens).padStart(10),
        chalk.green(formatUsd(g.costUsd).padStart(12)),
        formatPct(cachePct(g)).padStart(7),
        formatPct(g.estimatedPct).padStart(6),
      ].join('  '),
    );
  }

  const t = result.totals;
  lines.push(chalk.dim('-'.repeat(header.length)));
  lines.push(
    chalk.bold(
      [
        'TOTAL'.padEnd(18),
        String(t.calls).padStart(7),
        String(t.inputTokens).padStart(10),
        String(t.outputTokens).padStart(10),
        String(t.cachedInputTokens).padStart(10),
        formatUsd(t.costUsd).padStart(12),
        formatPct(cachePct(t)).padStart(7),
        formatPct(t.estimatedPct).padStart(6),
      ].join('  '),
    ),
  );

  return lines.join('\n');
}

/** Friendly empty-state message with a next-step instruction. */
function emptyMessage() {
  return [
    chalk.yellow('Nenhum dado de telemetria ainda.'),
    chalk.dim(
      'As chamadas de IA são registradas automaticamente em .aios/telemetry/usage.jsonl.',
    ),
    chalk.dim('Execute algumas tarefas com os providers e rode novamente `aios costs summary`.'),
  ].join('\n');
}

/**
 * Execute the `aios costs` command.
 *
 * @param {string[]} [args=[]] - Argv-style args after `costs`.
 * @param {Object} [deps] - Injectable dependencies (for testing).
 * @param {Function} [deps.log=console.log] - Output sink.
 * @param {string} [deps.cwd] - Project root.
 * @param {number} [deps.now] - Reference "now" for relative `since`.
 * @returns {Promise<string>} The rendered output (also written via `log`).
 */
async function costsCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const cwd = deps.cwd || process.cwd();
  const { subcommand, flags } = parseArgs(args);

  let since = flags.since;
  let groupBy = flags.by || 'provider';
  const asJson = Boolean(flags.json) || subcommand === 'export';

  if (subcommand === 'today') {
    since = '24h';
    groupBy = flags.by || 'provider';
  }

  const result = await aggregate({ cwd, groupBy, since, now: deps.now });

  if (asJson) {
    const out = JSON.stringify({ groupBy, since: since || null, ...result }, null, 2);
    log(out);
    return out;
  }

  if (!result.groups.length) {
    const out = emptyMessage();
    log(out);
    return out;
  }

  const scope = since ? chalk.dim(` (since ${since})`) : '';
  const title = chalk.bold.cyan(`AIOS costs — por ${groupBy}${scope}`);
  const table = renderTable(result, groupBy);
  const out = `${title}\n${table}`;
  log(out);
  return out;
}

module.exports = {
  costsCommand,
  parseArgs,
  renderTable,
  formatUsd,
  cachePct,
};
