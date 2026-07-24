# Classification des données — ICOS

| Statut   | Version |
|----------|---------|
| Approuvé | 0.1     |

## 1. Objectif

Définir un système de classification des données traitées par ICOS, couvrant
l'ensemble des phases (développement, test, production) et applicables à toute
skill, lot, agent ou infrastructure. Cette taxonomie est le référentiel unique
de sensibilité ; tout document de rétention, registre de traitements ou gate de
conformité s'y réfère.

## 2. Niveaux de classification

| Niveau | Tag             | Définition                                                                 | Exemples ICOS                                                    |
|--------|-----------------|----------------------------------------------------------------------------|------------------------------------------------------------------|
| **C0** | `public`        | Information dont la divulgation ne cause aucun préjudice. Accessible sans authentification. | Documentation publique, readme, bannières, statistiques agrégées et anonymisées. |
| **C1** | `internal`      | Information interne à l'organisation. Accidentellement publique → préjudice mineur (image, concurrence). | Architecture interne, ADR, plans de développement,logs d'infrastructure non nominatifs. |
| **C2** | `confidential`  | Information à accès restreint. Divulgation → préjudice significatif (légal, contractuel, réputation). | Identifiants techniques (API keys, tokens), configuration d'accès, adresses IP internes, secrets. |
| **C3** | `restricted`    | Données personnelles ou sensibles au sens RGPD. Divulgation → préjudice grave (sanction, plainte, perte de confiance). | E-mail, nom, rôle, identifiant interne d'une personne physique, préférences d'un utilisateur, métriques comportementales. |

### 2.1 Données personnelles (C3)

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

## 3. Marquage

Tout document, base de données, champ ou artefact contenant des données
classifiées doit porter un marquage explicite dans ses métadonnées :

- Dans une base relationnelle : commentaire de colonne `@classification C2`
  ou tag de table.
- Dans un document : en-tête **Classification : C1**.
- Dans un payload API : champ `classification` dans l'enveloppe de réponse.
- Dans un fichier de code source ou configuration : commentaire en début de
  fichier `# classification: C2`.

À terme (Phase B), le registre de capacités (`CapabilityRegistry`) portera
un champ `classification` sur chaque capacité publiée.

## 4. Règles de reclassification

- Une donnée C3 agrégée et anonymisée (k > 5) passe en C1.
- Une donnée C1 enrichie d'un identifiant personnel passe en C3.
- Toute reclassification est une action auditée.

## 5. Responsabilités

| Rôle                  | Responsabilité                                              |
|-----------------------|-------------------------------------------------------------|
| Développeur           | Marquer les données manipulées selon leur niveau réel.      |
| Relecteur (PR)        | Vérifier que le marquage correspond à la classification.    |
| DPO (désigné)         | Valider les cas limites et les reclassifications.           |
| Révision annuelle     | Mise à jour de la taxonomie, ajout des catégories manquantes. |
