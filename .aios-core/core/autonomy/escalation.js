/**
 * Escalation — Autonomy Engine (Story WSB-3.3)
 *
 * When a long autonomous run hits a wall (a subtask stuck after repeated
 * failures, a Bob surface-criterion trip, a red context zone, ...), it must
 * stop guessing and pull a human in with *actionable* context instead of
 * burning tokens in a loop.
 *
 * `escalate()` does three things, defensively and in order:
 *   1. Consults the codified Bob surface-criteria (SurfaceChecker, Story 11.4)
 *      so the escalation carries the triggered criterion when applicable.
 *   2. Routes a blocking notification through the quality-gates
 *      NotificationManager (Story 3.5) when a channel is available.
 *   3. ALWAYS writes a durable, human-readable escalation record to
 *      `.aios/autonomy/escalations/<ISO-ts>-<slug>.md`.
 *
 * No channel available (or the notifier throws) is not an error: we still
 * write the file and return `{ notified: false }`. Nothing here is allowed to
 * throw back into the caller's build loop.
 *
 * REUSE (consume-only, never modified here):
 * - `orchestration/surface-checker` — `createSurfaceChecker`/`shouldSurface`.
 * - `quality-gates/notification-manager` — `sendBlockingNotification`.
 *
 * Zero new dependencies; pure fs/path + existing modules.
 *
 * @module core/autonomy/escalation
 * @author @dev (Dex)
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Escalation artifacts live under `.aios/autonomy/escalations/`. */
const ESCALATIONS_SUBDIR = path.join('.aios', 'autonomy', 'escalations');

/**
 * Escalate to the human with actionable context.
 *
 * @param {Object} params
 * @param {string} params.reason - Short machine/human reason (e.g. 'stuck').
 * @param {Object} [params.context] - Actionable context. Recognised fields:
 *   `subtaskId`, `attempts`, `lastError`, `storyId`. Any extra fields are
 *   forwarded to the surface-criteria evaluation as-is.
 * @param {string} [params.cwd] - Working directory (defaults to process.cwd()).
 * @param {Object|null} [params.notifier] - DI override for the NotificationManager
 *   instance. `undefined` → lazily build the real one; `null` → skip notification.
 * @param {Object|null} [params.surfaceChecker] - DI override for the SurfaceChecker.
 *   `undefined` → lazily build the real one; `null` → skip the surface check.
 * @returns {Promise<{notified: boolean, channel: (string|null), filePath: string, surface: (Object|null)}>}
 */
async function escalate({
  reason,
  context = {},
  cwd = process.cwd(),
  notifier,
  surfaceChecker,
} = {}) {
  const safeReason = reason || 'unspecified';
  const timestamp = new Date().toISOString();

  // ── 1. Surface-criteria consultation (best-effort) ───────────────────────
  const surface = evaluateSurface(context, surfaceChecker);

  // ── 2. Notification routing (best-effort) ────────────────────────────────
  const delivery = await deliverNotification({
    reason: safeReason,
    context,
    surface,
    timestamp,
    cwd,
    notifier,
  });

  // ── 3. Durable record (ALWAYS) ───────────────────────────────────────────
  const filePath = writeEscalationFile({
    reason: safeReason,
    context,
    surface,
    delivery,
    timestamp,
    cwd,
  });

  return {
    notified: delivery.notified,
    channel: delivery.channel,
    filePath,
    surface,
  };
}

/**
 * Evaluate Bob surface-criteria against the escalation context.
 *
 * The escalation context is mapped onto the fields the criteria understand
 * (notably `errors_in_task`/`error_summary` for C004 consecutive_errors), so a
 * subtask stuck after N failures naturally trips the "pause and ask help"
 * criterion. Never throws — a missing/broken checker just yields `null`.
 *
 * @private
 * @param {Object} context - Escalation context.
 * @param {Object|null|undefined} injected - DI checker override.
 * @returns {Object|null} SurfaceResult or null.
 */
function evaluateSurface(context, injected) {
  try {
    // Explicit null → caller asked us to skip the surface check.
    if (injected === null) {
      return null;
    }

    let checker = injected;
    if (checker === undefined) {
      const { createSurfaceChecker } = require('../orchestration/surface-checker');
      checker = createSurfaceChecker();
    }
    if (!checker || typeof checker.shouldSurface !== 'function') {
      return null;
    }

    const surfaceContext = {
      // C004 consecutive_errors: errors_in_task >= 2
      errors_in_task: typeof context.attempts === 'number' ? context.attempts : undefined,
      error_summary: context.lastError || context.error || 'sem detalhes',
      // Forward any caller-supplied surface fields verbatim.
      ...context,
    };

    return checker.shouldSurface(surfaceContext);
  } catch {
    // Surface evaluation is advisory — never let it break an escalation.
    return null;
  }
}

/**
 * Route a blocking notification through the quality-gates NotificationManager.
 *
 * @private
 * @param {Object} params
 * @returns {Promise<{notified: boolean, channel: (string|null)}>}
 */
async function deliverNotification({ reason, context, surface, timestamp, cwd, notifier }) {
  try {
    // Explicit null → caller asked us to skip notification entirely.
    if (notifier === null) {
      return { notified: false, channel: null };
    }

    let nm = notifier;
    if (nm === undefined) {
      const { NotificationManager } = require('../quality-gates/notification-manager');
      nm = new NotificationManager({
        notificationsPath: path.join(cwd, '.aios', 'notifications'),
      });
    }

    if (!nm || typeof nm.sendBlockingNotification !== 'function') {
      return { notified: false, channel: null };
    }

    const subtaskLabel = context.subtaskId ? `subtask ${context.subtaskId}` : (context.storyId || 'autonomous run');
    const detail =
      `[${context.storyId || 'run'}] ${reason}` +
      (context.lastError ? ` — ${context.lastError}` : '');

    const result = await nm.sendBlockingNotification({
      stoppedAt: timestamp,
      reason,
      issues: [
        {
          severity: surface?.severity || 'error',
          check: subtaskLabel,
          message: detail,
        },
      ],
      fixFirst: buildSuggestedActions(reason, context, surface).map((s) => ({
        issue: reason,
        suggestion: s,
      })),
    });

    const notified = result && result.success === true;
    const channel = resolveChannel(result, notified);
    return { notified: Boolean(notified), channel };
  } catch {
    // No channel / delivery error → graceful degradation (AC4).
    return { notified: false, channel: null };
  }
}

/**
 * Resolve a human-readable channel label from the notifier result.
 *
 * @private
 * @param {Object} result - NotificationManager result.
 * @param {boolean} notified - Whether delivery reported success.
 * @returns {string|null}
 */
function resolveChannel(result, notified) {
  if (!notified) {
    return null;
  }
  const channels = result && result.channels;
  if (channels && typeof channels === 'object') {
    const successful = Object.keys(channels).filter((c) => channels[c] && channels[c].success);
    if (successful.length > 0) {
      return successful.join(',');
    }
  }
  return 'notification-manager';
}

/**
 * Build the "suggested next actions" list for the escalation record.
 *
 * @private
 * @param {string} reason - Escalation reason.
 * @param {Object} context - Escalation context.
 * @param {Object|null} surface - Surface-check result.
 * @returns {string[]}
 */
function buildSuggestedActions(reason, context, surface) {
  const actions = [];

  if (context.subtaskId) {
    actions.push(
      `Inspecionar a subtask \`${context.subtaskId}\`` +
        (context.lastError ? ` — último erro: ${context.lastError}` : '') +
        '.',
    );
  }

  if (String(reason).toLowerCase().includes('stuck')) {
    actions.push('Tentar uma abordagem diferente ou dividir a subtask em passos menores.');
    actions.push('Se persistir, pular a subtask ou parar a execução para revisão manual.');
  }

  if (surface?.should_surface && surface.message) {
    actions.push(`Responder ao critério de superfície ${surface.criterion_id}: ${surface.message.trim().split('\n')[0]}`);
  }

  if (context.storyId) {
    actions.push(`Retomar o build da story \`${context.storyId}\` após a intervenção.`);
  }

  if (actions.length === 0) {
    actions.push('Revisar o contexto acima e decidir manualmente como prosseguir.');
  }

  return actions;
}

/**
 * Write the durable Markdown escalation record. Always attempts a write; the
 * path is returned even if the write fails so callers can log it.
 *
 * @private
 * @param {Object} params
 * @returns {string} Absolute path of the escalation file.
 */
function writeEscalationFile({ reason, context, surface, delivery, timestamp, cwd }) {
  const dir = path.join(cwd, ESCALATIONS_SUBDIR);
  const fileName = `${timestamp.replace(/[:.]/g, '-')}-${slugify(reason)}.md`;
  const filePath = path.join(dir, fileName);

  const surfaceLine = surface?.should_surface
    ? `${surface.criterion_id} — ${surface.criterion_name} (severity: ${surface.severity})`
    : 'nenhum critério disparado';

  const actions = buildSuggestedActions(reason, context, surface);

  const lines = [
    `# Escalação: ${reason}`,
    '',
    `- **Timestamp:** ${timestamp}`,
    `- **Story:** ${context.storyId || 'N/A'}`,
    `- **Subtask:** ${context.subtaskId || 'N/A'}`,
    `- **Tentativas:** ${context.attempts != null ? context.attempts : 'N/A'}`,
    `- **Último erro:** ${context.lastError || context.error || 'N/A'}`,
    `- **Notificado:** ${delivery.notified ? `sim (${delivery.channel})` : 'não (nenhum canal disponível)'}`,
    '',
    '## Surface-check',
    '',
    surfaceLine,
  ];

  if (surface?.should_surface && surface.message) {
    lines.push('', '```', surface.message.trim(), '```');
  }

  lines.push('', '## Próximas ações sugeridas', '');
  actions.forEach((action, idx) => {
    lines.push(`${idx + 1}. ${action}`);
  });
  lines.push('');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  } catch {
    // Best-effort: the record path is still returned for logging/telemetry.
  }

  return filePath;
}

/**
 * Filesystem-safe slug from a reason string.
 *
 * @private
 * @param {string} value - Raw reason.
 * @returns {string} Slug (alphanumerics + dashes, trimmed, non-empty).
 */
function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'escalation';
}

module.exports = {
  escalate,
  slugify,
  ESCALATIONS_SUBDIR,
};
