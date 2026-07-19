/**
 * Provider Availability — deterministic, network-free readiness (Story WSB-4.4).
 *
 * For each provider referenced by the capability matrix we answer three local
 * questions and cache the verdict:
 *   - `keyPresent` — is an API key resolvable? (env var or on-disk store)
 *   - `cliPresent` — is the provider's CLI installed? (`<cli> --version`, 3s cap)
 *                    `null` for API-only providers (e.g. xAI Grok has no CLI).
 *   - `enabled`    — has the user switched this provider OFF? (`~/.aiox/providers.json`)
 * A provider is `available` when it is `enabled` AND (has a key OR has its CLI).
 *
 * Determinism / safety contract:
 *   - NEVER performs a network request — CLI `--version` is the only spawn, and
 *     it is bounded by a 3s timeout with output discarded.
 *   - Results are cached in `<cwd>/.aios/providers-status.json` with a 1h TTL;
 *     `refresh: true` recomputes and rewrites the cache.
 *   - The router consumes the cache synchronously via `readAvailabilityCache()`,
 *     which does NO probing at all — it only reads what a prior `check` wrote.
 *
 * @module core/providers/availability
 * @version 1.0.0
 * @created Story WSB-4.4 — Provider Setup
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { loadMatrix } = require('../router/matrix-loader');
const credentials = require('./credentials-store');

/** Cache time-to-live: 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** CLI version probe timeout (ms). */
const CLI_PROBE_TIMEOUT_MS = 3000;

/** Cache file path relative to a cwd. */
const CACHE_RELPATH = path.join('.aios', 'providers-status.json');

/**
 * Provider → local CLI command used for the `--version` probe. Providers absent
 * from this map (or mapped to `null`) are API-only and get `cliPresent: null`.
 *
 * @type {Record<string, string|null>}
 */
const PROVIDER_CLI = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  xai: null, // API-only (XAI_API_KEY) — no CLI to probe.
};

/**
 * Absolute path to the availability cache under a project root.
 * @param {string} cwd - Project root.
 * @returns {string}
 */
function cachePath(cwd) {
  return path.join(cwd || process.cwd(), CACHE_RELPATH);
}

/**
 * Absolute path to the per-provider enabled-flags file (`~/.aiox/providers.json`).
 * @returns {string}
 */
function providersConfigPath() {
  return path.join(credentials.aioxHome(), 'providers.json');
}

/**
 * The set of provider ids referenced by the capability matrix models.
 *
 * @param {string} [cwd] - Project root (for a possible matrix override).
 * @returns {string[]} Sorted, de-duplicated provider ids.
 */
function knownProviders(cwd) {
  const matrix = loadMatrix({ projectRoot: cwd });
  const set = new Set(Object.values(matrix.models).map((m) => m.provider));
  return [...set].sort();
}

/**
 * Read the enabled-flags map (never throws on missing/corrupt file).
 * @returns {Record<string, boolean>}
 */
function readEnabledConfig() {
  const file = providersConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether a provider is enabled (default true when never toggled).
 * @param {string} provider - Provider id.
 * @returns {boolean}
 */
function isEnabled(provider) {
  const config = readEnabledConfig();
  return config[provider] !== false;
}

/**
 * Persist a provider's enabled flag to `~/.aiox/providers.json`.
 *
 * @param {string} provider - Provider id.
 * @param {boolean} enabled - Desired flag.
 */
function setEnabled(provider, enabled) {
  const home = credentials.aioxHome();
  fs.mkdirSync(home, { recursive: true });
  const config = readEnabledConfig();
  config[provider] = Boolean(enabled);
  fs.writeFileSync(providersConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Probe whether a CLI is installed via a bounded `<cli> --version`. Never throws;
 * a missing binary or a timeout both yield `false`. Never touches the network.
 *
 * @param {string} cli - CLI command name.
 * @returns {boolean}
 */
function probeCli(cli) {
  try {
    childProcess.execFileSync(cli, ['--version'], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute a single provider's availability record (no cache, does probe).
 *
 * @param {string} provider - Provider id.
 * @returns {{ provider: string, keyPresent: boolean, cliPresent: boolean|null,
 *   enabled: boolean, available: boolean }}
 */
function computeProvider(provider) {
  const keyPresent = credentials.KNOWN_PROVIDERS.includes(provider)
    ? credentials.getKey(provider) !== null
    : false;

  const cli = Object.prototype.hasOwnProperty.call(PROVIDER_CLI, provider)
    ? PROVIDER_CLI[provider]
    : null;
  const cliPresent = cli ? probeCli(cli) : null;

  const enabled = isEnabled(provider);
  const available = enabled && (keyPresent || cliPresent === true);

  return { provider, keyPresent, cliPresent, enabled, available };
}

/**
 * Read the availability cache synchronously WITHOUT probing. Returns `null` when
 * the file is missing or unparseable. This is the router's entry point: it must
 * be cheap, deterministic and side-effect free.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root holding `.aios/providers-status.json`.
 * @returns {{ generatedAt: number, providers: Record<string, Object> }|null}
 */
function readAvailabilityCache({ cwd } = {}) {
  const file = cachePath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.providers) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether a cached payload is still within TTL.
 * @param {{ generatedAt?: number }} payload - Cache payload.
 * @returns {boolean}
 */
function isFresh(payload) {
  if (!payload || typeof payload.generatedAt !== 'number') return false;
  return Date.now() - payload.generatedAt < CACHE_TTL_MS;
}

/**
 * Get provider availability, using the cache when fresh unless `refresh` is set.
 * Recomputation probes local CLIs and rewrites `<cwd>/.aios/providers-status.json`.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root for the matrix override + cache.
 * @param {boolean} [options.refresh=false] - Force recomputation (ignore cache).
 * @returns {{ generatedAt: number, providers: Record<string, Object>, fromCache: boolean }}
 */
function getAvailability({ cwd, refresh = false } = {}) {
  const root = cwd || process.cwd();

  if (!refresh) {
    const cached = readAvailabilityCache({ cwd: root });
    if (cached && isFresh(cached)) {
      return { ...cached, fromCache: true };
    }
  }

  const providers = {};
  for (const provider of knownProviders(root)) {
    providers[provider] = computeProvider(provider);
  }

  const payload = { generatedAt: Date.now(), providers };
  writeCache(root, payload);
  return { ...payload, fromCache: false };
}

/**
 * Persist the availability cache under `<cwd>/.aios/`.
 * @param {string} cwd - Project root.
 * @param {Object} payload - Cache payload.
 */
function writeCache(cwd, payload) {
  const file = cachePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * The set of provider ids that are explicitly unavailable in the current cache.
 * Returns `null` when there is no cache to read (router then filters nothing).
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Project root.
 * @returns {Set<string>|null}
 */
function unavailableProviders({ cwd } = {}) {
  const cached = readAvailabilityCache({ cwd });
  if (!cached) return null;
  const set = new Set();
  for (const [provider, rec] of Object.entries(cached.providers)) {
    if (rec && rec.available === false) set.add(provider);
  }
  return set;
}

module.exports = {
  CACHE_TTL_MS,
  PROVIDER_CLI,
  knownProviders,
  isEnabled,
  setEnabled,
  getAvailability,
  readAvailabilityCache,
  unavailableProviders,
  cachePath,
  providersConfigPath,
};
