# ICOS Compliance Tests

| Statut   | Version |
|----------|---------|
| Projet   | 0.1     |

## 1. Objectif

Définir les tests de conformité qui valident le respect des invariants de
sécurité et des obligations réglementaires ICOS. Ces tests sont exécutés dans
la CI et lors de la gate Compliance avant fusion de tout lot touchant des
données classifiées.

## 2. Tests documentaires — vérification humaine en PR

Chaque PR soumise à la gate Compliance (critères au §4) doit passer les
vérifications documentaires suivantes, attestées par un relecteur :

| ID | Vérification | Référence |
|---|---|---|
| CT-DOC-01 | La classification des données manipulées par le lot est déclarée dans la PR. | `01-classification.md` |
| CT-DOC-02 | Aucune donnée C3 n'est introduite sans base légale documentée dans le registre des traitements. | `05-regulatory-baseline.md` |
| CT-DOC-03 | Aucune donnée de catégorie spéciale (art. 9 RGPD) n'est introduite. | `01-classification.md` §2.2 |
| CT-DOC-04 | Les durées de rétention des nouvelles données sont documentées et bornées. | `02-retention.md` |
| CT-DOC-05 | Les colonnes/base de données nouvelles sont marquées de leur classification. | §3 de la classification |
| CT-DOC-06 | Aucun secret ni token n'apparaît dans les logs, réponses API ou commentaires. | Invariant 3, §6 Master Plan |

## 3. Tests automatisés — à implémenter

Les tests suivants seront automatisés dans les lots C1 (Registre de capacités)
et D1 (Policy Engine). Ils sont spécifiés ici pour traçabilité.

### 3.1 Tests de classification

| ID | Test | Critère de succès |
|---|---|---|
| CT-AUTO-01 | Toute capacité enregistrée porte un champ `classification` valide (C0-C3). | `classification ∈ {C0, C1, C2, C3}` |
| CT-AUTO-02 | Une capacité marquée C3 ne peut pas être publiée sans politique de rétention associée. | Erreur de validation |
| CT-AUTO-03 | Une tentative de reclassification non audité est rejetée. | Erreur d'autorisation |

### 3.2 Tests de rétention

| ID | Test | Critère de succès |
|---|---|---|
| CT-AUTO-04 | Toute donnée C3 a une date d'expiration ou de révision de rétention. | Champ `retentionUntil` ou `nextReview` non nul |
| CT-AUTO-05 | Une requête de purge est loggée et exécutée dans le délai spécifié. | Audit entry + donnée supprimée |

### 3.3 Tests d'audit

| ID | Test | Critère de succès |
|---|---|---|
| CT-AUTO-06 | Toute action sur une donnée C3 est enregistrée dans l'Event Journal. | `audit_entries` non vide |
| CT-AUTO-07 | L'Event Journal est append-only ; une modification ou suppression est impossible. | Vérification de contrainte ou de permissions |
| CT-AUTO-08 | Aucune donnée C3 n'apparaît dans les logs techniques. | Grep pattern sur logs de test |

### 3.4 Tests d'accès

| ID | Test | Critère de succès |
|---|---|---|
| CT-AUTO-09 | Une route exposant des données C3 requiert une authentification. | 401 sans token |
| CT-AUTO-10 | Une route exposant des données C3 requiert une autorisation spécifique. | 403 avec token sans permission |

## 4. Déclencheurs de la gate Compliance

La gate Compliance s'applique à tout lot qui :

1. Introduit une nouvelle table, colonne ou champ contenant ou pouvant contenir
   des données C2 ou C3.
2. Expose une nouvelle route API qui lit, écrit ou transfère des données C2/C3.
3. Modifie la politique de rétention existante.
4. Ajoute ou modifie un connecteur externe (provider IA, webhook, intégration).

Ces critères sont vérifiés par le relecteur de PR ; la gate est franchie
lorsque tous les tests CT-DOC-01 à CT-DOC-06 sont verts.

## 5. Compliance Scenario Traceability

Les scénarios de conformité ci-dessous couvrent l'ensemble des invariants
attendus d'ICOS. Aucun n'est implémenté dans COMPLIANCE-0 ; cette section
assure la traçabilité entre chaque scénario et le lot cible qui l'implémentera.

| ID | Scenario | Compliance intent | Target lot | Future automated proof |
|---|---|---|---|---|
| 001 | tenant isolation | Un tenant ne peut pas accéder aux données d'un autre tenant. | COMPLIANCE-1 | Tests d'intégration multi-tenant avec assertions d'isolation |
| 002 | sensitive provider denial | Un provider sans classification adéquate est refusé pour une donnée C3. | D3 | Test unitaire AiRoutingPolicy avec profil provider incompatible |
| 003 | AUTH_SECRET never memory | Les données AUTH_SECRET ne sont jamais stockées en mémoire agent. | COMPLIANCE-1 | Test d'intégration MemoryPort : rejet à l'écriture |
| 004 | expired data unavailable | Une donnée au-delà de sa durée de rétention n'est plus accessible. | COMPLIANCE-2 | Test d'intégration purge worker : requête post-purge → 0 résultat |
| 005 | significant decision human approval | Une décision significative (risk 4) nécessite approbation humaine. | D1 | Test unitaire PolicyEngine + mock ApprovalPort |
| 006 | allowedRegions enforcement | Le transfert de données est restreint aux régions autorisées par politique. | D3 | Test unitaire AiRoutingPolicy avec contrainte géographique |
| 007 | deletion propagation | La suppression d'un enregistrement source propage aux dépendances définies. | COMPLIANCE-2 | Test d'intégration cascade de suppression |
| 008 | external transfer audit | Tout transfert de données C3 vers un provider externe est audité. | G1 | Test d'intégration ExecutionRecord : audit entry créée |
| 009 | sensitive action cannot bypass approval | Une action marquée sensible ne peut pas contourner le Policy Engine. | D1 | Test unitaire : appel direct repo vs via Policy |
| 010 | app DB role cannot TRUNCATE audit | Le rôle applicatif PostgreSQL ne peut pas TRUNCATE la table d'audit. | COMPLIANCE-1 | Test d'infra : vérification des permissions PostgreSQL |
| 011 | cross-tenant IDOR denial | Un identifiant d'un autre tenant ne peut pas être utilisé pour accéder à des données. | COMPLIANCE-1 | Test d'intégration : requête cross-tenant → 403/404 |
| 012 | provider without approved compliance profile denied | Un provider sans `ProviderComplianceProfile` approuvé est refusé pour toute donnée C2+. | D3 | Test unitaire AiRoutingPolicy + registry lookup |
| 013 | memory retention requires explicit policy | La mémoire agent ne peut retenir une donnée sans politique de rétention associée. | E1 | Test d'intégration MemoryPort : retention policy required |
| 014 | deleted source invalidates derived memory | Une mémoire dérivée est invalidée si sa source est supprimée. | E1 | Test d'intégration MemoryPort : cascade d'invalidation |
| 015 | observability payload redaction | Les payloads C3 sont automatiquement masqués dans les traces d'observabilité. | COMPLIANCE-1 | Test d'intégration : grep pattern sur payloads exportés |
| 016 | purpose mismatch denied | Un traitement sollicité ne correspondant à aucune finalité déclarée est refusé. | D1 | Test unitaire PolicyEngine avec purpose registry |
| 017 | legal hold prevents destructive deletion | Une donnée sous gel (legal hold) ne peut pas être détruite par la purge automatique. | COMPLIANCE-2 | Test d'intégration purge worker + legal hold flag |
| 018 | connector SEND requires external-effect policy | Un connecteur externe nécessite une policy de type `external_effect` pour envoyer des données. | G1 | Test unitaire ConnectorGateway + PolicyEngine |
| 019 | provider trainingAllowed enforcement | Les données C3 ne sont jamais envoyées à un provider dont `trainingAllowed` est vrai sans consentement explicite. | D3 | Test unitaire AiRoutingPolicy avec flag training |
| 020 | tenant-scoped export contains no foreign data | L'export des données d'un tenant ne contient aucune donnée d'un autre tenant. | COMPLIANCE-3 | Test d'intégration export + vérification tenant boundaries |

Les tests documentaires (CT-DOC-*) de COMPLIANCE-0 couvrent la gate humaine en
PR. Les scénarios ci-dessus seront résolus par les tests automatisés des lots
cibles. Chaque lot devra ajouter une entrée dans ce tableau avec le statut de
couverture au moment de sa PR.

## 6. Cycle de vie des tests

- Les tests documentaires (CT-DOC-*) s'appliquent dès COMPLIANCE-0.
- Les tests automatisés (CT-AUTO-*) sont ajoutés au fur et à mesure des lots
  C1, D1, D3, G1.
- La couverture est révisée annuellement.
