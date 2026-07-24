# Classification des données — ICOS

| Statut   | Version |
|----------|---------|
| Approuvé | 0.1     |

## 1. Objectif

Définir le système de classification des données traitées par ICOS, couvrant
l'ensemble des phases (développement, test, production) et applicables à toute
skill, lot, agent ou infrastructure.

La classification complète d'une donnée est la combinaison de deux axes
indépendants :

```text
DataClassification = DataCategory + SensitivityLevel
```

- **DataCategory** : catégorie sémantique de la donnée (ex. PERSONAL, HEALTH,
  AUTH_SECRET). Deux données de même catégorie peuvent avoir des sensibilités
  différentes selon le contexte.
- **SensitivityLevel** : niveau de criticité (C0–C3). Détermine les contrôles
  minimaux de protection (chiffrement, accès, rétention).

Ce document définit les deux axes. Le registre des traitements
(`03-register.md`) et la politique de rétention (`02-retention.md`) appliquent
cette classification combinée.

## 2. SensitivityLevel — Niveaux de criticité (C0–C3)

| Niveau | Tag             | Définition                                                                 | Exemples ICOS                                                    |
|--------|-----------------|----------------------------------------------------------------------------|------------------------------------------------------------------|
| **C0** | `public`        | Information dont la divulgation ne cause aucun préjudice. Accessible sans authentification. | Documentation publique, readme, bannières, statistiques agrégées et anonymisées. |
| **C1** | `internal`      | Information interne à l'organisation. Accidentellement publique → préjudice mineur (image, concurrence). | Architecture interne, ADR, plans de développement,logs d'infrastructure non nominatifs. |
| **C2** | `confidential`  | Information à accès restreint. Divulgation → préjudice significatif (légal, contractuel, réputation). | Identifiants techniques (API keys, tokens), configuration d'accès, adresses IP internes, secrets. |
| **C3** | `restricted`    | Données personnelles ou sensibles au sens RGPD. Divulgation → préjudice grave (sanction, plainte, perte de confiance). | E-mail, nom, rôle, identifiant interne d'une personne physique, préférences d'un utilisateur, métriques comportementales. |

## 3. DataCategory — Catégories sémantiques

La classification complète d'une donnée est `(DataCategory, SensitivityLevel)`.
Une même catégorie sémantique peut avoir un SensitivityLevel différent selon le
contexte. Par exemple, un identifiant de session est PERSONAL C3, tandis qu'un
identifiant technique d'infrastructure est AUTH_SECRET C2.

### 3.1 Référentiel des catégories

| DataCategory | Définition | Exemples ICOS | SensitivityLevel typique |
|---|---|---|---|
| `PUBLIC` | Information librement diffusable | Documentation publique, statistiques agrégées | C0 |
| `INTERNAL` | Information interne à l'organisation | ADR, plans, code source, logs non nominatifs | C1 |
| `PERSONAL` | Donnée personnelle d'un utilisateur (RGPD art. 4) | E-mail, nom, identifiant interne, préférences | C3 |
| `SENSITIVE_PERSONAL` | Catégorie spéciale (RGPD art. 9) | Santé, biométrie, opinions (hors périmètre ICOS) | C3 |
| `CONFIDENTIAL_CLIENT` | Donnée d'un client ICOS | Nom, email, historique commercial, documents | C3 |
| `AUTH_SECRET` | Secret d'authentification ou de session | Token, hash, clé API, session ID | C2–C4 |
| `FINANCIAL` | Donnée financière ou de paiement | Abonnement, crédits, facture | C2–C3 |
| `LEGAL` | Document ou trace à valeur juridique | Contrat, audit, consentement, DPA | C2–C3 |
| `HEALTH` | Donnée de santé (hors périmètre actuel) | Information médicale, dossier patient | C3 |
| `HR` | Donnée RH d'un membre de l'organisation | Contrat, évaluation, salaire | C3 |
| `CHILD_DATA` | Donnée d'un mineur (hors périmètre actuel) | Identité, consentement parental | C3 |
| `BIOMETRIC` | Donnée biométrique (hors périmètre actuel) | Empreinte, reconnaissance faciale | C3 |
| `DERIVED_PROFILE` | Profil ou inférence générée par le système | Recommandation, classification, score | C2–C3 |

La colonne *SensitivityLevel typique* est une indication ; le niveau réel est
déterminé par la politique de donnée attachée à chaque entité, jamais par
inférence.

### 3.2 Règles dépendant de DataCategory

Indépendamment du SensitivityLevel, certaines règles peuvent varier par
DataCategory :

- **Rétention** : des durées différentes peuvent s'appliquer à PERSONAL vs
  FINANCIAL même à SensitivityLevel identique (C3).
- **Memory eligibility** : certaines catégories (AUTH_SECRET, BIOMETRIC) ne
  doivent jamais être stockées en mémoire agent.
- **Provider routing** : FINANCIAL ou HEALTH peuvent être restreints à des
  providers spécifiques.
- **Transfert** : CONFIDENTIAL_CLIENT peut avoir des restrictions de
  transfert supplémentaires.
- **Base légale / consentement** : PERSONAL peut reposer sur le contrat ;
  DERIVED_PROFILE nécessite un consentement explicite.
- **Logging / observability** : AUTH_SECRET ne doit jamais apparaître dans les
  logs, même anonymisé.
- **Accès** : FINANCIAL peut nécessiter une séparation des rôles comptable.
- **DPIA / risk assessment** : HEALTH et CHILD_DATA nécessitent une DPIA avant
  tout traitement.

### 3.3 Données personnelles (C3)

Relèvent du niveau **C3** tous les champs permettant d'identifier directement
ou indirectement une personne physique :

- nom, prénom, pseudonyme ;
- adresse e-mail personnelle ou professionnelle ;
- numéro de téléphone ;
- identifiant interne unique (PID, user ID) couplé à un nom ;
- logs comportementaux (trajectoire de navigation, temps de réponse) ;
- préférences, paramètres de notification, langue.

### 2.2 Données hautement sensibles (au-delà de C3)

Toute donnée relevant des catégories spéciales de l'article 9 RGPD (données de
santé, biométriques, opinions politiques, religieuses, syndicales, orientation
sexuelle, origine raciale ou ethnique) est **exclue du périmètre d'ICOS à ce
stade** et nécessite une décision d'architecture et un lot dédié avant tout
traitement.

## 5. Marquage

Tout document, base de données, champ ou artefact contenant des données
classifiées doit porter un marquage explicite dans ses métadonnées,
idéalement sous la forme `(DataCategory, SensitivityLevel)` :

- Dans une base relationnelle : commentaire de colonne
  `@classification (PERSONAL, C3)` ou tag de table.
- Dans un document : en-tête **Classification : (PERSONAL, C3)**.
- Dans un payload API : champs `dataCategory` et `sensitivityLevel` dans
  l'enveloppe de réponse.
- Dans un fichier de code source ou configuration : commentaire en début de
  fichier `# dataCategory: AUTH_SECRET` / `# sensitivityLevel: C2`.

À terme (Phase B), le registre de capacités (`CapabilityRegistry`) portera
les champs `dataCategory` et `sensitivityLevel` sur chaque capacité publiée.

## 6. Règles de reclassification

- Une donnée (PERSONAL, C3) agrégée et anonymisée (k > 5) passe en (PUBLIC, C1).
- Une donnée (INTERNAL, C1) enrichie d'un identifiant personnel passe en (PERSONAL, C3).
- Toute reclassification est une action auditée, avec traçabilité de l'ancien et
  du nouveau couple `(DataCategory, SensitivityLevel)`.

## 7. Responsabilités

| Rôle                  | Responsabilité                                              |
|-----------------------|-------------------------------------------------------------|
| Développeur           | Marquer les données manipulées selon leur niveau réel.      |
| Relecteur (PR)        | Vérifier que le marquage correspond à la classification.    |
| DPO (désigné)         | Valider les cas limites et les reclassifications.           |
| Révision annuelle     | Mise à jour du référentiel DataCategory et des SensitivityLevel, ajout des catégories manquantes. |
