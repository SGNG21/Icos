# G1 — Tool Gateway

## Statut

Design validé et final. Ce document capture les décisions architecturales
approuvées pour l'ensemble du lot G1 (Tool Gateway) et définit le périmètre
de G1.0 Foundation.

## Architecture

```text
D2 (Mission Engine)
    │
    ▼
G1 Tool Gateway
    │
    ├──► D1 (Policy / Authorization Engine)
    │       │
    │       └──► ExecutionGrant
    │
    └──► Inspectors (preflight)
            │
            └──► ExecutionGrant
                    │
                    ▼
            D4 RuntimeExecutionPort
                    │
                    ▼
               execution
```

### Règles de dépendance

- G1 → D4 : autorisé
- D4 → G1 : interdit (D4 ne connaît pas G1)
- D1 reste l'autorité de politique
- D2 reste la source de vérité des missions
- D4 reste la source de vérité de l'exécution

## Séparation des concepts

Skill ≠ Capability ≠ Permission ≠ Approval ≠ ExecutionGrant

La possession d'une capacité (Capability) seule n'autorise JAMAIS l'exécution.

## Gestion des approbations V1

| Décision D1      | Opérationnel en V1 | Comportement                                   |
| ---------------- | ------------------ | ---------------------------------------------- |
| ALLOW            | OUI                | ExecutionGrant peut être émis                  |
| DENY             | OUI                | Aucun ExecutionGrant                           |
| REQUIRE_APPROVAL | NON                | Fail closed : `identity_verification_required` |

`REQUIRE_APPROVAL` n'est PAS opérationnel en G1 V1 car `Approval.decidedBy`
est déclaratif et NON authentifié. Aucun ExecutionGrant sensible ne peut être
émis depuis une approbation non vérifiée.

`EligibleApproverSnapshot` + vérification d'identité de l'approbateur : P1
(prévu pour G1.2). Ne bloque pas le cœur ALLOW/DENY de G1 V1.

## ExecutionGrant

Un ExecutionGrant signifie :

> "cette invocation précise est actuellement autorisée"

Aucun grant n'est émis pour :

- une décision DENY
- un REQUIRE_APPROVAL non résolu

### Champs obligatoires

Le grant lie au moins :

- `tenant` — identifiant du locataire
- `principal` / `actor` — acteur demandeur (agent identifié)
- `mission` — identifiant de la mission en cours
- `run` — identifiant de l'exécution (run ID)
- `toolId` — identifiant de l'outil invoqué
- `toolDefinitionHash` — empreinte de la définition d'outil
- `toolVersion` — version de l'outil (si applicable)
- `capability` — capacité requise pour l'invocation
- `operation` — opération invoquée
- `resource` — ressource cible
- `requestHash` — empreinte de la requête canonique
- `idempotencyKey` — clé d'idempotence
- `policyProvenance` — référence et provenance de la politique ayant autorisé
- `credentialRequirements` — exigences de credentials
- `networkRequirements` — exigences réseau
- `isolationRequirements` — exigences d'isolation
- `issuedAt` — date d'émission
- `expiresAt` — date d'expiration

### Règles V1

- TTL court (temps de vie limité)
- Usage unique (single-use) : le grant est consommé immédiatement après
  utilisation et ne peut pas être réutilisé

### Séparation des états

Grant consumption state ≠ IdempotencyState

L'état de consommation du grant (utilisé / non utilisé) est distinct de
l'état d'idempotence de l'exécution.

## Request Hash

`requestHash` représente l'invocation canonique et doit couvrir les éléments
d'identité immuable pertinents :

- tenant
- principal
- toolId
- toolDefinitionHash / version
- capability
- operation
- resource
- arguments canoniques
- périmètre d'effet externe pertinent

Toute divergence dans le requestHash entre deux étapes du cycle de vie
doit entraîner un échec (FAIL CLOSED).

Le requestHash est lié à :

- IdempotencyState
- ExecutionGrant
- ExecutionRecord
- future ApprovalResolution

## Idempotence

### Principes

- `AttemptNumber` ≠ `IdempotencyKey` : un retry technique conserve la même
  identité métier d'idempotence
- Même clé d'idempotence + requestHash différent → `IDEMPOTENCY_CONFLICT`
  → FAIL CLOSED

### États canoniques

```text
RESERVED
    │
    ▼ (atomique)
EXECUTING
    │
    ├──► COMPLETED
    ├──► FAILED_SAFE
    └──► UNKNOWN (depuis stale EXECUTING)
```

- `RESERVED` : D4 n'a PAS été appelé
- `EXECUTING` : l'exécution (via D4) est en cours
- `COMPLETED` : résultat durable et rejouable
- `FAILED_SAFE` : échec non récupérable, arrêt sûr
- `UNKNOWN` : état indéterminé (stale EXECUTING)

### Règles de cycle de vie

1. **reserve** → état `RESERVED`
2. transition atomique `RESERVED` → `EXECUTING`
3. seulement APRÈS cette transition, l'exécution externe/runtime peut
   démarrer
4. `RESERVED` obsolète (stale) : peut être repris en toute sécurité selon
   des règles de verrouillage explicites
5. `EXECUTING` obsolète (stale) : → `UNKNOWN`
6. `UNKNOWN` : JAMAIS de rejeu automatique
7. `UNKNOWN` sans réconciliation vérifiable → `MANUAL_INTERVENTION_REQUIRED`
   → FAIL CLOSED

### Ce qui n'existe pas

N'inventez PAS :

- `D4.checkExecutionState()`
- `D4.mayHaveExecuted()`

La réconciliation d'effet externe appartient à l'outil / l'adaptateur /
l'autorité externe quand elle est supportée.

## Execution Record / Audit

### Séparation des responsabilités

| Stockage                | Nature                  | Usage                |
| ----------------------- | ----------------------- | -------------------- |
| ExecutionRecord / Audit | Immuable, append-only   | Historique           |
| IdempotencyState        | Mutable, transactionnel | État opérationnel    |
| Artifact Store          | Stockage de résultats   | Résultats durables   |
| Business Data Store     | Données métier          | Données applicatives |

### Événements d'audit

Famille d'événements `tool.invocation_*` :

- `tool.invocation_reserved`
- `tool.invocation_started`
- `tool.invocation_completed`
- `tool.invocation_failed`
- `tool.invocation_unknown`

### SensitivityLevel

Réutiliser les niveaux canoniques existants :

- C0
- C1
- C2
- C3

### Data minimization

Ne JAMAIS persister dans l'audit :

- credentials bruts
- secrets
- sorties brutes arbitraires d'outils

Préférer les métadonnées / références :

- outcome (succès/échec)
- errorCode
- durationMs
- artifactRefs
- outputHash
- classification (SensitivityLevel)
- grantId
- requestHash
- policy references
- metadata sûr / anonymisé

Ne jamais muter un événement d'audit ancien pour représenter un nouvel état
du cycle de vie.

## Complétion atomique

COMPLETED signifie que le résultat (ou la référence au résultat) requis pour
le rejeu idempotent est durable.

N'appliquez PAS :

```text
IdempotencyState → COMPLETED
PUIS persister ExecutionRecord (séparément)
```

Utilisez une seule UnitOfWork / transaction contenant :

1. résultat/référence durable
2. ExecutionRecord immuable (append)
3. transition finale de l'IdempotencyState

Si l'atomicité ne peut pas être garantie :
ne déclarez PAS COMPLETED.

## Inspecteurs

Trois issues possibles :

| Issue    | Signification                                         |
| -------- | ----------------------------------------------------- |
| PASS     | Vérification réussie                                  |
| BLOCK    | Violation de sécurité matérielle, non discrétionnaire |
| ESCALATE | Constat structuré → D1 décide                         |

Les inspecteurs ne sont PAS un second moteur de politique :

- BLOCK : uniquement des violations de sécurité dures (objectives, non
  discrétionnaires)
- ESCALATE : constats structurés → mappés vers `PolicyRiskSignal` natif D1
  → D1 décide

D1 ne doit jamais dépendre de types spécifiques à G1.

**CredentialInspector** : ne résout jamais de secrets bruts. Valide
uniquement les exigences / périmètre / contexte.

Les vérifications réseau et credentials de G1 sont **preflight**. Les
vérifications réseau et credentials de D4 sont **runtime**.

## Modèle d'outil

### ToolIdentity (identité stable)

- toolId
- name

### ToolDefinition (versionné / runtime / métier)

- identity (référence vers ToolIdentity)
- version
- source
- publisher
- adapterKind
- declaredCapabilities
- risk
- requirements (credentials, réseau, isolation)
- inputSchema
- outputSchema
- externalEffects

G1 possède la sémantique d'invocation des outils. D4 n'interprète PAS les
sémantiques de risque / capacité / permission de ToolIdentity.

## Revalidation D4.1

Canonique main : `618ff19ed367e9c82a54f66c147629f73f0fc7e0`

| Point                | Statut                           |
| -------------------- | -------------------------------- |
| RuntimeExecutionPort | PASS                             |
| ExecuteStepInput     | PASS                             |
| RuntimeAdapterInput  | PASS                             |
| ExecutionResult      | PASS                             |
| G1 → D4              | PASS                             |
| D4 → G1              | NONE (interdit par architecture) |

Aucune modification architecturale D4 requise.

`command` / `args` / `env` sont des préoccupations de `RuntimeAdapterInput`
et appartiennent au futur G1.1 (Tool Gateway), pas à G1.0 Foundation.

## Lots G1

### G1.0 — Foundation (maintenant)

- ExecutionGrant
- Grant single-use consumption state
- requestHash
- IdempotencyKey
- IdempotencyState (RESERVED, EXECUTING, COMPLETED, FAILED_SAFE, UNKNOWN)
- ExecutionRecord
- Repository ports
- Persistence (in-memory + PostgreSQL)
- UnitOfWork / transitions atomiques
- Intégration audit
- Tests

### G1.1 — Tool Gateway (ultérieur)

- ToolIdentity
- ToolDefinition
- ToolGatewayPort
- ExecutionInspectors
- Intégration D1
- Intégration D4

### G1.2 — P1 immédiat (ultérieur)

- EligibleApproverSnapshot
- Identité vérifiée de l'approbateur
- Parcours d'exécution d'approbation
- Intégration DelegationGrant
- Extensions D1 critical-risk si nécessaires

## Ordre d'implémentation G1.0

1. Schémas / types canoniques
2. Utilitaire requestHash
3. Dérivation IdempotencyKey
4. Modèle IdempotencyState
5. Modèle ExecutionGrant
6. Modèle de consommation du grant
7. Modèle ExecutionRecord / événements
8. Ports de repositories
9. Implémentations in-memory
10. Implémentation PostgreSQL
11. UnitOfWork atomique
12. Tests ciblés
13. Suite de régression complète

## Matrice de tests minimale

### ExecutionGrant

- Création valide d'un grant
- Expiration
- Usage unique
- Consommation concurrente
- Tenant mismatch
- Principal mismatch
- requestHash mismatch
- toolDefinitionHash mismatch

### Idempotence

- Clé déterministe
- Même clé + même requestHash → OK (replay)
- Même clé + requestHash différent → conflit
- Réservation concurrente
- RESERVED → EXECUTING atomique
- COMPLETED → rejeu
- FAILED_SAFE → sémantique de retry
- Stale EXECUTING → UNKNOWN
- UNKNOWN → rejeu automatique interdit

### Audit

- Append-only
- Séquence correcte des événements
- Pas de credentials bruts
- Pas de sorties brutes arbitraires
- SensitivityLevel réutilisé

### Atomicité

- Pas de COMPLETED sans résultat/référence durable
- Échec de transaction laisse état récupérable sûr

### Isolation

- Tenant A ne peut ni lire ni utiliser le grant / l'état d'idempotence
  de tenant B
