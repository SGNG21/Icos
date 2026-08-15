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
| **D1 — Policy / Authorization** | **DONE** | **#15** | **c8cebbe** | feat/d1-policy | Merged 2026-07-25 |
| **D2 — Durable Orchestration** | **DONE** | **#16** | **8cd58c7** | feat/d2-orchestration | Merged 2026-07-25 |
| **D3 — AI Gateway / OmniRoute** | **PENDING** | — | — | — | Nouvelle session requise |

---

## Current Lot

**D3 — AI Gateway / OmniRoute**

Branch: `feat/d3-omniroute` (à créer)
Worktree: à créer dans nouvelle session
Base SHA: `8cd58c70d5d174f1a071942ec4eb028c73c41a0e`

### Dependencies
- D2 (Mission Engine) ✅
- D1 (Policy Engine) ✅
- COMPLIANCE-1 (TenantContext) ✅

### Blockers
- None

---

## Next Lot

After D3:
D4 — Runtime / Agent Execution

---

## Current main SHA

`8cd58c70d5d174f1a071942ec4eb028c73c41a0e`
