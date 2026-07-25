# ICOS — Progress

> **Statut du document : état opérationnel des lots.**
>
> Mis à jour automatiquement à chaque fin de lot, checkpoint ou handoff.
> Ne contient pas la vision produit (voir ICOS_MASTER_PLAN.md).

---

## Lots

| Lot | Status | PR | Merge SHA | Branch | Notes |
|-----|--------|----|-----------|--------|-------|
| 1A — Socle métier | DONE | — | a6fd58e | — | |
| 1B — API interne simulée | DONE | — | 90e39f1 | — | |
| 2A-1 — Persistence foundation | DONE | — | 00376f1 | — | |
| 2B-1a — Identity | DONE | — | 724735d | — | |
| 2B-1b — Authentication | DONE | — | 3a9f206 | — | |
| 2B-2 — Admin / Human-Agent | DONE | — | — | — | |
| COMPLIANCE-0 | DONE | — | f5470d6 | — | |
| C1 — Capability Registry | DONE | — | — | — | |
| C2 — Skill Registry & Trust | DONE | #13 | — | — | |
| **COMPLIANCE-1** | **DONE** | **#14** | **e101014** | feat/compliance-1-classification | Merged 2026-07-25 |
| **D1 — Policy / Authorization** | **DONE** | #15 | **c8cebbe** | feat/d1-policy | Merged 2026-07-25 |
| **D2 — Durable Orchestration** | **IN PROGRESS** | — | — | feat/d2-orchestration | En cours |

---

## Current Lot

**D2 — Durable Orchestration**

Branch: `feat/d2-orchestration`
Worktree: `/Users/coco/icos/.claude/worktrees/feat+d2-orchestration`
Base SHA: `c8cebbec35677446c24ece7a66a79d86392e2cd4`

### Dependencies
- 2B-1a/b (Identity + Auth) ✅
- COMPLIANCE-0 ✅
- COMPLIANCE-1 (TenantContext) ✅
- C1 (Capability Registry) ✅
- C2 (Skill Registry) ✅
- D1 (Policy Engine) ✅

### Blockers
- None

---

## Next Lot

After D1:
D2 — Durable Orchestration

---

## Current main SHA

`c8cebbec35677446c24ece7a66a79d86392e2cd4`
