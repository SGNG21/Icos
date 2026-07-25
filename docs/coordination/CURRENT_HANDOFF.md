# ICOS — Current Handoff

**Lot actif :** D1 — Policy / Authorization
**Branch :** feat/d1-policy
**Worktree :** /Users/coco/icos/.claude/worktrees/feat+d1-policy
**HEAD :** e1010149dcf2e6d55979c08aed7a95bb79b63d5b (main)
**PR :** none yet

## État

PHASE 1 — INSPECTION en cours. Infrastructure authorization existante analysée. Spec D1 à formaliser.

## Ce qui existe déjà

- `src/core/authorization/decide.ts` — politique centrale (ALLOW / AWAITING_APPROVAL / REFUSED) basée sur `AuthorizationLevel` + `RiskLevel`
- `src/server/auth/authorization-service.ts` — vérification permissions + rôle depuis session
- `src/server/auth/guards.ts` — `requireSession`, `requireRole`, `requirePermission`
- `src/core/identity/permissions.ts` — matrice hiérarchique rôles→permissions
- `src/server/auth/cockpit-access.ts` — accès cockpit par rôle
- TenantContext résolu (COMPLIANCE-1)
- Classification C0-C3 sur Capabilities
- C3 retention gate (activation refusée sans retentionPolicyRef)

## Ce que D1 doit ajouter

(Contextual authority décidant ALLOW / DENY / REQUIRE_APPROVAL)

- Actor + Tenant + Role + Permission + Capability + Classification + Risque + Action + Resource
- Decision policy engine (port + implémentation)
- Policy definition contract
- Data classification gate (C2/C3 sensitive operations)
- Tenant IDOR gate
- Integration avec guards HTTP existants
- Tests d'intégration

## Prochaine action

Écrire la spec D1 formelle (PHASE 2), puis design review (PHASE 3).

## Bloqueurs

None.
