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
[Client/UI]
    |
    | TLS 1.3
    v
[Route Handler] ──auth──→ [Policy (caps)] ──→ [Use Case]
                                                  |
                                                  v
                                          [Repository Port]
                                                  |
                                                  v
                                          [PostgreSQL] ← chiffrement at-rest (COMPLIANCE-2)
```

Tout accès à des données C3 traverse :
1. Authentification (session)
2. Autorisation (caps)
3. Use case (validation, classification)
4. Repository (persistance avec marquage)
5. Audit (journal append-only)

## 4. Architecture physique (prévisions)

| Composant              | Mesure prévue                                     | Lot        |
|------------------------|---------------------------------------------------|------------|
| Base de données        | Chiffrement at-rest (AES-256 via PostgreSQL TDE)  | COMPLIANCE-2 |
| Transport              | TLS 1.3 (déjà en place)                           | Existant   |
| Logs                   | Rotation, purge à 90 jours, pas de C3            | COMPLIANCE-1 |
| Sauvegardes            | Chiffrement au repos, rétention 90 jours max     | COMPLIANCE-2 |
| Cache (Redis)          | Pas de C3 en cache persistant                     | Règle immédiate |

## 5. Documents associés

- `01-classification.md` — classification C0–C3 ;
- `02-retention.md` — politiques de rétention ;
- `03-register.md` — registre des traitements ;
- `04-validation-gates.md` — gate Compliance et points de validation.
