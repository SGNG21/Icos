# ADR-0023 — Fondation de conformité réglementaire (COMPLIANCE-0)

- Statut : accepté
- Date : 2026-07-24

## Contexte

ICOS est conçu comme un système d'exploitation IA personnel et professionnel, destiné à traiter des
données à caractère personnel dans plusieurs contextes :

- données utilisateur ICOS (comptes, préférences, historique conversationnel, sessions) ;
- données client (nom, email, téléphone, historique commercial, documents, échanges) ;
- données prospect (qualification, échanges, devis) ;
- données d'usage et traces techniques (logs, métriques, événements d'audit) ;
- données agrégées et analytiques (rapports, tableaux de bord, recommandations).

Le Master Plan §18 impose une **gate Compliance** pour tout lot touchant la collecte, la conservation,
la classification ou le transfert de données personnelles ou sensibles. L'invariant de sécurité 14
(§6) exige une **politique de rétention explicite, versionnée et révisable par un humain habilité**.

À ce stade, ICOS n'a ni documentation de conformité structurée, ni classification des données, ni
politique de rétention formalisée, ni registre des traitements. Le risque est de construire des
fonctionnalités de traitement de données sans cadre, ce qui rendrait une mise en conformité ultérieure
coûteuse, voire impossible pour certaines décisions architecturales (chiffrement, isolement, purges).

## Décision

Créer une **fondation documentaire de conformité** structurée dans `docs/compliance/`, indépendante
du code applicatif, qui sert de cadre pour toutes les décisions futures touchant les données.

### 1. Taxonomie de classification des données

Une classification formelle (voir `docs/compliance/01-classification.md`) distingue :

| Niveau | Classe       | Exemples                                                              | Contrôles minimaux                                                                  |
| ------ | ------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| C0     | Publique     | Documentation publique, données agrégées non nominatives              | Aucun                                                                               |
| C1     | Interne      | Logs techniques non personnels, code source, ADR, plans               | Accès contrôlé par rôle ICOS                                                        |
| C2     | Confidentiel | Identifiants techniques (API keys, tokens), secrets, accès infra      | Chiffrement at-rest, accès restreint, jamais dans les logs                          |
| C3     | Restreint    | Données personnelles (email, nom, téléphone, préférences, historique) | Chiffrement at-rest + in-transit, accès nominatif, audit renforcé, retention bornée |

La classification est déclarée par **politique de donnée** attachée à chaque entité, jamais par
inférence. Elle détermine le niveau de retention, de chiffrement et d'accès requis.

### 2. Invariant de rétention gouvernée

Conformément à l'invariant de sécurité 14, toute donnée conservée par ICOS est bornée par une
politique de rétention explicite :

- chaque type de donnée possède une durée de conservation maximale et une base légale (voir
  `docs/compliance/02-retention.md`) ;
- une purge automatique ou semi-automatique est prévue à l'expiration ;
- la politique est versionnée, horodatée et révisable par un humain habilité ;
- aucune donnée n'est conservée « au cas où » sans politique explicite.

### 3. Architecture de vie privée

Les principes architecturaux suivants sont adoptés (détaillés dans `docs/compliance/06-privacy-architecture.md`) :

- **Privacy by Design** : toute fonctionnalité manipulant des données personnelles intègre les
  contrôles de privacy dans sa conception, pas après coup.
- **Data minimisation** : ICOS ne collecte, ne conserve et ne transfère que les données strictement
  nécessaires à la finalité déclarée.
- **Séparation des responsabilités** : les contrôles d'accès sont serveur, pas UI. Aucun secret
  métier (mot de passe, token, hash) ne quitte le périmètre serveur autorisé.
- **Auditabilité** : toute opération sur des données personnelles est tracée dans le journal d'audit
  existant, avec acteur, action, cible, raison et horodatage. Aucune donnée sensible dans les
  détails d'audit.
- **Portabilité** : l'architecture préparera l'export utilisateur de ses données personnelles dans
  un format standard (JSON structuré).
- **Droit à l'effacement** : une fonction de suppression logique ou physique sera prévue, avec
  conservation minimale des traces d'audit pour justification.

### 4. Compliance Gate

La gate Compliance est intégrée au cycle de développement (Master Plan §18) :

- tout lot qui crée, modifie ou supprime une collecte, conservation, classification ou transfert de
  données personnelles ou sensibles doit inclure une revue de conformité avant fusion ;
- la revue vérifie la classification, la rétention, la base légale, les contrôles d'accès et
  l'absence d'exposition dans les audits/réponses ;
- les lots COMPLIANCE-1/2/3 (détaillés dans `ICOS_COMPLIANCE_ROADMAP.md`) ajouteront
  respectivement la vérification automatisée, les contrôles techniques et l'intégration RGPD.

### 5. Registre des traitements

Un registre initial des traitements (voir `docs/compliance/03-register.md`) inventorie :

- les finalités de traitement connues à ce jour ;
- les catégories de données concernées ;
- les bases légales applicables (consentement, contrat, obligation légale, intérêt légitime) ;
- les destinataires et sous-traitants ;
- les durées de conservation ;
- les mesures techniques et organisationnelles mises en œuvre.

### 6. Références réglementaires

Le périmètre réglementaire initial couvre :

- **RGPD (UE) 2016/679** : traitement des données personnelles de résidents UE — principal
  référentiel.
- **ePrivacy Directive 2002/58/CE** : cookies, communications électroniques, suivi.
- **NIS2 Directive (UE) 2022/2555** : cybersécurité des infrastructures critiques — applicable si
  ICOS devient une infrastructure numérique.
- **AI Act (UE) 2024/1689** : classification des systèmes d'IA — pertinent pour les décisions
  automatisées et l'orchestration autonome future.
- **Data Governance Act (UE) 2022/868** : partage de données — pertinent si ICOS joue un rôle
  d'intermédiaire.
- **Loi informatique et libertés (France)** : déclinaison nationale du RGPD.

### 7. Documentation produite

Les documents suivants sont créés dans `docs/compliance/` :

| Document                     | Rôle                                               |
| ---------------------------- | -------------------------------------------------- |
| `01-classification.md`       | Taxonomie des données (C0–C3)                      |
| `02-retention.md`            | Politique de rétention gouvernée (invariant 14)    |
| `03-register.md`             | Registre initial des traitements (Art. 30 RGPD)    |
| `04-validation-gates.md`     | Gate Compliance en PR et points de validation DPO  |
| `05-regulatory-baseline.md`  | Périmètre réglementaire et obligations applicables |
| `06-privacy-architecture.md` | Principes et décisions d'architecture vie privée   |
| `ICOS_COMPLIANCE_TESTS.md`   | Plan de vérification de conformité                 |
| `ICOS_COMPLIANCE_ROADMAP.md` | Roadmap COMPLIANCE-0/1/2/3                         |

## Conséquences

### Positives

- cadre normatif clair pour toutes les décisions futures de traitement de données ;
- gate Compliance applicable dès maintenant sans attendre des développements techniques ;
- registre des traitements et politique de rétention opposables dès la première collecte de données
  personnelles réelles ;
- architecture préparée pour une mise en conformité RGPD complète (COMPLIANCE-3) ;
- lien explicite entre classification, rétention, accès et audit.

### Négatives / Risques

- documentation supplémentaire à maintenir — risque de dérive si elle n'est pas révisée
  périodiquement ;
- certains contrôles (chiffrement, purge automatique) ne seront implémentés que dans COMPLIANCE-1/2 ;
- le registre des traitements initial est partiel — les futures intégrations (Gmail, Drive, Dolibarr,
  Shopify) devront étendre la classification, la rétention et le registre.

### Conformité aux ADR existants

- **ADR-0007** (identité) : la classification C2 (credentials, tokens) renforce l'interdiction déjà
  posée d'exposer des secrets dans les logs/réponses/audits.
- **ADR-0006** (transactions) : la rétention bornée et la purge sont compatibles avec le journal
  d'audit append-only existant — l'audit n'est pas concerné par la purge de données métier.
- **ADR-0005** (PostgreSQL) : le chiffrement at-rest relève de l'infrastructure DB, non du schéma.
  La classification C2+ n'impose pas de changement de schéma dans COMPLIANCE-0.
- **Invariant 14** : formalisé et documenté — toute donnée conservée a une politique de rétention.

## Déclencheur

Ce lot est déclenché par l'architecture decision « Compliance fondation » et sert de prérequis
documentaire à :

- Lot 2B-2 (données personnelles dans l'administration humaine) ;
- Phase B-C-D-E (données dans les registres Capacités/Skills, Mémoire, Orchestrateur) ;
- toute intégration externe qui collecte ou transfère des données personnelles.

## Hors périmètre

- Implémentation technique des contrôles (chiffrement, purge automatique, anonymisation) — relève de
  COMPLIANCE-1/2.
- DPIA complète — sera réalisée quand un traitement à haut risque est planifié.
- DPO externe ou juriste — désignation ultérieure.
- Certification (ISO 27001, SOC 2, etc.) — hors scope produit.
- Cookies et consentement banner — dépend du canal (web, mobile), pas du noyau ICOS.
