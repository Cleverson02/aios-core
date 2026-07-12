/**
 * Tests for the Brain lexical search primitives.
 *
 * Story: WSB-1.2 - Brain Indexer
 */

const { tokenize, buildIndex, searchIndex } = require('../lexical-search');

describe('lexical-search — tokenize', () => {
  it('lowercases and splits on non-word boundaries', () => {
    expect(tokenize('Quality Gates, Pre-Push!')).toEqual(['quality', 'gates', 'pre', 'push']);
  });

  it('keeps accented Portuguese letters', () => {
    expect(tokenize('Índice léxico ção')).toEqual(['índice', 'léxico', 'ção']);
  });

  it('removes PT + EN stopwords and sub-minimal tokens', () => {
    // "the/of/o/de" are stopwords; single-char "a" is sub-minimal + stopword.
    expect(tokenize('the manual of a marca de campanha')).toEqual([
      'manual',
      'marca',
      'campanha',
    ]);
  });

  it('returns an empty array for empty / non-string input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe('lexical-search — buildIndex + searchIndex', () => {
  const chunks = [
    { id: 'a', heading: 'Quality Gates', text: 'run quality lint before push', file: 'ci.md', tier: 'projects', area: 'produto-x' },
    { id: 'b', heading: 'Deploy', text: 'we run quality checks and quality reports', file: 'deploy.md', tier: 'areas', area: 'devops' },
    { id: 'c', heading: 'Random', text: 'nothing relevant here', file: 'notes.md', tier: 'areas', area: 'marketing' },
  ];

  it('boosts a term appearing in the heading over body-only frequency', () => {
    const index = buildIndex(chunks);
    const results = searchIndex(index, 'quality');
    // Chunk 'a' has "quality" once in the body AND in the heading (x2 boost);
    // chunk 'b' has it twice in the body only. The heading boost must still
    // rank 'a' first despite 'b' having a higher raw body frequency.
    expect(results[0].chunkId).toBe('a');
    expect(results.map((r) => r.chunkId)).toContain('b');
  });

  it('normalises scores to the 0-1 range with a top of 1', () => {
    const index = buildIndex(chunks);
    const results = searchIndex(index, 'quality');
    expect(results[0].score).toBeCloseTo(1, 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('respects the limit option', () => {
    const index = buildIndex(chunks);
    const results = searchIndex(index, 'quality run', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('scopes results by area', () => {
    const index = buildIndex(chunks);
    const results = searchIndex(index, 'quality', { area: 'devops' });
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe('b');
  });

  it('scopes results by tier', () => {
    const index = buildIndex(chunks);
    const results = searchIndex(index, 'quality', { tier: 'projects' });
    expect(results.every((r) => r.chunkId === 'a')).toBe(true);
  });

  it('returns an empty array for stopword-only or unknown queries', () => {
    const index = buildIndex(chunks);
    expect(searchIndex(index, 'the of a')).toEqual([]);
    expect(searchIndex(index, 'nonexistentterm')).toEqual([]);
  });

  it('applies a file-name boost when the term appears in the file name', () => {
    const local = [
      { id: 'x', heading: 'Intro', text: 'deploy notes', file: 'deploy.md', tier: 'projects', area: 'p' },
      { id: 'y', heading: 'Intro', text: 'deploy notes', file: 'notes.md', tier: 'projects', area: 'p' },
    ];
    const index = buildIndex(local);
    const results = searchIndex(index, 'deploy');
    // 'x' additionally matches the file name → higher score.
    expect(results[0].chunkId).toBe('x');
  });
});
