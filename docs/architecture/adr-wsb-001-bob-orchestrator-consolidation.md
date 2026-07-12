# ADR-WSB-001: BobOrchestrator as the Consolidated Orchestration Generation

**ID:** ADR-WSB-001
**Status:** Accepted
**Created:** 2026-07-12
**Author:** Dex (@dev) + Aria (@architect)
**Story:** WSB-0.1
**Epic:** AIOX Cortex — Workspace Brain (WSB), Fase 0 — Consolidação
**Deciders:** Aria (@architect), Dex (@dev)

---

## Context

The `.aios-core/core/orchestration/` module accumulated **three overlapping
orchestrator generations** over the project's history, each introduced by a
different epic and each still present in the barrel export:

1. **WorkflowOrchestrator** (`workflow-orchestrator.js`) — 1st generation.
   YAML-driven multi-agent workflow runner with pre-flight tech-stack detection
   and skill dispatch.
2. **MasterOrchestrator** (`master-orchestrator.js`) — 2nd generation (Epic 0,
   ADE / Autonomous Development Engine). Coordinates Epics 3→4→5→6 in a unified
   pipeline with a state machine, recovery handler and gate evaluator.
3. **BobOrchestrator** (`bob-orchestrator.js`) — 3rd generation (Epic 11/12,
   "Projeto Bob"). A decision-tree router (not a God Class) that detects project
   state and routes to greenfield/brownfield handlers, integrating the Epic 11
   modules (executor assignment, terminal spawner, workflow executor, surface
   checker, session state).

The incoming AIOX Cortex (Workspace Brain) modules — **Router, Autonomy,
Gateway** — need a single, stable orchestration entry point. Coupling them to
any specific historical generation would re-entrench the fragmentation this epic
aims to resolve.

---

## Decision

**BobOrchestrator is the generation-target.** A new facade
`core/orchestration/entrypoint.js` exposes:

- `getOrchestrator(options)` — returns the consolidated `BobOrchestrator`
  instance by default; requesting a legacy generation via `options.generation`
  ('workflow' | 'master') emits a `DeprecationWarning` and returns that legacy
  instance for backward compatibility only.
- `ORCHESTRATOR_GENERATIONS` — a frozen catalog documenting all three
  generations with `name`, `module`, `status` and `since`.

The two legacy entrypoints (`MasterOrchestrator`, `WorkflowOrchestrator`)
receive `@deprecated` JSDoc pointing at the entrypoint, **with no behavioral
change** in this increment.

### Rationale for choosing Bob

- It is the most recent and actively-developed generation.
- It is explicitly designed as a thin router ("Router, not God Class",
  PRD §3.7), making it the right seam for new Cortex modules to attach to.
- It already composes the earlier building blocks (workflow execution, tech
  detection) rather than duplicating them.

---

## Consequences

**Positive:**
- New Cortex modules depend only on `getOrchestrator()`, insulated from
  generation churn.
- Legacy consumers keep working unchanged; deprecation is signaled, not enforced.
- The generation catalog makes the consolidation state explicit and testable.

**Negative / trade-offs:**
- Three implementations still coexist during Fase 0 (removed only in a future
  major release — Incremento 2).
- The facade adds one indirection layer over direct instantiation.

**Follow-up (Incremento 2, future):**
- Migrate internal consumers to `getOrchestrator()`.
- Remove the duplicated legacy paths in a major release.

---

## Related

- Facade: `.aios-core/core/orchestration/entrypoint.js`
- Barrel: `.aios-core/core/orchestration/index.js`
- Story: `docs/stories/epics/epic-aios-workspace-brain/story-wsb-0.1-orchestration-entrypoint.md`
