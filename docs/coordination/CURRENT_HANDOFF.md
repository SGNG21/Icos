# ICOS — Current Handoff

**Lot actif :** Supervisor / Worker Build (SUP-0 → SUP-7)
**Branch :** feat/supervisor-worker
**Worktree :** /Users/coco/icos-supervisor
**HEAD :** `7c2109c` (SUP-2)

## État

Supervisor en cours de construction. Phases SUP-0 (design), SUP-1 (Task DAG + Scheduler), et SUP-2 (Worker Manager) terminées et commitées. Transition vers SUP-3 (Worktree Manager).

## Phases réalisées

| Phase | Statut        | Commit  | Description                                                    |
| ----- | ------------- | ------- | -------------------------------------------------------------- |
| SUP-0 | ✅ DONE       | 392e7c5 | Architecture design, EXISTS/EXTEND/CREATE/DEFER/DISCARD matrix |
| SUP-1 | ✅ DONE       | 4eee1aa | Task DAG + Scheduler (cycle detection, ready-node, topo sort)  |
| SUP-2 | ✅ DONE       | 7c2109c | Local Worker Manager (WorkerSpec, concurrency, D4 integration) |
| SUP-3 | ▶ IN PROGRESS | —       | Worktree / Git Manager                                         |
| SUP-4 | ⏳ NEXT       | —       | Review / Correction Loop                                       |
| SUP-5 | ⏳            | —       | Integration + Global Gates                                     |
| SUP-6 | ⏳            | —       | Preview Delivery                                               |
| SUP-7 | ⏳            | —       | Self-development milestone                                     |

## Infrastructure intégrée

- **D1** — Policy / Authorization (src/core/policy/ + src/server/policy/)
- **D2** — Mission Engine (src/core/mission/ + src/server/mission/)
- **D3** — AI Gateway / OmniRoute (src/server/ai/)
- **D4** — Runtime Execution (src/server/runtime/)
- **G1** — Tool Gateway (src/core/g1/ + src/server/g1/)

## Nouveaux modules créés par le Supervisor

- **src/core/supervisor/** — Task DAG, TaskNode, lifecycle, Scheduler
- **src/server/supervisor/** — SupervisorRepository, ports, InMemory impl.
- **src/core/worker/** — WorkerSpec, WorkerResult, lifecycle
- **src/server/worker/** — WorkerManager, PromiseSemaphore, D4 integration

## Tests

1044 tests pass (66 test files).

## Prochaine action

Implémenter SUP-3 — Worktree / Git Manager pour l'isolation des workspaces Git.

## Bloqueurs

None.
