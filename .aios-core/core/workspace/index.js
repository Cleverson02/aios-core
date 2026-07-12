/**
 * Workspace module barrel.
 *
 * Public contract consumed by other AIOX modules (brain indexer, CLI wiring).
 *
 * @module core/workspace
 * @created Story WSB-1.1 — Workspace Manager
 */

const {
  WorkspaceManager,
  TIER_PERMISSIONS,
  TIER_ORDER,
  TIER_FOLDERS,
  MANIFEST_FILENAME,
} = require('./workspace-manager');

const { workspaceCommand } = require('./cli');

module.exports = {
  WorkspaceManager,
  workspaceCommand,
  TIER_PERMISSIONS,
  TIER_ORDER,
  TIER_FOLDERS,
  MANIFEST_FILENAME,
};
