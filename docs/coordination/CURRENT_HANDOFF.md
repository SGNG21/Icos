# ICOS — Current Handoff

**Lot actif :** D2 — Durable Orchestration
**Branch :** feat/d2-orchestration
**Worktree :** /Users/coco/icos/.claude/worktrees/feat+d2-orchestration
**HEAD :** c8cebbec35677446c24ece7a66a79d86392e2cd4 (main)
**PR :** none yet

## État

PHASE 1 — INSPECTION à démarrer. Infrastructure existante à analyser.

## Ce qui existe déjà

- Container + repository pattern (memory + postgres)
- UoW transactionnelle (InMemory + Postgres)
- Skill lifecycle (hash, trust, activation, evaluation)
- Capability lifecycle (proposed → active → deprecated → retired)
- D1 Policy Engine (7 gates)
- Audit entries sur toutes les mutations
- TenantContext résolu

## Ce que D2 doit ajouter

- Mission lifecycle (définition + états)
- Plan / Steps / Runs
- State machine durable pour missions
- Repository mission-scoped
- Gestion des interruptions (restart, provider failure)
- États mission : WAITING_FOR_APPROVAL, BLOCKED_BY_POLICY, PROVIDER_UNAVAILABLE, etc.
- Persistence autoritaire (pas de contexte Claude comme source de vérité)

## Prochaine action

PHASE 1 — Inspection de l'existant (repositories, UoW, skill service).
PHASE 2 — Formal spec D2.

## Bloqueurs

None.
