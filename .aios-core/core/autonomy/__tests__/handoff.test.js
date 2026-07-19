/**
 * Tests — Handoff Packet + Fresh Window (Story WSB-3.2).
 *
 * Covers: full generation (build-state + story + session-memory + gotchas),
 * incremental numbering (-1/-2/-3, no overwrite), graceful degradation with
 * missing sources, latest-packet resolution, continuation prompt, and
 * spawnFreshWindow (mocked spawner + dryRun + headless fallback). No real
 * terminal is ever spawned.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The spawner is mocked so the suite NEVER opens a real terminal.
jest.mock('../../orchestration/terminal-spawner', () => ({
  detectEnvironment: jest.fn(),
  spawnAgent: jest.fn(),
}));
const spawner = require('../../orchestration/terminal-spawner');

const { generateHandoffPacket, loadHandoffPacket } = require('../handoff-packet');
const { spawnFreshWindow, buildContinuationPrompt } = require('../fresh-window');

const STORY_ID = 'WSB-3.2';

// ───────────────────────────────────────────────────────────────────────────
//                              FIXTURE HELPERS
// ───────────────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wsb32-handoff-'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeStory(cwd) {
  const dir = path.join(cwd, 'docs', 'stories', 'epics');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'story-wsb-3.2-handoff-fresh-window.md');
  fs.writeFileSync(
    file,
    [
      '# Story WSB-3.2: Handoff Packet + Fresh Window',
      '',
      '**Status:** In Progress',
      '',
      '## Acceptance Criteria',
      '',
      '- [x] AC1: coleta build state e story',
      '- [ ] AC2: pacote gravado com numeração incremental',
      '- [ ] AC3: fresh window degrada sem terminal visual',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

function writeBuildState(cwd) {
  const now = new Date().toISOString();
  writeJson(path.join(cwd, 'plan', 'build-state.json'), {
    storyId: STORY_ID,
    startedAt: now,
    status: 'in_progress',
    currentSubtask: '3.2.2',
    completedSubtasks: ['3.2.1'],
    lastCheckpoint: now,
    checkpoints: [
      { id: 'cp-abc', timestamp: now, subtaskId: '3.2.1', status: 'completed' },
    ],
    worktree: null,
    metrics: { totalSubtasks: 3, completedSubtasks: 1 },
  });
}

function writeSessionMemory(cwd) {
  writeJson(path.join(cwd, '.aios', 'session-memory.json'), [
    {
      decision: 'Usar CommonJS + JSDoc',
      reason: 'consistência com o core',
      timestamp: new Date().toISOString(),
    },
    {
      decision: 'Numeração incremental de handoffs',
      reason: 'nunca sobrescrever pacotes',
      timestamp: new Date().toISOString(),
    },
  ]);
}

function writeGotchas(cwd) {
  writeJson(path.join(cwd, '.aios', 'gotchas.json'), {
    gotchas: [
      {
        id: 'g-handoff-1',
        title: 'Handoff nunca deve sobrescrever',
        description: 'O handoff packet precisa de numeração incremental para resume seguro',
        category: 'general',
        severity: 'warning',
        resolved: false,
        relatedFiles: [],
        trigger: null,
        workaround: null,
        source: { type: 'manual', occurrences: 1, firstSeen: '', lastSeen: '' },
      },
    ],
  });
}

function fullFixture() {
  const cwd = makeTmpDir();
  writeStory(cwd);
  writeBuildState(cwd);
  writeSessionMemory(cwd);
  writeGotchas(cwd);
  return cwd;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
//                              GENERATION
// ───────────────────────────────────────────────────────────────────────────

describe('generateHandoffPacket — full generation', () => {
  test('collects build, story, decisions and gotchas and writes both twins', async () => {
    const cwd = fullFixture();
    const { path: mdPath, jsonPath, packet } = await generateHandoffPacket({
      cwd,
      storyId: STORY_ID,
      reason: 'red-zone',
      zoneSnapshot: { zone: 'red', percentUsed: 92, bracket: 'CRITICAL' },
    });

    // Files exist as <storyId>-1.{md,json}.
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(path.basename(mdPath)).toBe('WSB-3.2-1.md');
    expect(path.basename(jsonPath)).toBe('WSB-3.2-1.json');

    // Build state collected via BuildStateManager.
    expect(packet.build).not.toBeNull();
    expect(packet.build.status).toBe('in_progress');
    expect(packet.build.completedSubtasks).toEqual(['3.2.1']);
    expect(packet.nextSubtask).toBe('3.2.2');

    // Story collected with open checkboxes.
    expect(packet.story).not.toBeNull();
    expect(packet.story.path).toContain('story-wsb-3.2-handoff-fresh-window.md');
    expect(packet.story.openCheckboxes.length).toBe(2);
    expect(packet.story.doneCount).toBe(1);

    // Decisions from SessionMemory.
    expect(packet.decisions.length).toBeGreaterThanOrEqual(2);
    expect(packet.decisions.map((d) => d.decision)).toContain('Usar CommonJS + JSDoc');

    // Relevant gotcha surfaced.
    expect(packet.gotchas.length).toBeGreaterThanOrEqual(1);
    expect(packet.gotchas[0].title).toContain('Handoff');

    // Markdown carries front-matter + required sections.
    const md = fs.readFileSync(mdPath, 'utf8');
    expect(md.startsWith('---')).toBe(true);
    expect(md).toContain(`storyId: ${STORY_ID}`);
    expect(md).toContain('sequence: 1');
    expect(md).toContain('## Estado do Build');
    expect(md).toContain('## Próxima Subtask');
    expect(md).toContain('## Story');
    expect(md).toContain('## Decisões');
    expect(md).toContain('## Gotchas');
    expect(md).toContain('## Instruções de Retomada');
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              INCREMENTAL NUMBERING
// ───────────────────────────────────────────────────────────────────────────

describe('generateHandoffPacket — incremental numbering', () => {
  test('produces -1/-2/-3 and never overwrites', async () => {
    const cwd = fullFixture();

    const first = await generateHandoffPacket({ cwd, storyId: STORY_ID });
    const second = await generateHandoffPacket({ cwd, storyId: STORY_ID });
    const third = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    expect(first.packet.sequence).toBe(1);
    expect(second.packet.sequence).toBe(2);
    expect(third.packet.sequence).toBe(3);

    // All three pairs persist simultaneously (no overwrite).
    const dir = path.join(cwd, '.aios', 'autonomy', 'handoffs');
    const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    expect(jsonFiles).toEqual(['WSB-3.2-1.json', 'WSB-3.2-2.json', 'WSB-3.2-3.json']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              GRACEFUL DEGRADATION (AC5)
// ───────────────────────────────────────────────────────────────────────────

describe('generateHandoffPacket — missing sources', () => {
  test('story-only fixture yields a valid packet with omitted sections', async () => {
    const cwd = makeTmpDir();
    writeStory(cwd); // no build-state, no session-memory, no gotchas

    const { path: mdPath, packet } = await generateHandoffPacket({
      cwd,
      storyId: STORY_ID,
    });

    expect(packet.build).toBeNull();
    expect(packet.decisions).toEqual([]);
    expect(packet.gotchas).toEqual([]);
    expect(packet.story).not.toBeNull();
    // Next subtask falls back to the first open checkbox.
    expect(packet.nextSubtask).toBe(packet.story.openCheckboxes[0]);

    const md = fs.readFileSync(mdPath, 'utf8');
    expect(md).not.toContain('## Estado do Build');
    expect(md).not.toContain('## Gotchas');
    expect(md).toContain('## Story');
    expect(md).toContain('## Instruções de Retomada');
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              LOAD
// ───────────────────────────────────────────────────────────────────────────

describe('loadHandoffPacket', () => {
  test('resolves the most recent packet by story id', async () => {
    const cwd = fullFixture();
    await generateHandoffPacket({ cwd, storyId: STORY_ID });
    await generateHandoffPacket({ cwd, storyId: STORY_ID });
    await generateHandoffPacket({ cwd, storyId: STORY_ID });

    const loaded = await loadHandoffPacket(STORY_ID, { cwd });
    expect(loaded).not.toBeNull();
    expect(loaded.packet.sequence).toBe(3);
    expect(loaded.path).toContain('WSB-3.2-3.md');
    expect(typeof loaded.markdown).toBe('string');
    expect(loaded.markdown).toContain('## Story');
  });

  test('loads directly from an explicit path', async () => {
    const cwd = fullFixture();
    const { jsonPath } = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    const loaded = await loadHandoffPacket(jsonPath, { cwd });
    expect(loaded).not.toBeNull();
    expect(loaded.packet.storyId).toBe(STORY_ID);
  });

  test('returns null when nothing resolves', async () => {
    const cwd = makeTmpDir();
    const loaded = await loadHandoffPacket('NOPE-9.9', { cwd });
    expect(loaded).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              CONTINUATION PROMPT
// ───────────────────────────────────────────────────────────────────────────

describe('buildContinuationPrompt', () => {
  test('includes the next subtask and a 3-line state summary', async () => {
    const cwd = fullFixture();
    const { packet } = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    const prompt = buildContinuationPrompt(packet);
    expect(prompt).toContain('3.2.2'); // next subtask
    expect(prompt).toContain('1. Story:');
    expect(prompt).toContain('2. Build:');
    expect(prompt).toContain('3. Próxima subtask: 3.2.2');
  });
});

// ───────────────────────────────────────────────────────────────────────────
//                              SPAWN FRESH WINDOW (AC3)
// ───────────────────────────────────────────────────────────────────────────

describe('spawnFreshWindow', () => {
  test('dryRun returns the command without spawning', async () => {
    const cwd = fullFixture();
    const { jsonPath } = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    const result = await spawnFreshWindow({ packetPath: jsonPath, cwd, dryRun: true });
    expect(result.spawned).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.command).toBe(`aios run resume ${STORY_ID}`);
    expect(spawner.spawnAgent).not.toHaveBeenCalled();
  });

  test('spawns via terminal-spawner when a visual terminal is available', async () => {
    const cwd = fullFixture();
    const { jsonPath } = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    spawner.detectEnvironment.mockReturnValue({
      type: 'NATIVE_TERMINAL',
      supportsVisualTerminal: true,
    });
    spawner.spawnAgent.mockResolvedValue({ success: true, output: 'ok' });

    const result = await spawnFreshWindow({ packetPath: jsonPath, cwd });
    expect(result.spawned).toBe(true);
    expect(result.environment).toBe('NATIVE_TERMINAL');
    expect(spawner.spawnAgent).toHaveBeenCalledTimes(1);
    const [agent, task] = spawner.spawnAgent.mock.calls[0];
    expect(agent).toBe('dev');
    expect(task).toBe('resume-story');
  });

  test('headless environment degrades to copy-paste instructions (no spawn)', async () => {
    const cwd = fullFixture();
    const { jsonPath } = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    spawner.detectEnvironment.mockReturnValue({
      type: 'CI',
      supportsVisualTerminal: false,
    });

    const result = await spawnFreshWindow({ packetPath: jsonPath, cwd });
    expect(result.spawned).toBe(false);
    expect(result.instructions).toBe(`aios run resume ${STORY_ID}`);
    expect(spawner.spawnAgent).not.toHaveBeenCalled();
  });

  test('never throws when the spawner fails', async () => {
    const cwd = fullFixture();
    const { jsonPath } = await generateHandoffPacket({ cwd, storyId: STORY_ID });

    spawner.detectEnvironment.mockReturnValue({
      type: 'NATIVE_TERMINAL',
      supportsVisualTerminal: true,
    });
    spawner.spawnAgent.mockRejectedValue(new Error('boom'));

    const result = await spawnFreshWindow({ packetPath: jsonPath, cwd });
    expect(result.spawned).toBe(false);
    expect(result.instructions).toBe(`aios run resume ${STORY_ID}`);
    expect(result.error).toBe('boom');
  });
});
