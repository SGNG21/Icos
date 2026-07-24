# Architecture vie privée — ICOS

| Statut    | Version |
|-----------|---------|
| Projet    | 0.1     |

## 1. Objectif

Documenter les principes architecturaux de protection de la vie privée
applicables à ICOS, conformément au principe de Privacy by Design (RGPD
Art. 25). Ces principes guident toute décision technique touchant des données
personnelles (C3).

## 2. Principes

### 2.1 Privacy by Design

Toute fonctionnalité manipulant des données personnelles intègre les contrôles
de privacy dans sa conception, pas après coup. La revue de conformité (gate
Compliance, `04-validation-gates.md`) est une étape obligatoire du cycle de
développement.

### 2.2 Data minimisation

ICOS ne collecte, ne conserve et ne transfère que les données strictement
nécessaires à la finalité déclarée. Aucune collecte « au cas où ».

- Champs C3 limités au strict nécessaire dans les schémas.
- Logs fonctionnels sans données C3 redondantes.
- Métriques agrégées préférées aux traces individuelles quand la finalité le
  permet.

### 2.3 Séparation des responsabilités

- Les contrôles d'accès sont serveur, pas UI.
- Aucun secret métier (mot de passe, token, hash) ne quitte le périmètre
  serveur autorisé.
- Le modèle d'autorisation ICOS (`caps`) s'applique aux données C3 comme à
  toute autre ressource.

### 2.4 Auditabilité

- Toute opération sur des données C3 est tracée dans le journal d'audit
  existant : acteur, action, cible, raison, horodatage.
- Aucune donnée sensible dans les détails d'audit.
- Le journal d'audit est append-only.

### 2.5 Portabilité

L'architecture prépare l'export des données personnelles par l'utilisateur
dans un format standard (JSON structuré). Implémentation prévue dans un lot
ultérieur (Phase F ou G).

### 2.6 Droit à l'effacement

Une fonction de suppression est prévue :

- suppression logique avec fenêtre de récupération (soft-delete, 30 jours) ;
- purge physique après la fenêtre ;
- conservation minimale des traces d'audit pour justification (horodatage,
  acteur, action, mais pas le contenu supprimé).

## 3. Architecture logique

```text
┌─────────────────────────────────────────────────────────────┐
│                        TENANT BOUNDARY                       │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │ Client   │    │ Route        │    │ Policy (caps)     │  │
│  │ / UI     │───→│ Handler      │───→│ + Policy Engine   │  │
│  │          │TLS │              │auth │ (compliance rules)│  │
│  └──────────┘ 1.3 └──────────────┘    └────────┬──────────┘  │
│                                                 │            │
│                                                 v            │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                  Use Case Layer                        │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐   │   │
│  │  │ Validation  │  │ Classification│  │ Audit trail │   │   │
│  │  │ (purpose,   │  │ (C0–C3 check) │  │ (actor,     │   │   │
│  │  │  retention) │  │               │  │  action, ts)│   │   │
│  │  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘   │   │
│  └─────────┼───────────────┼─────────────────┼──────────┘   │
│            │               │                 │              │
│            v               v                 v              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                  Repository Port                       │   │
│  │  ┌───────────────┐  ┌──────────────┐  ┌────────────┐  │   │
│  │  │ C3 data store │  │ C0–C2 store  │  │ Event      │  │   │
│  │  │ (encrypted    │  │ (standard)   │  │ Journal    │  │   │
│  │  │  at-rest)     │  │              │  │ (append-   │  │   │
│  │  └───────┬───────┘  └──────┬───────┘  │ only)      │  │   │
│  └──────────┼────────────────┼───────────└──────┬──────┘   │
│             │                │                   │          │
└─────────────┼────────────────┼───────────────────┼──────────┘
              │                │                   │
              v                v                   v
    ┌─────────────────┐  ┌──────────────┐  ┌─────────────────┐
    │ PostgreSQL C3   │  │ PostgreSQL   │  │ Audit (append-  │
    │ (AES-256 TDE)   │  │ (standard)   │  │ only, 5 ans)    │
    └─────────────────┘  └──────────────┘  └─────────────────┘

    ┌─────────────────────────────────────────────────────────┐
    │                  BACKGROUND WORKERS                      │
    │  ┌──────────────────────────────────────────┐            │
    │  │  Retention Worker (cron)                  │            │
    │  │  • Purge C3 données expirées             │            │
    │  │  • Anonymisation programmée (k > 5)      │            │
    │  │  • Audit entry `data.retention_purge`    │            │
    │  └──────────────────────────────────────────┘            │
    └─────────────────────────────────────────────────────────┘
```

**Flux C3 :** toute donnée PERSONAL/C3 transite par la couche Use Case qui
valide classification, rétention et purpose avant écriture en base chiffrée.
Le Repository Port garantit le marquage `@classification` sur chaque colonne
C3.

**Flux non-C3 (C0–C2) :** chemin standard via Policy (caps), sans chiffrement
at-rest obligatoire (C2 sauf AUTH_SECRET).

**Tenant boundary :** tous les accès (lecture/écriture) sont filtrés par le
tenant de l'utilisateur authentifié. Aucune donnée ne traverse cette frontière
sans vérification explicite (invariant IDOR, scenario 001/011).

**Audit :** toute opération sur donnée C3 est horodatée dans l'Event Journal
append-only. L'audit lui-même ne contient jamais de données C3 (uniquement
métadonnées : acteur, action, type, horodatage).

## 4. Architecture physique (prévisions)

| Composant              | Mesure prévue                                     | Lot        |
|------------------------|---------------------------------------------------|------------|
| Base de données        | Chiffrement at-rest (AES-256 via PostgreSQL TDE)  | COMPLIANCE-2 |
| Transport              | TLS 1.3 (déjà en place)                           | Existant   |
| Logs                   | Rotation, purge à 90 jours, pas de C3            | COMPLIANCE-1 |
| Sauvegardes            | Chiffrement au repos, rétention 90 jours max     | COMPLIANCE-2 |
| Cache (Redis)          | Pas de C3 en cache persistant                     | Règle immédiate |

### 4.1 Architecture future — extension provider et mémoire

L'architecture logique (§3) sera enrichie dans les lots ultérieurs :

```text
                      ┌──────────────┐
                      │  Provider     │ (D3)
                      │  Boundary     │
                      │  • Compliance │
                      │  • Region     │
                      │  • Training   │
                      └──────┬───────┘
                             │
           ┌─────────────────┼──────────────────┐
           │   ProviderComplianceProfile        │
           │   DataTransferPolicy               │
           └─────────────────┬──────────────────┘
                             │
                    ┌────────v────────┐
                    │   Memory Port   │ (E1)
                    │  • Retention    │
                    │  • Provenance   │
                    │  • Invalidation │
                    └─────────────────┘
```

- **Provider Boundary (D3)** : tout envoi de données C2+ vers un provider externe
  traverse le ProviderComplianceProfile qui vérifie région, certifications et
  `trainingAllowed` avant transmission.
- **Memory Port (E1)** : la mémoire agent applique les politiques de rétention
  (invariant 14) et les règles de provenance avant toute persistance en mémoire
  à long terme.

## 5. Glossaire architectural — concepts de conformité

Ce glossaire définit les concepts manipulés par l'architecture de conformité
ICOS. Chaque entrée précise son rôle, son statut actuel et le lot cible si
l'implémentation est future.

| Concept | Définition courte | Rôle dans ICOS | Statut | Lot cible |
|---|---|---|---|---|
| **Tenant** | Périmètre d'isolation logique (organisation, client). | Toute donnée C3 est associée à un tenant. L'isolation cross-tenant est un invariant. | PLANNED | COMPLIANCE-1 |
| **Organization** | Entité administrative propriétaire d'un ou plusieurs tenants. | Regroupe les utilisateurs, les politiques et les souscriptions. | FUTURE | Phase B/H |
| **Workspace** | Espace de travail à l'intérieur d'un tenant (projet, équipe). | Scope les données, les agents et les capacités accessibles. | FUTURE | Phase B/H |
| **DataSubject** | Personne physique concernée par un traitement (RGPD art. 4). | Toute donnée PERSONAL/C3 est associée à un DataSubject. | PLANNED | COMPLIANCE-1 |
| **DataCategory** | Catégorie sémantique de la donnée (PERSONAL, AUTH_SECRET, FINANCIAL…). | Axe sémantique de la classification combinée `(DataCategory, SensitivityLevel)`. | DEFINED | — |
| **SensitivityLevel** | Niveau de criticité C0–C3. | Détermine les contrôles minimaux de protection. | DEFINED | — |
| **ProcessingPurpose** | Finalité déclarée d'un traitement (RGPD art. 5.1.b). | Toute utilisation de données C3 est rattachée à une finalité. | PLANNED | D1 |
| **LegalBasis** | Base légale du traitement (RGPD art. 6). | Associée à chaque couple `(DataCategory, ProcessingPurpose)`. | PLANNED | D1 |
| **RetentionPolicy** | Règle bornant la durée de conservation d'une donnée. | Définie par `(DataCategory, SensitivityLevel)`. Purge à échéance. | DEFINED | — |
| **DataProvenance** | Origine et chaîne de création d'une donnée. | Permet de tracer la source d'une donnée inférée ou importée. | FUTURE | E1 |
| **DataLineage** | Graphe complet des transformations d'une donnée entre systèmes. | Requis pour l'audit des décisions et la reproductibilité. | FUTURE | E1 |
| **ProviderComplianceProfile** | Profil de conformité d'un provider externe (région, certifications, trainingAllowed). | Détermine si un provider peut traiter une `(DataCategory, SensitivityLevel)` donnée. | PLANNED | D3 |
| **DataTransferPolicy** | Politique encadrant le transfert de données vers un provider ou une région. | S'applique avant tout envoi de données C2+ vers l'extérieur. | FUTURE | D3 |
| **SubprocessorRecord** | Enregistrement d'un sous-traitant (RGPD art. 28). | Documenté dans le registre des traitements. DPA signé requis avant mise en production. | DEFINED | — |
| **DpiaAssessment** | Analyse d'impact sur la protection des données (RGPD art. 35). | Requise avant tout traitement à risque élevé. Planifiée pour les traitements réels. | PLANNED | COMPLIANCE-3 |
| **SignificantDecision** | Décision automatisée à impact significatif pour une personne. | Nécessite intervention humaine (Policy Engine ≥ risk 4). | PLANNED | D1 |
| **ConsentRecord** | Trace du consentement explicite (RGPD art. 7). | Enregistrement horodaté avec finalité, version, retrait possible. | PLANNED | COMPLIANCE-2 |
| **DataSubjectRequest** | Demande d'exercice d'un droit RGPD (accès, rectification, etc.). | Workflow de réception, vérification et exécution de la demande. | PLANNED | COMPLIANCE-1 |
| **DeletionRequest** | Demande d'effacement (RGPD art. 17). | Déclenche suppression logique + purge physique avec traçabilité. | PLANNED | COMPLIANCE-2 |
| **LegalHold** | Gel de données pour contentieux (RGPD art. 18). | Suspend la purge automatique jusqu'à levée du gel. | PLANNED | COMPLIANCE-2 |
| **PersonalDataBreach** | Violation de données personnelles (RGPD art. 33-34). | Workflow de détection, notification CNIL 72h et information des personnes. | PLANNED | COMPLIANCE-2 |
| **SecurityIncident** | Tout incident de sécurité (avec ou sans données personnelles). | Déclenche investigation, escalade et, si nécessaire, procédure breach. | PLANNED | COMPLIANCE-1 |

**Légende des statuts :**
- `DEFINED` : concept documenté dans COMPLIANCE-0, applicable dès maintenant.
- `PLANNED` : concept identifié, implémentation prévue dans un lot futur.
- `FUTURE` : concept reconnu, non priorisé à ce stade.

## 6. Documents associés

- `01-classification.md` — classification C0–C3 ;
- `02-retention.md` — politiques de rétention ;
- `03-register.md` — registre des traitements ;
- `04-validation-gates.md` — gate Compliance et points de validation.
