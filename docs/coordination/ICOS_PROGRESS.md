# ICOS — Progress

> **Statut du document : état opérationnel des lots.**
>
> Mis à jour automatiquement à chaque fin de lot, checkpoint ou handoff.
> Ne contient pas la vision produit (voir ICOS_MASTER_PLAN.md).

---

## Lots

| Lot                             | Status          | PR      | Merge SHA   | Branch                           | Notes             |
| ------------------------------- | --------------- | ------- | ----------- | -------------------------------- | ----------------- |
| 1A — Socle métier               | DONE            | —       | a6fd58e     | —                                |                   |
| 1B — API interne simulée        | DONE            | —       | 90e39f1     | —                                |                   |
| 2A-1 — Persistence foundation   | DONE            | —       | 00376f1     | —                                |                   |
| 2B-1a — Identity                | DONE            | —       | 724735d     | —                                |                   |
| 2B-1b — Authentication          | DONE            | —       | 3a9f206     | —                                |                   |
| 2B-2 — Admin / Human-Agent      | DONE            | —       | —           | —                                |                   |
| COMPLIANCE-0                    | DONE            | —       | f5470d6     | —                                |                   |
| C1 — Capability Registry        | DONE            | —       | —           | —                                |                   |
| C2 — Skill Registry & Trust     | DONE            | #13     | —           | —                                |                   |
| **COMPLIANCE-1**                | **DONE**        | **#14** | **e101014** | feat/compliance-1-classification | Merged 2026-07-25 |
| **D1 — Policy / Authorization** | **IN PROGRESS** | —       | —           | feat/d1-policy                   | En cours          |

---

## Current Lot

**D1 — Policy / Authorization**

Branch: `feat/d1-policy`
Worktree: `/Users/coco/icos/.claude/worktrees/feat+d1-policy`
Base SHA: `e1010149dcf2e6d55979c08aed7a95bb79b63d5b`

### Dependencies

- 2B-1a/b (Identity + Auth) ✅
- COMPLIANCE-0 (Classification taxonomy) ✅
- COMPLIANCE-1 (TenantContext, C0-C3 on Capabilities) ✅
- C1 (Capability Registry) ✅
- C2 (Skill Registry) ✅

### Blockers

- None

---

## Next Lot

After D1:
D2 — Durable Orchestration

---

## Current main SHA

`e1010149dcf2e6d55979c08aed7a95bb79b63d5b`
