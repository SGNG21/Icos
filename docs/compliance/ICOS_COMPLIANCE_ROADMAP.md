# ICOS — Compliance Roadmap

> **Document :** Roadmap des lots COMPLIANCE-0/1/2/3
> **Version :** 1.0
> **Date :** 2026-07-24
> **Statut :** accepté

## 1. Vue d'ensemble

La conformité ICOS est construite en quatre lots transverses, menés en parallèle
des phases fonctionnelles A–K du Master Plan.

```text
COMPLIANCE-0 ← Fondation documentaire (ce lot)
    ├── COMPLIANCE-1 ← Vérification automatisée et marquage
    ├── COMPLIANCE-2 ← Contrôles techniques et implémentation
    └── COMPLIANCE-3 ← RGPD complet et AI Act
```

Chaque lot est un prérequis pour le suivant. Aucun lot manipulant des données
personnelles réelles ne doit être fusionné sans que la classification et la
rétention soient couvertes par au moins COMPLIANCE-0.

## 2. COMPLIANCE-0 — Fondation documentaire (en cours)

| Aspect | Détail |
|---|---|
| **Dépendances** | Aucune |
| **Blocant pour** | Lot 2B-2, toute collecte de données personnelles réelles |
| **Livrables** | ADR-0023, `01-classification.md`, `02-retention.md`, `03-register.md`, `04-validation-gates.md`, `05-regulatory-baseline.md`, `06-privacy-architecture.md`, `ICOS_COMPLIANCE_TESTS.md`, `ICOS_COMPLIANCE_ROADMAP.md` |
| **Acceptance** | Tous les documents révisés et approuvés ; gate Compliance décrite et applicable |

## 3. COMPLIANCE-1 — Vérification automatisée et marquage

| Aspect | Détail |
|---|---|
| **Objectif** | Automatiser la vérification de la classification dans le code et la CI |
| **Dépendances** | COMPLIANCE-0 ; C1 (Registre de capacités) |
| **Blocant pour** | Phase D (Orchestration), toute exposition de données C3 via API |
| **Livrables** | |

### 3.1 Marquage des schémas de base

- Ajout de commentaires de colonne `@classification C2/C3` dans le schéma Drizzle.
- Validation CI qui échoue si une colonne de table exposant des données
  personnelles n'est pas marquée.
- Étendre `drizzle/` pour inclure le tag de classification dans les métadonnées
  de migration.

### 3.2 Classification dans le registre de capacités

- Le champ `dataClassification` (C0–C3) est obligatoire sur toute
  `Capability` publiée.
- Une capacité C3 ne peut pas être activée sans politique de rétention associée.
- Validation au moment de l'enregistrement de la capacité.

### 3.3 Vérification automatique des logs

- Scan CI qui vérifie qu'aucune fixture de test, réponse API ou commentaire ne
  contient de secret, token, hash ou mot de passe en clair.
- Pattern matching sur les fichiers modifiés dans la PR.

### 3.4 Acceptance

- CI échoue si une capacité C3 est dépourvue de politique de rétention.
- CI échoue si une colonne C2/C3 est déclarée dans le schéma sans marquage.
- CI échoue si le scan de secrets trouve une correspondance.
- Gate Compliance documentaire (COMPLIANCE-0) reste humaine ; la CI ajoute une
  couche de détection précoce.

## 4. COMPLIANCE-2 — Contrôles techniques

| Aspect | Détail |
|---|---|
| **Objectif** | Implémenter les contrôles techniques de protection des données |
| **Dépendances** | COMPLIANCE-1 ; D1 (Policy Engine) |
| **Blocant pour** | Phase E (Mémoire), Phase G (Intégrations) |
| **Livrables** | |

### 4.1 Chiffrement at-rest pour C3

- Implémenter le chiffrement des colonnes C3 au niveau application (avant
  écriture en base) ou via chiffrement natif PostgreSQL.
- Gestion des clés via un secret store (vault) — ICOS ne stocke pas les clés
  de déchiffrement dans le code ou la base.
- Audit de tout accès à une colonne déchiffrée.

### 4.2 Purge automatique

- Implémenter un worker de purge (cron, scheduler) qui exécute les politiques
  de rétention : suppression ou anonymisation des données expirées.
- Chaque purge est auditée (acteur = `system`, nombre d'entrées purgées,
  politique appliquée).
- Les purges sont testables et réversibles (soft-delete ou archive avant
  hard-delete).

### 4.3 Consentement

- Implémenter le mécanisme de consentement RGPD (Art. 7) :
  - enregistrement du consentement (timestamp, finalité, version) ;
  - retrait du consentement (désactivation du traitement) ;
  - preuve de consentement conservée dans l'audit.
- Utilisé pour les traitements optionnels (recommandations, profiling agent).

### 4.4 Notification de violation

- Workflow de détection et notification :
  - événement `security.breach_detected` dans l'audit ;
  - notification CNIL sous 72h (template, destinataire) ;
  - notification des personnes concernées si risque élevé.

### 4.5 Acceptance

- Les colonnes C3 sont chiffrées au repos.
- Le worker de purge supprime les données expirées et audite l'opération.
- Le mécanisme de consentement enregistre et révoque les consentements.
- Le workflow de violation est documenté et testé.

## 5. COMPLIANCE-3 — Conformité RGPD complète et AI Act

| Aspect | Détail |
|---|---|
| **Objectif** | Atteindre un niveau de conformité complet pour les traitements en production |
| **Dépendances** | COMPLIANCE-2 ; F1 (Contrat conversationnel) ; G1 (Tool Gateway) |
| **Blocant pour** | Production avec utilisateurs réels non internes |
| **Livrables** | |

### 5.1 Mentions d'information (Art. 13-14)

- Rédiger et intégrer les mentions d'information utilisateur :
  - identité et coordonnées du responsable de traitement ;
  - finalités et base légale de chaque traitement ;
  - destinataires des données ;
  - droits des personnes (accès, rectification, effacement, etc.) ;
  - droit de réclamation auprès de la CNIL ;
  - transferts hors UE et garanties appropriées.

### 5.2 DPIA

- Réaliser une DPIA (Analyse d'Impact sur la Protection des Données) pour
  au minimum :
  - le traitement des données des utilisateurs (comptes, préférences) ;
  - la mémoire conversationnelle (Phase E) ;
  - l'orchestration avec envoi de données à des providers IA (D4/G1).

### 5.3 AI Act — obligations de transparence

- Si ICOS est classé en risque limité :
  - mention explicite lors d'une interaction avec un agent IA ;
  - information sur les décisions automatisées (le cas échéant).
- Classification AI Act à réévaluer à chaque nouvelle capacité d'orchestration
  autonome.

### 5.4 Sous-traitance (Art. 28)

- Contrats de sous-traitance signés avec chaque provider traitant des données
  pour le compte d'ICOS :
  - hébergeur (base de données, infrastructure) ;
  - fournisseur IA (via OmniRoute) ;
  - services email, CRM, etc.
- Registre des sous-traitants mis à jour dans le registre des traitements.

### 5.5 DPO

- Désigner un DPO (interne ou externalisé) si ICOS dépasse les seuils
  (traitement à grande échelle de données sensibles, surveillance régulière
  et systématique).

### 5.6 Acceptance

- Les mentions d'information sont accessibles depuis l'interface ICOS.
- La DPIA est approuvée pour les traitements à risque.
- Les contrats de sous-traitance sont signés pour les providers actifs.
- Le DPO est désigné si requis.
- La classification AI Act est documentée et révisée.

## 6. Matrice des dépendances

```text
COMPLIANCE-0
    ↓
COMPLIANCE-1 ← C1 (Capability Registry)
    ↓
COMPLIANCE-2 ← D1 (Policy Engine)
    ↓
COMPLIANCE-3 ← F1, G1, phases à risque
```

| Lot dépendant | Dépend de | Raison |
|---|---|---|
| Lot 2B-2 | COMPLIANCE-0 | Données personnelles dans l'administration humaine |
| C1 | COMPLIANCE-0 | Classification requise pour le registre |
| Phase D (Orchestration) | COMPLIANCE-1 | Vérification automatisée avant exposition de données |
| Phase E (Mémoire) | COMPLIANCE-2 | Chiffrement et purge requis pour la mémoire |
| Phase G (Intégrations) | COMPLIANCE-2 | Contrôles techniques avant transfert externe |
| Production réelle | COMPLIANCE-3 | Conformité complète avant utilisateurs non internes |

## 7. Risques et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| COMPLIANCE-1 retarde la Phase D | Planning | Démarrer COMPLIANCE-1 dès que C1 est stable |
| COMPLIANCE-2 dépend de D1 non livré | Blocage | Prioriser D1 dans la roadmap fonctionnelle |
| COMPLIANCE-3 nécessite DPO externe | Coût | Provisionner budget DPO dès COMPLIANCE-2 |
