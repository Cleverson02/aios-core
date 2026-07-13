/**
 * Tests for the Brain Session Digest (WSB-1.6).
 *
 * All fixtures live under the OS temp dir with an isolated brainDir — nothing
 * ever touches ~/.aiox or the real repo's docs/digests/. Git fixtures are real
 * repositories built with `git init` + a couple of commits via execFileSync.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const yaml = require('js-yaml');

const { generateDigest } = require('../digest');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FIXTURE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Create a fresh temp workspace and return its paths.
 * @returns {{root: string, brainDir: string}}
 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-digest-'));
  const brainDir = path.join(root, '.brain-store');
  return { root, brainDir };
}

/** Recursively remove a workspace. */
function cleanup(ws) {
  fs.rmSync(ws.root, { recursive: true, force: true });
}

/**
 * Run git in a workspace (throws on failure — used only for fixture setup).
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Turn a workspace into a real git repo with a few commits.
 * @param {string} cwd
 */
function initGitRepo(cwd) {
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'dex@aios.test']);
  git(cwd, ['config', 'user.name', 'Dex Builder']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(path.join(cwd, 'alpha.md'), '# Alpha\n\nprimeiro arquivo.\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'feat: adiciona alpha']);

  fs.writeFileSync(path.join(cwd, 'beta.md'), '# Beta\n\nsegundo arquivo.\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'feat: adiciona beta']);

  fs.writeFileSync(path.join(cwd, 'alpha.md'), '# Alpha\n\nprimeiro arquivo editado.\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'fix: ajusta alpha']);
}

/** Build a generateDigest option bag pinned to the isolated brainDir. */
function opts(ws, extra = {}) {
  return { cwd: ws.root, brainDir: ws.brainDir, ...extra };
}

/** Split a digest string into { front, body }. */
function splitFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { front: null, body: content };
  return { front: yaml.load(match[1]), body: match[2] };
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              GIT COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════════

describe('generateDigest — git collection', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace();
    initGitRepo(ws.root);
  });
  afterEach(() => cleanup(ws));

  it('writes a digest file with commit + file sections', async () => {
    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6', agent: 'dev' }));

    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toContain(path.join('docs', 'digests'));

    expect(result.sections.commits).toBeGreaterThan(0);
    expect(result.sections.files).toBeGreaterThan(0);

    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toContain('## Commits');
    expect(content).toContain('## Arquivos alterados');
    expect(content).toContain('feat: adiciona alpha');
    expect(content).toContain('alpha.md');
  });

  it('includes uncommitted changes among the changed files', async () => {
    fs.writeFileSync(path.join(ws.root, 'gamma.md'), '# Gamma\n\nnão commitado.\n');

    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toContain('gamma.md');
  });

  it('creates docs/digests/ when it does not exist', async () => {
    expect(fs.existsSync(path.join(ws.root, 'docs', 'digests'))).toBe(false);
    await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    expect(fs.existsSync(path.join(ws.root, 'docs', 'digests'))).toBe(true);
  });

  it('re-indexes after writing (indexed=true)', async () => {
    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    expect(result.indexed).toBe(true);
    expect(fs.existsSync(path.join(ws.brainDir, 'index.json'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              GRACEFUL DEGRADATION — NO GIT (AC4)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('generateDigest — no git (AC4)', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(() => cleanup(ws));

  it('generates a digest without git sections and never throws', async () => {
    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6', summary: 'Sessão sem git.' }));

    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.sections.commits).toBe(0);
    expect(result.sections.files).toBe(0);

    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).not.toContain('## Commits');
    expect(content).not.toContain('## Arquivos alterados');
    expect(content).toContain('## Resumo');
    expect(content).toContain('Sessão sem git.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              IDEMPOTENCY (AC6)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('generateDigest — daily idempotency (AC6)', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace();
    initGitRepo(ws.root);
  });
  afterEach(() => cleanup(ws));

  it('suffixes -2 on the second digest of the same day/slug, never overwriting', async () => {
    const first = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    const second = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));

    expect(second.path).not.toBe(first.path);
    expect(second.path).toMatch(/-2\.md$/);
    expect(fs.existsSync(first.path)).toBe(true);
    expect(fs.existsSync(second.path)).toBe(true);

    const third = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    expect(third.path).toMatch(/-3\.md$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DRY RUN
// ═══════════════════════════════════════════════════════════════════════════════════

describe('generateDigest — dry run', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace();
    initGitRepo(ws.root);
  });
  afterEach(() => cleanup(ws));

  it('returns content + path without writing or indexing', async () => {
    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6', dryRun: true }));

    expect(result.content).toContain('## Resumo');
    expect(result.indexed).toBe(false);
    expect(fs.existsSync(result.path)).toBe(false);
    expect(fs.existsSync(path.join(ws.root, 'docs', 'digests'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              DECISIONS (SessionMemory)
// ═══════════════════════════════════════════════════════════════════════════════════

describe('generateDigest — decisions', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace();
    initGitRepo(ws.root);
  });
  afterEach(() => cleanup(ws));

  it('includes a Decisões section from .aios/session-memory.json', async () => {
    const aiosDir = path.join(ws.root, '.aios');
    fs.mkdirSync(aiosDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiosDir, 'session-memory.json'),
      JSON.stringify([
        {
          decision: 'Usar execFile para git',
          reason: 'evita injeção de shell',
          timestamp: new Date().toISOString(),
        },
      ]),
    );

    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    expect(result.sections.decisions).toBeGreaterThan(0);

    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toContain('## Decisões');
    expect(content).toContain('Usar execFile para git');
    expect(content).toContain('evita injeção de shell');
  });

  it('complements decisions with recent .ai/*.md titles', async () => {
    const aiDir = path.join(ws.root, '.ai');
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiDir, 'decision-log-wsb-1-6.md'),
      '# Decisão sobre digests compartilhados\n\nDetalhes.\n',
    );

    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toContain('Decisão sobre digests compartilhados');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
//                              FRONT-MATTER + ENTITIES
// ═══════════════════════════════════════════════════════════════════════════════════

describe('generateDigest — front-matter + entities', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace();
    initGitRepo(ws.root);
  });
  afterEach(() => cleanup(ws));

  it('produces valid YAML front-matter (parseable by js-yaml)', async () => {
    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6', agent: 'dev' }));
    const content = fs.readFileSync(result.path, 'utf8');

    const { front } = splitFrontMatter(content);
    expect(front).toBeTruthy();
    expect(front.story).toBe('WSB-1.6');
    expect(front.agent).toBe('dev');
    expect(typeof front.date).toBe('string');
    expect(front.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('detects entities mentioned in the digest and lists them in front-matter', async () => {
    // Seed an entities.json in the isolated brainDir.
    fs.mkdirSync(ws.brainDir, { recursive: true });
    fs.writeFileSync(
      path.join(ws.brainDir, 'entities.json'),
      JSON.stringify({
        version: 1,
        entities: {
          acme: {
            id: 'acme',
            name: 'Acme',
            type: 'client',
            aliases: ['Acme Corp'],
            description: '',
            sources: [],
            relations: [],
            origin: 'manual',
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    // A decision that mentions the entity so it appears in the body text.
    const aiosDir = path.join(ws.root, '.aios');
    fs.mkdirSync(aiosDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiosDir, 'session-memory.json'),
      JSON.stringify([
        { decision: 'Entregar dashboard para Acme', reason: null, timestamp: new Date().toISOString() },
      ]),
    );

    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    const content = fs.readFileSync(result.path, 'utf8');
    const { front } = splitFrontMatter(content);

    expect(Array.isArray(front.entities)).toBe(true);
    expect(front.entities).toContain('Acme');
  });

  it('omits the entities key when nothing is detected', async () => {
    const result = await generateDigest(opts(ws, { storyId: 'WSB-1.6' }));
    const content = fs.readFileSync(result.path, 'utf8');
    const { front } = splitFrontMatter(content);
    expect(front.entities).toBeUndefined();
  });
});
