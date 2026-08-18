# SKILLSMP HANDOFF

Statut : WIP préservé (commit de sauvegarde, pas de livraison).
Branche : `feat/skill-registry-trust-lifecycle`.
Workstream : **SkillsMP** — distinct de M2 Durable Execution et de Repository Registry.

## Principe fondamental

**Capability != Skill.**

Une capacité ICOS est une classification interne, autoritaire, gouvernée. Une skill externe
n'est qu'un *candidat* : son nom, sa description et ses tags ne sont **pas** des preuves de
capacité. Aucune claim de capacité n'est créée sans preuve explicite (manifest, code, doc,
test, exemple).

## Rôle de SkillsMP

SkillsMP est une **source externe de découverte et de signal de confiance**, jamais une
autorité. SkillsMP n'est **pas** un runtime d'exécution de skills.

ICOS reste autoritaire pour : classification, trust, compatibilité, sécurité, activation,
exécution, audit.

Interdits structurels, y compris pour les évolutions futures :
- aucune activation implicite
- aucun download implicite
- aucune installation implicite
- aucune exécution implicite
- aucun side effect externe pendant la phase de discovery

Le pipeline de confiance cible reste :

```
DISCOVER → NORMALIZE → DEDUPLICATE → INSPECT SOURCE → SECURITY
→ COMPATIBILITY → QUALITY → TRUST → TEST → DECISION
```

Statuts de décision cibles : `APPROVED`, `APPROVED_WITH_LIMITS`, `REVIEW_REQUIRED`,
`QUARANTINED`, `REJECTED`, `MISSING`.

## Ce qui existe (committé par ce handoff)

- `src/core/contracts/skill-candidate.ts` — DTOs Zod : `SkillCandidate`,
  `CandidateProvenance`, `CapabilityClaimEvidence`, `CompatibilityHint`, enums
  verification / trust / security / compatibility, `SkillsMpError` + codes d'erreur typés,
  `isSkillsMpErrorRetryable`.
- `src/core/contracts/skill-candidate.test.ts` — tests de contrats, dont les défauts
  fail-closed (`untrusted` / `pending` / `unknown`).
- `src/core/skills/candidate.ts` — hash canonique SHA-256 déterministe, déduplication
  stable `providerId:externalId`, tri stable, sanitisation string/URL, construction de
  provenance, extraction de hints ; l'extraction de claims retourne volontairement `[]`.
- `src/server/providers/skillsmp/skillsmp-provider.ts` + `index.ts` — adaptateur HTTP
  **read-only** : validation Zod défensive, `fetch` et `clock` injectés, timeout via
  `AbortController`, `redirect: "error"`, mapping HTTP → erreurs typées, extraction des
  en-têtes de rate-limit, pagination via `hasNext`, `searchAllPages(maxPages)`.
- `src/config/env.ts` — déclaration de `SKILLSMP_API_KEY` en `optionalSecret`.
- Exports ajoutés dans `src/core/contracts/index.ts` et `src/core/skills/index.ts`.

Étapes couvertes : DISCOVER, NORMALIZE, DEDUPLICATE (côté domaine).

Provenance conservée pour chaque candidat : source, URL de découverte, repository,
identifiant externe, version/commit, date de découverte, hash de métadonnées.

## Ce qui est partiel

- Ordre de traitement des erreurs : le parse Zod de l'enveloppe s'exécute avant le contrôle
  `response.ok`, donc un corps d'erreur non conforme produit `INVALID_RESPONSE` au lieu de
  `AUTH_FAILED` / `RATE_LIMITED`.
- Rate-limit : en-têtes extraits, mais aucun backoff et aucun respect de `retryAfter` dans
  `searchAllPages`.
- Déduplication disponible dans le domaine mais jamais appelée par le provider.
- `SKILLSMP_CANDIDATE_INCOMPLETE` et `SKILLSMP_SOURCE_UNAVAILABLE` sont définis mais jamais
  levés ; les skills incomplets sont ignorés silencieusement, sans compteur ni trace.
- `createSkillsMpConfig()` lit `process.env.SKILLSMP_API_KEY` directement dans la couche
  provider, en écart avec la documentation du champ `apiKey`.

Ces imperfections sont **documentées et volontairement non corrigées** dans ce commit de
préservation.

## Ce qui manque

- Étapes INSPECT SOURCE, SECURITY, COMPATIBILITY, QUALITY, TRUST, TEST, DECISION.
- Statuts de décision agrégés (`APPROVED`, `APPROVED_WITH_LIMITS`, `REVIEW_REQUIRED`,
  `QUARANTINED`, `REJECTED`, `MISSING`) — les enums actuels sont des sous-états techniques.
- Port de domaine formel (type `SkillDiscoverySourcePort`) : `SkillsMpProvider` est une
  classe concrète sans interface d'abstraction côté domaine.
- Persistance des candidats : aucune table `skill_candidates`, aucune migration.
- Tests du provider : offline avec `fetch` factice, 401 / 429 / 503, timeout, réponse
  malformée, pagination.
- Tests de `src/core/skills/candidate.ts` (hash, déduplication, sanitisation).
- Câblage container et routes API — absents **volontairement**, cohérent avec l'interdiction
  d'activation implicite.

## Risques

- Branche en retard significatif sur `origin/main` ; un futur rebase sera non trivial.
- `src/core/contracts/index.ts` et `src/core/skills/index.ts` sont partagés avec le
  workstream C2 skill-registry : conflits probables au rebase.
- Le worktree principal contient physiquement d'autres WIP (Repository Registry, sous-worktrees
  non suivis) : ne jamais utiliser `git add -A` ici.
- Dépendance de disponibilité à une source externe ; prévoir un cache local avant tout usage
  opérationnel.
- Risques inhérents au catalogue externe : compromission, typosquatting, provenance douteuse.
  Réponse attendue : fail-closed, `QUARANTINED` par défaut.

## Sécurité

Fail-closed. Un résultat externe non inspecté ne doit jamais être marqué `APPROVED`.

Aucune skill candidate ne doit obtenir implicitement : accès production, secrets, filesystem
global, shell non restreint, réseau non restreint, privilèges G1, rôle SystemAgent, budget,
ou autorité de déploiement.

La clé API SkillsMP réside hors du dépôt, dans `~/.icos/secrets/skillsmp.env` (nom de variable
`SKILLSMP_API_KEY`). Elle ne doit jamais être copiée dans le repo, affichée ou committée.

## Décision à venir : BUILD vs REUSE

Hermes / agentskills.io pourrait devenir le **runtime d'exécution de skills** d'ICOS. Dans ce
cas, le rôle de SkillsMP se limiterait à la découverte et au signal de confiance, en amont,
et une partie du pipeline envisagé ici deviendrait redondante.

En conséquence, **cette branche est à réévaluer dans le cadre de l'arbitrage BUILD-vs-REUSE
ICOS** avant toute poursuite d'implémentation. Ce commit est un point de sauvegarde, pas un
engagement d'architecture.

## Séparation des workstreams

- **M2 Durable Execution** : distinct, non touché.
- **Repository Registry** : distinct, non touché. SkillsMP pourra l'alimenter plus tard, mais
  le provider et le pipeline de confiance doivent rester découplés.

## État de vérification au moment du commit de préservation

Ce commit est un point de sauvegarde d'un WIP **non vert**. Les vérifications ont été
exécutées et échouent volontairement sans correction (instruction explicite : ne pas
corriger les imperfections détectées).

- `pnpm typecheck` : **ÉCHEC**.
  - `src/server/providers/skillsmp/skillsmp-provider.ts` : TS1361 ×11 — `SkillsMpError`
    importé via `import type` puis utilisé comme valeur (`new SkillsMpError(...)`).
  - `skillsmp-provider.ts:202` : TS2345 — `id: string | number` passé à un paramètre `id: string`.
  - `skillsmp-provider.ts:212-213` : TS2322 ×2 — `sanitizeUrl()` retourne `string | null`
    affecté à `string | undefined`.
  - `src/core/contracts/skill-candidate.test.ts` : TS2552 ×4 — `candidateSecurityStateSchema`
    référencé mais non exporté/importé ; TS2537 ligne 228.
- `pnpm vitest run src/core/contracts/skill-candidate.test.ts` : **22 passés, 1 échoué**
  (`candidateSecurityStateSchema is not defined`).

Correctifs mécaniques attendus lors de la reprise (après arbitrage BUILD-vs-REUSE) :
sortir `SkillsMpError` du bloc `import type`, coercition explicite de l'identifiant externe,
normalisation `null → undefined` des URLs, et alignement du nom du schéma d'état de sécurité
entre contrat et test.
