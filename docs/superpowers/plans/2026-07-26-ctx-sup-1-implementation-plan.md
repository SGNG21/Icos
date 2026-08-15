# CTX-SUP-1 — Implementation Plan (Context ↔ Supervisor Bridge)

> **Plan v1** — 2026-07-26
> Spec associée : `docs/superpowers/specs/2026-07-26-ctx-sup-1-context-supervisor-bridge-design.md`
> Branche : `feat/ctx-sup-1`
> Contraintes dures : ne pas modifier `feat/supervisor-worker` ; ne pas
> intégrer au Supervisor ; ne pas reprendre SUP-7 ; ne pas affaiblir
> D1/D2/D3/D4/G1 ; pas de MCP/tools ; pas de Voice V1 ; pas de merge ; pas de
> deploy.

---

## Découpage en sous-lots

| Sous-lot | Contenu                                                                        | Câble le Supervisor ?               | Statut     |
| -------- | ------------------------------------------------------------------------------ | ----------------------------------- | ---------- |
| **1A**   | Contrats purs `core` + tests (aucune persistance, aucun câblage)               | Non                                 | **Ce lot** |
| 1B       | Ports + persistance (in-memory + PostgreSQL) + versioning + migration additive | Non                                 | Ultérieur  |
| 1C       | Adaptateur d'entrée `SupervisorContextInput` + mapping                         | Non (fige la forme, ne branche pas) | Ultérieur  |

> L'intégration réelle au Supervisor vivant reste **hors** de CTX-SUP et exige
> une autorisation humaine explicite + un lot dédié.

---

## Sous-lot 1A — Contrats purs `core` (ce lot)

### Emplacement

```
src/core/context/
├── contract.ts        # ConversationContext, MissionContext, ContextClaim,
│                      # ContextProvenance, Epistemics (Zod, source de vérité)
├── build.ts           # buildMissionContext() — pure, déterministe, fail-closed
├── index.ts           # ré-exports
├── contract.test.ts   # validation de forme + invariants "no authority"
└── build.test.ts      # RED→GREEN : objectif confirmé, faits vs hypothèses,
                        # questions ouvertes, fail-closed, déterminisme, tenant
```

Conforme `icos-architecture` : `core` pur, aucun I/O, Zod = source unique de
vérité, aucune dépendance vers `next`/Drizzle/réseau.

### Contrats (résumé — détail dans la spec §3–§4)

- `contextSourceKindSchema` : `user_message | agent_message | mission_record | memory_reference`
- `epistemicsSchema` : `confirmed_fact | assumption | open_question`
- `contextProvenanceSchema` : `{ source, ref, observedAt }`
- `contextClaimSchema` : `{ id, statement (borné), epistemics, provenance }`
- `conversationTurnSchema` : `{ id, role, text (borné), observedAt }`
- `conversationContextSchema` : `{ tenantId, turns[], memoryReferences[] }` (entrée)
- `missionContextSchema` : voir spec §3 (sortie bornée, immuable, versionnée)
- Bornes : longueurs de chaîne max, nombre max de claims/turns → `over_budget`.

### Fonction pure

```typescript
buildMissionContext(input: {
  conversation: ConversationContext;
  mission: Mission;              // fournie, jamais fabriquée (D2 = vérité)
  builtByLabel: string;
  now: string;                   // injecté → déterminisme testable
}): BuildContextResult
```

`BuildContextResult = { ok: true; context } | { ok: false; reason }` avec
`reason ∈ { no_confirmed_objective, tenant_mismatch, mission_conflict,
unresolved_ambiguity, over_budget, non_serializable_input }`.

### Tests 1A (TDD — RED d'abord)

**Forme / contrat (`contract.test.ts`)**

1. `missionContextSchema` accepte un contexte valide minimal.
2. Rejette tout champ inconnu ressemblant à de l'autorité (`grant`, `token`,
   `approved`, `credential`) — le schéma est strict.
3. Bornes : `statement`/`boundedSummary` au-delà de la limite → rejet.
4. `memoryReferences` n'accepte que `source = "memory_reference"`.

**Build (`build.test.ts`)** 5. Objectif confirmé présent → `ok:true`, `confirmedObjective` = valeur confirmée. 6. Aucun objectif confirmé → `ok:false, reason: "no_confirmed_objective"`. 7. Tour non confirmé → classé `assumption`, jamais `confirmed_fact`. 8. Question ouverte → présente dans `openQuestions`. 9. `conversation.tenantId ≠ mission.tenantId` → `tenant_mismatch`. 10. Conversation contredisant la Mission (ex. objectif ≠ `userRequest` de façon
incompatible marquée) → `mission_conflict`. 11. Dépassement de bornes → `over_budget`. 12. **Déterminisme** : mêmes entrées + même `now` → sortie identique. 13. **Propriété "no authority"** : pour toute entrée acceptée, la sortie
sérialisée ne contient aucune clé d'autorité ni aucun secret
(`grant|token|credential|password|cookie|allow`). 14. Entrée non sérialisable / suspecte → `non_serializable_input`.

### Critères d'acceptation 1A

- `pnpm test` : nouveaux tests verts, aucune régression.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` : OK.
- `git diff --check` : propre.
- Aucune modification hors `src/core/context/**` et `docs/**`.
- Aucun import de `src/core/context` depuis le reste du code (isolé, non câblé).
- Aucune modification de D1/D2/D3/D4/G1, du container, du Supervisor.

---

## Sous-lot 1B — Persistance / versioning (ultérieur)

- Port `MissionContextRepository` (`save`, `findLatest`, `findVersion`) —
  signatures asynchrones, ressource absente = `null`.
- Impl in-memory (tests Docker-free) + impl PostgreSQL (Drizzle).
- Migration **additive** : table `mission_contexts` clé `(tenant_id, mission_id,
version)`, colonnes bornées, JSON sérialisable, aucun secret.
- Versioning monotone mission-scopé ; artefact immuable (append).
- Émission optionnelle d'`AuditEntry` par référence (pas de nouveau type
  d'événement ; `contextId/version/missionId` uniquement).
- Câblage container : point unique (`server/container.ts`) — sans toucher au
  Supervisor.
- Tests : isolation tenant (T5), immutabilité, version-safety, « no secret
  persisted » (T10), intégration PostgreSQL en `pnpm test:integration`.

## Sous-lot 1C — Adaptateur d'entrée Supervisor (ultérieur)

- `SupervisorContextInput` (spec §5) + `toSupervisorContextInput(MissionContext)`
  pur.
- Test : le DTO ne contient aucun champ autoritaire ; mapping déterministe.
- **Ne branche pas** le Supervisor vivant.

---

## Journal des menaces couvertes par sous-lot

| Menace                         | 1A                          | 1B                          | 1C                       |
| ------------------------------ | --------------------------- | --------------------------- | ------------------------ |
| T1 prompt injection            | ✅ (no authority)           |                             |                          |
| T2 vieux contexte = permission | ✅ (version/builtAt)        | ✅ (persistance versionnée) |                          |
| T3 « merge main »              | ✅ (assumption)             |                             |                          |
| T4 mémoire malveillante        | ✅ (memory_reference)       |                             |                          |
| T5 cross-tenant                | ✅ (tenant_mismatch)        | ✅ (filtre repo)            |                          |
| T6 stale                       | ✅ (snapshot)               | ✅ (version)                |                          |
| T7 conflit Mission             | ✅ (mission_conflict)       |                             |                          |
| T8 conflit D1/G1               | ✅ (aucune décision portée) |                             | ✅ (DTO non autoritaire) |
| T9 Supervisor = permission     |                             |                             | ✅ (DTO + règles §5)     |
| T10 secret persisté            | ✅ (jsonValue + test)       | ✅ (test persistance)       |                          |

---

## Human gates

1. Validation humaine du design + plan avant 1A commit.
2. Git gate : commit CTX-SUP-1A uniquement, après contrôles verts.
3. 1B/1C : lots séparés, chacun re-validé ; aucune intégration Supervisor sans
   autorisation explicite dédiée.
