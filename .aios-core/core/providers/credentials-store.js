/**
 * Credentials Store — provider API keys on disk + env precedence (Story WSB-4.4).
 *
 * Keys live in `~/.aiox/credentials.json` (0600). The canonical env var of a
 * provider ALWAYS wins over the stored value, so CI / ephemeral shells can
 * override the file without editing it. The store is the fallback, never the
 * authority when an env var is present.
 *
 * Override the home dir with `AIOX_HOME` (used by tests to point at a tmp dir);
 * when unset it defaults to `<os.homedir()>/.aiox`.
 *
 * Security contract:
 *   - the file is written with mode 0600 (owner read/write only);
 *   - key VALUES are never logged and never returned by `listProviders()` —
 *     only presence + source are exposed.
 *
 * @module core/providers/credentials-store
 * @version 1.0.0
 * @created Story WSB-4.4 — Provider Setup
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Provider → ordered list of canonical env var names. The FIRST non-empty env
 * var found wins. Documented mapping (kept in sync with the story):
 *   anthropic → ANTHROPIC_API_KEY
 *   openai    → OPENAI_API_KEY
 *   xai       → XAI_API_KEY
 *   google    → GOOGLE_API_KEY | GEMINI_API_KEY
 *   telegram  → TELEGRAM_BOT_TOKEN
 *
 * @type {Record<string, string[]>}
 */
const PROVIDER_ENV = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  telegram: ['TELEGRAM_BOT_TOKEN'],
};

/** Canonical provider ids this store understands. */
const KNOWN_PROVIDERS = Object.keys(PROVIDER_ENV);

/**
 * Resolve the `.aiox` home directory. Read lazily (per call) so tests can flip
 * `AIOX_HOME` between cases without re-requiring the module.
 *
 * @returns {string} Absolute path to the `.aiox` home dir.
 */
function aioxHome() {
  return process.env.AIOX_HOME || path.join(os.homedir(), '.aiox');
}

/**
 * Absolute path to the credentials file.
 * @returns {string}
 */
function credentialsPath() {
  return path.join(aioxHome(), 'credentials.json');
}

/**
 * Assert a provider id is known; throw a clear error otherwise.
 * @param {string} provider - Provider id.
 * @throws {Error} On unknown provider.
 */
function assertKnownProvider(provider) {
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}" (known: ${KNOWN_PROVIDERS.join(', ')})`,
    );
  }
}

/**
 * Read the raw credentials object from disk (never throws on missing file).
 *
 * @returns {Record<string, string>} provider → key map (empty when no file).
 */
function readStore() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt store must not crash callers; treat it as empty (env still wins).
    return {};
  }
}

/**
 * Persist the credentials object with owner-only (0600) permissions. Creates the
 * home dir when missing. Never logs the payload.
 *
 * @param {Record<string, string>} store - provider → key map.
 */
function writeStore(store) {
  const home = aioxHome();
  fs.mkdirSync(home, { recursive: true });
  const file = credentialsPath();
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when creating the file; enforce on rewrite.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op / unsupported on some platforms (e.g. Windows) — ignore.
  }
}

/**
 * The canonical env value for a provider, if any env var in its list is set.
 *
 * @param {string} provider - Provider id.
 * @returns {string|null} The env-provided key, or null.
 */
function envKey(provider) {
  const names = PROVIDER_ENV[provider] || [];
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return null;
}

/**
 * Store (or overwrite) a provider key on disk.
 *
 * @param {string} provider - Provider id (must be known).
 * @param {string} key - API key / token (non-empty).
 * @throws {Error} On unknown provider or empty key.
 */
function setKey(provider, key) {
  assertKnownProvider(provider);
  if (!key || !String(key).trim()) {
    throw new Error(`Refusing to store an empty key for "${provider}"`);
  }
  const store = readStore();
  store[provider] = String(key).trim();
  writeStore(store);
}

/**
 * Resolve a provider key with env precedence: canonical env var → stored value.
 *
 * @param {string} provider - Provider id (must be known).
 * @returns {string|null} The resolved key, or null when neither source has one.
 * @throws {Error} On unknown provider.
 */
function getKey(provider) {
  assertKnownProvider(provider);
  const fromEnv = envKey(provider);
  if (fromEnv) return fromEnv;
  const store = readStore();
  const stored = store[provider];
  return stored && String(stored).trim() ? String(stored).trim() : null;
}

/**
 * Where a provider's key comes from, without revealing the value.
 *
 * @param {string} provider - Provider id (must be known).
 * @returns {'env'|'store'|null}
 * @throws {Error} On unknown provider.
 */
function getKeySource(provider) {
  assertKnownProvider(provider);
  if (envKey(provider)) return 'env';
  const store = readStore();
  const stored = store[provider];
  return stored && String(stored).trim() ? 'store' : null;
}

/**
 * Remove a provider key from the on-disk store. Env vars are untouched (the
 * store never controls the environment).
 *
 * @param {string} provider - Provider id (must be known).
 * @returns {boolean} True when a stored key was actually removed.
 * @throws {Error} On unknown provider.
 */
function removeKey(provider) {
  assertKnownProvider(provider);
  const store = readStore();
  if (!(provider in store)) return false;
  delete store[provider];
  writeStore(store);
  return true;
}

/**
 * Presence + source of a key for every known provider. NEVER returns key values.
 *
 * @returns {Array<{ provider: string, hasKey: boolean, source: 'env'|'store'|null }>}
 */
function listProviders() {
  return KNOWN_PROVIDERS.map((provider) => {
    const source = getKeySource(provider);
    return { provider, hasKey: source !== null, source };
  });
}

module.exports = {
  PROVIDER_ENV,
  KNOWN_PROVIDERS,
  aioxHome,
  credentialsPath,
  setKey,
  getKey,
  getKeySource,
  removeKey,
  listProviders,
};
