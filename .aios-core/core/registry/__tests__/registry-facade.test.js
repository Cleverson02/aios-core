/**
 * Tests for RegistryFacade — unified search over the three AIOS registries.
 *
 * These run against the real registry data files shipped in this repo
 * (service-registry.json, entity-registry.yaml, workflow-patterns.yaml) so
 * they exercise the actual loaders, not mocks.
 *
 * @story WSB-0.3 - Registry Facade
 */

'use strict';

const path = require('path');
const RegistryFacade = require('../registry-facade');

// Repo root = four levels up from this test file
// (.aios-core/core/registry/__tests__ → repo root)
const REPO_ROOT = path.resolve(__dirname, '../../../../');

describe('RegistryFacade', () => {
  describe('construction', () => {
    it('defaults projectRoot to process.cwd()', () => {
      const facade = new RegistryFacade();
      expect(facade.projectRoot).toBe(process.cwd());
    });

    it('accepts an explicit projectRoot', () => {
      const facade = new RegistryFacade({ projectRoot: REPO_ROOT });
      expect(facade.projectRoot).toBe(REPO_ROOT);
    });
  });

  describe('getAvailableSources / warmup (real repo)', () => {
    it('reports no sources before any load', () => {
      const facade = new RegistryFacade({ projectRoot: REPO_ROOT });
      expect(facade.getAvailableSources()).toEqual([]);
    });

    it('reports all three sources available after warmup', async () => {
      const facade = new RegistryFacade({ projectRoot: REPO_ROOT });
      const sources = await facade.warmup();
      expect(sources).toEqual(
        expect.arrayContaining(['services', 'entities', 'workflows']),
      );
      expect(facade.getAvailableSources().sort()).toEqual([
        'entities',
        'services',
        'workflows',
      ]);
    });
  });

  describe('search (unified, real registries)', () => {
    let facade;

    beforeAll(() => {
      facade = new RegistryFacade({ projectRoot: REPO_ROOT });
    });

    it('returns results in the unified shape', async () => {
      const results = await facade.search('registry', { limit: 10 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      for (const entry of results) {
        expect(entry).toEqual(
          expect.objectContaining({
            source: expect.any(String),
            id: expect.any(String),
            type: expect.any(String),
            title: expect.any(String),
            score: expect.any(Number),
            ref: expect.any(Object),
          }),
        );
        expect(['services', 'entities', 'workflows']).toContain(entry.source);
        expect(entry.score).toBeGreaterThan(0);
      }
    });

    it('orders results by descending score', async () => {
      const results = await facade.search('story', { limit: 15 });
      expect(results.length).toBeGreaterThan(1);
      for (let i = 1; i < results.length; i += 1) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('respects the limit option', async () => {
      const results = await facade.search('registry', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('surfaces results from multiple sources for a broad query', async () => {
      const results = await facade.search('develop', { limit: 30 });
      const sources = new Set(results.map((r) => r.source));
      expect(sources.size).toBeGreaterThanOrEqual(2);
    });

    it('returns service results and exposes the original ref', async () => {
      const results = await facade.search('supabase', {
        sources: ['services'],
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === 'services')).toBe(true);
      // ref is the original worker object
      expect(results[0].ref).toHaveProperty('id', results[0].id);
    });

    it('returns entity results with the original entity as ref', async () => {
      const results = await facade.search('registry', {
        sources: ['entities'],
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === 'entities')).toBe(true);
      expect(results[0].ref).toHaveProperty('id', results[0].id);
      expect(results[0].ref).toHaveProperty('path');
    });

    it('returns workflow results with the original workflow as ref', async () => {
      const results = await facade.search('story', {
        sources: ['workflows'],
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === 'workflows')).toBe(true);
      expect(results[0].type).toBe('workflow');
    });

    it('ignores unknown source names', async () => {
      const results = await facade.search('registry', {
        sources: ['entities', 'bogus'],
        limit: 5,
      });
      expect(results.every((r) => r.source === 'entities')).toBe(true);
    });

    it('returns an empty array for a non-matching query', async () => {
      const results = await facade.search('zzzznotarealtermxyz', { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe('convenience getters (real repo)', () => {
    let facade;

    beforeAll(() => {
      facade = new RegistryFacade({ projectRoot: REPO_ROOT });
    });

    it('getService returns a worker by id or null', async () => {
      const [hit] = await facade.search('supabase', {
        sources: ['services'],
        limit: 1,
      });
      const service = await facade.getService(hit.id);
      expect(service).not.toBeNull();
      expect(service.id).toBe(hit.id);

      expect(await facade.getService('__no_such_service__')).toBeNull();
      expect(await facade.getService()).toBeNull();
    });

    it('getEntity returns an entity by id or null', async () => {
      const [hit] = await facade.search('registry', {
        sources: ['entities'],
        limit: 1,
      });
      const entity = await facade.getEntity(hit.id);
      expect(entity).not.toBeNull();
      expect(entity.id).toBe(hit.id);

      expect(await facade.getEntity('__no_such_entity__')).toBeNull();
      expect(await facade.getEntity()).toBeNull();
    });

    it('getWorkflow returns a workflow by name or null', async () => {
      const workflow = await facade.getWorkflow('story_development');
      expect(workflow).not.toBeNull();
      expect(workflow).toHaveProperty('description');

      expect(await facade.getWorkflow('__no_such_workflow__')).toBeNull();
      expect(await facade.getWorkflow()).toBeNull();
    });
  });

  describe('graceful degradation (nonexistent projectRoot)', () => {
    let facade;

    beforeAll(() => {
      facade = new RegistryFacade({
        projectRoot: path.join('/nonexistent', 'aios-root-xyz'),
      });
    });

    it('search does not throw and returns an empty array', async () => {
      await expect(facade.search('registry')).resolves.toEqual([]);
    });

    it('reports no available sources', async () => {
      await facade.warmup();
      expect(facade.getAvailableSources()).toEqual([]);
    });

    it('convenience getters return null instead of throwing', async () => {
      expect(await facade.getService('anything')).toBeNull();
      expect(await facade.getEntity('anything')).toBeNull();
      expect(await facade.getWorkflow('anything')).toBeNull();
    });
  });
});
