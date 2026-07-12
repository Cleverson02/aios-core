/**
 * Tests for the consolidated orchestration entrypoint (Story WSB-0.1).
 *
 * BobOrchestrator (and the legacy generations) pull in heavy dependencies, so
 * they are mocked here — the facade's contract, not their internals, is under test.
 */

'use strict';

// Lightweight mock for the consolidated (Bob) generation.
jest.mock('../bob-orchestrator', () => {
  class BobOrchestrator {
    constructor(projectRoot, options) {
      this.projectRoot = projectRoot;
      this.options = options;
    }
  }
  return { BobOrchestrator, ProjectState: {} };
});

// Lightweight mocks for the deprecated generations.
jest.mock('../master-orchestrator', () => {
  class MasterOrchestrator {
    constructor(projectRoot, options) {
      this.projectRoot = projectRoot;
      this.options = options;
    }
  }
  return MasterOrchestrator;
});

jest.mock('../workflow-orchestrator', () => {
  class WorkflowOrchestrator {
    constructor(workflowPath, options) {
      this.workflowPath = workflowPath;
      this.options = options;
    }
  }
  return WorkflowOrchestrator;
});

const { getOrchestrator, ORCHESTRATOR_GENERATIONS } = require('../entrypoint');
const { BobOrchestrator } = require('../bob-orchestrator');
const MasterOrchestrator = require('../master-orchestrator');
const WorkflowOrchestrator = require('../workflow-orchestrator');

describe('orchestration entrypoint (WSB-0.1)', () => {
  describe('getOrchestrator()', () => {
    it('returns a BobOrchestrator instance by default', () => {
      const orch = getOrchestrator();
      expect(orch).toBeInstanceOf(BobOrchestrator);
    });

    it('returns a BobOrchestrator instance when generation is "bob"', () => {
      const orch = getOrchestrator({ generation: 'bob' });
      expect(orch).toBeInstanceOf(BobOrchestrator);
    });

    it('passes projectRoot through to BobOrchestrator', () => {
      const orch = getOrchestrator({ projectRoot: '/tmp/my-project' });
      expect(orch.projectRoot).toBe('/tmp/my-project');
    });

    it('defaults projectRoot to process.cwd() when not provided', () => {
      const orch = getOrchestrator();
      expect(orch.projectRoot).toBe(process.cwd());
    });
  });

  describe('deprecation warnings', () => {
    let emitSpy;

    beforeEach(() => {
      emitSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    });

    afterEach(() => {
      emitSpy.mockRestore();
    });

    it('emits a deprecation warning for generation "master" and returns that generation', () => {
      const orch = getOrchestrator({ generation: 'master' });
      expect(orch).toBeInstanceOf(MasterOrchestrator);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = emitSpy.mock.calls[0];
      expect(message).toMatch(/deprecated/i);
      expect(meta).toMatchObject({ type: 'DeprecationWarning' });
    });

    it('emits a deprecation warning for generation "workflow" and returns that generation', () => {
      const orch = getOrchestrator({ generation: 'workflow' });
      expect(orch).toBeInstanceOf(WorkflowOrchestrator);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = emitSpy.mock.calls[0];
      expect(message).toMatch(/deprecated/i);
      expect(meta).toMatchObject({ type: 'DeprecationWarning' });
    });

    it('does NOT emit a warning for the default (Bob) generation', () => {
      getOrchestrator();
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe('ORCHESTRATOR_GENERATIONS', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(ORCHESTRATOR_GENERATIONS)).toBe(true);
    });

    it('has exactly 3 entries (WORKFLOW, MASTER, BOB)', () => {
      expect(Object.keys(ORCHESTRATOR_GENERATIONS)).toEqual(['WORKFLOW', 'MASTER', 'BOB']);
    });

    it('marks only BOB as active; WORKFLOW and MASTER as deprecated', () => {
      expect(ORCHESTRATOR_GENERATIONS.BOB.status).toBe('active');
      expect(ORCHESTRATOR_GENERATIONS.WORKFLOW.status).toBe('deprecated');
      expect(ORCHESTRATOR_GENERATIONS.MASTER.status).toBe('deprecated');
    });

    it('documents name, module and since for every generation', () => {
      for (const gen of Object.values(ORCHESTRATOR_GENERATIONS)) {
        expect(gen).toHaveProperty('name');
        expect(gen).toHaveProperty('module');
        expect(gen).toHaveProperty('since');
      }
    });

    it('cannot be mutated (frozen entries)', () => {
      'use strict';
      expect(() => {
        ORCHESTRATOR_GENERATIONS.BOB.status = 'deprecated';
      }).toThrow();
    });
  });
});
