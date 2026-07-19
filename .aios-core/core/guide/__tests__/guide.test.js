'use strict';

/**
 * Tests for Guided Mode (Story WSB-4.8).
 *
 * Everything is deterministic and filesystem-driven — fixtures per stage in a
 * tmp dir, WIS mocked. NO LLM calls are exercised.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mutable WIS mock (prefix `mock` is required by jest's factory scope rules).
let mockWisSuggestions = [];
jest.mock('../../../workflow-intelligence', () => ({
  getSuggestions: jest.fn(() => mockWisSuggestions),
}));

const { detectProjectState } = require('../project-state');
const { getNextStep } = require('../next-step');
const { nextCommand } = require('../cli');

/**
 * Create a tmp project from a declarative spec.
 * @param {object} spec
 * @returns {string} project dir
 */
function mkProject(spec = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb48-'));
  const docs = path.join(dir, 'docs');

  if (spec.prd) {
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'prd.md'), '# PRD\n');
  }
  if (spec.arch) {
    fs.mkdirSync(path.join(docs, 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'architecture', 'overview.md'), '# Arch\n');
  }
  if (spec.stories) {
    const storiesDir = path.join(docs, 'stories', 'epics');
    fs.mkdirSync(storiesDir, { recursive: true });
    for (const s of spec.stories) {
      const file = path.join(storiesDir, `story-${s.id.toLowerCase().replace(/[.\s]/g, '-')}.md`);
      fs.writeFileSync(
        file,
        `# Story ${s.id}: ${s.title || 'Test'}\n\n**Story ID:** ${s.id}\n**Status:** ${s.status}\n`,
      );
    }
  }
  if (spec.build) {
    const planDir = path.join(dir, 'plan', 'build-1');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'build-state.json'), JSON.stringify({ status: 'in_progress' }));
  }
  if (spec.session) {
    const aiosDir = path.join(dir, '.aios');
    fs.mkdirSync(aiosDir, { recursive: true });
    fs.writeFileSync(path.join(aiosDir, 'session-state.json'), JSON.stringify(spec.session));
  }
  return dir;
}

beforeEach(() => {
  mockWisSuggestions = [];
});

describe('detectProjectState — stage detection', () => {
  test('empty project → ideation', () => {
    const cwd = mkProject({});
    const state = detectProjectState({ cwd });
    expect(state.stage).toBe('ideation');
    expect(state.hasPrd).toBe(false);
    expect(Array.isArray(state.evidence)).toBe(true);
    expect(state.evidence.length).toBeGreaterThan(0);
  });

  test('PRD only → architecture', () => {
    const cwd = mkProject({ prd: true });
    expect(detectProjectState({ cwd }).stage).toBe('architecture');
  });

  test('PRD + architecture, no stories → planning', () => {
    const cwd = mkProject({ prd: true, arch: true });
    expect(detectProjectState({ cwd }).stage).toBe('planning');
  });

  test('a story In Progress → development', () => {
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [
        { id: 'WSB-A.1', status: 'Done' },
        { id: 'WSB-A.9', status: 'In Progress' },
      ],
    });
    expect(detectProjectState({ cwd }).stage).toBe('development');
  });

  test('all Ready for Review → review', () => {
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [
        { id: 'WSB-B.1', status: 'Ready for Review' },
        { id: 'WSB-B.2', status: 'Ready for Review' },
      ],
    });
    expect(detectProjectState({ cwd }).stage).toBe('review');
  });

  test('all Done → done', () => {
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [
        { id: 'WSB-C.1', status: 'Done' },
        { id: 'WSB-C.2', status: 'Done' },
      ],
    });
    expect(detectProjectState({ cwd }).stage).toBe('done');
  });

  test('git absent does not throw', () => {
    const cwd = mkProject({});
    expect(() => detectProjectState({ cwd })).not.toThrow();
    expect(typeof detectProjectState({ cwd }).gitDirty).toBe('boolean');
  });
});

describe('getNextStep — methodology fallback', () => {
  test('ideation → @analyst *brainstorm (methodology)', () => {
    const cwd = mkProject({});
    const step = getNextStep({ cwd });
    expect(step.source).toBe('methodology');
    expect(step.nextAgent).toBe('@analyst');
    expect(step.nextCommand).toBe('*brainstorm');
    expect(typeof step.why).toBe('string');
    expect(step.alternatives.length).toBeLessThanOrEqual(2);
  });

  test('planning → @po *create-story', () => {
    const cwd = mkProject({ prd: true, arch: true });
    const step = getNextStep({ cwd });
    expect(step.nextAgent).toBe('@po');
    expect(step.nextCommand).toBe('*create-story');
  });

  test('development → develop-story points at the in-progress story', () => {
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [
        { id: 'WSB-A.1', status: 'Done' },
        { id: 'WSB-A.9', status: 'In Progress' },
      ],
    });
    const step = getNextStep({ cwd });
    expect(step.nextAgent).toBe('@dev');
    expect(step.nextCommand).toContain('WSB-A.9');
    expect(step.nextCommand).not.toContain('WSB-A.1');
  });

  test('active build → aios run resume', () => {
    const cwd = mkProject({
      prd: true,
      arch: true,
      build: true,
      stories: [{ id: 'WSB-A.9', status: 'In Progress' }],
    });
    const step = getNextStep({ cwd });
    expect(step.nextCommand).toBe('aios run resume');
  });

  test('review → @qa *review-story', () => {
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [{ id: 'WSB-B.1', status: 'Ready for Review' }],
    });
    const step = getNextStep({ cwd });
    expect(step.nextAgent).toBe('@qa');
    expect(step.nextCommand).toBe('*review-story');
  });
});

describe('getNextStep — WIS integration', () => {
  test('high-confidence WIS suggestion → source "wis"', () => {
    mockWisSuggestions = [
      {
        command: 'develop', description: 'Continue o desenvolvimento', confidence: 0.9, agentSequence: ['@dev'],
      },
      {
        command: 'review-story', description: 'Revise depois', confidence: 0.6,
      },
    ];
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [{ id: 'WSB-A.9', status: 'In Progress' }],
      session: { lastCommands: ['*create-story', '*develop'], agentSequence: [{ agentId: '@dev' }] },
    });
    const step = getNextStep({ cwd });
    expect(step.source).toBe('wis');
    expect(step.nextAgent).toBe('@dev');
    expect(step.nextCommand).toBe('*develop');
    expect(step.alternatives.length).toBeLessThanOrEqual(2);
  });

  test('low-confidence WIS → falls back to methodology', () => {
    mockWisSuggestions = [{ command: 'develop', confidence: 0.2 }];
    const cwd = mkProject({
      prd: true,
      arch: true,
      stories: [{ id: 'WSB-A.9', status: 'In Progress' }],
      session: { lastCommands: ['*develop'], agentSequence: [{ agentId: '@dev' }] },
    });
    expect(getNextStep({ cwd }).source).toBe('methodology');
  });

  test('no session context → methodology even if WIS could match', () => {
    mockWisSuggestions = [{ command: 'develop', confidence: 0.9 }];
    const cwd = mkProject({ prd: true, arch: true });
    expect(getNextStep({ cwd }).source).toBe('methodology');
  });
});

describe('nextCommand CLI', () => {
  let writeSpy;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    process.chdir(originalCwd);
  });

  test('--json output is parseable', () => {
    const cwd = mkProject({ prd: true, arch: true });
    process.chdir(cwd);
    const code = nextCommand(['--json']);
    expect(code).toBe(0);
    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed.nextAgent).toBe('@po');
    expect(parsed.stage).toBe('planning');
    expect(parsed.state.stage).toBe('planning');
  });

  test('default output mentions the next agent', () => {
    const cwd = mkProject({});
    process.chdir(cwd);
    const code = nextCommand([]);
    expect(code).toBe(0);
    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('@analyst');
    expect(output).toContain('PRÓXIMO PASSO');
  });

  test('--explain draws the flow map', () => {
    const cwd = mkProject({ prd: true, arch: true });
    process.chdir(cwd);
    const code = nextCommand(['--explain']);
    expect(code).toBe(0);
    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Mapa do fluxo');
    expect(output).toContain('Desenvolvimento');
  });
});
