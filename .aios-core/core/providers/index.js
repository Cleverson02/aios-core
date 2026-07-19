/**
 * Providers module barrel (Story WSB-4.4).
 *
 * One import surface for: the credentials store (env-first key resolution),
 * deterministic availability (network-free), the `aios providers` CLI handler,
 * and the post-install setup wizard.
 *
 * The router consumes `unavailableProviders` / `readAvailabilityCache` lazily —
 * see `core/router/router.js`.
 *
 * @module core/providers
 * @version 1.0.0
 * @created Story WSB-4.4 — Provider Setup
 */

const credentials = require('./credentials-store');
const availability = require('./availability');
const { providersCommand } = require('./cli');
const { runSetup } = require('./setup-wizard');

module.exports = {
  // Credentials store
  PROVIDER_ENV: credentials.PROVIDER_ENV,
  KNOWN_PROVIDERS: credentials.KNOWN_PROVIDERS,
  aioxHome: credentials.aioxHome,
  credentialsPath: credentials.credentialsPath,
  setKey: credentials.setKey,
  getKey: credentials.getKey,
  getKeySource: credentials.getKeySource,
  removeKey: credentials.removeKey,
  listProviders: credentials.listProviders,

  // Availability
  CACHE_TTL_MS: availability.CACHE_TTL_MS,
  PROVIDER_CLI: availability.PROVIDER_CLI,
  knownProviders: availability.knownProviders,
  isEnabled: availability.isEnabled,
  setEnabled: availability.setEnabled,
  getAvailability: availability.getAvailability,
  readAvailabilityCache: availability.readAvailabilityCache,
  unavailableProviders: availability.unavailableProviders,

  // CLI + wizard
  providersCommand,
  runSetup,
};
