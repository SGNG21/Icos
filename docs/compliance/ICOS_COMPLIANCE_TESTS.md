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

| ID | Scenario | Compliance intent | Expected invariant | Target lot | Future automated proof | Current status |
|---|---|---|---|---|---|---|
| 001 | tenant isolation | Un tenant ne peut pas accéder aux données d'un autre tenant. | Isolation multi-tenant | COMPLIANCE-1 | Tests d'intégration multi-tenant avec assertions d'isolation | DOCUMENTED_ONLY |
| 002 | sensitive provider denial | Un provider sans classification adéquate est refusé pour une donnée C3. | ProviderComplianceProfile requis avant envoi | D3 | Test unitaire AiRoutingPolicy avec profil provider incompatible | DOCUMENTED_ONLY |
| 003 | AUTH_SECRET never memory | Les données AUTH_SECRET ne sont jamais stockées en mémoire agent. | AUTH_SECRET exclue de MemoryPort | COMPLIANCE-1 | Test d'intégration MemoryPort : rejet à l'écriture | DOCUMENTED_ONLY |
| 004 | expired data unavailable | Une donnée au-delà de sa durée de rétention n'est plus accessible. | RetentionPolicy respectée à la requête | COMPLIANCE-2 | Test d'intégration purge worker : requête post-purge → 0 résultat | DOCUMENTED_ONLY |
| 005 | significant decision human approval | Une décision significative (risk 4) nécessite approbation humaine. | PolicyEngine bloque risk 4 sans Approval | D1 | Test unitaire PolicyEngine + mock ApprovalPort | DOCUMENTED_ONLY |
| 006 | allowedRegions enforcement | Le transfert de données est restreint aux régions autorisées par politique. | DataTransferPolicy respectée | D3 | Test unitaire AiRoutingPolicy avec contrainte géographique | DOCUMENTED_ONLY |
| 007 | deletion propagation | La suppression d'un enregistrement source propage aux dépendances définies. | Cascade définie pour DataProvenance | COMPLIANCE-2 | Test d'intégration cascade de suppression | DOCUMENTED_ONLY |
| 008 | external transfer audit | Tout transfert de données C3 vers un provider externe est audité. | Auditabilité des transferts externes | G1 | Test d'intégration ExecutionRecord : audit entry créée | DOCUMENTED_ONLY |
| 009 | sensitive action cannot bypass approval | Une action marquée sensible ne peut pas contourner le Policy Engine. | PolicyEngine est incontournable pour actions sensibles | D1 | Test unitaire : appel direct repo vs via Policy | DOCUMENTED_ONLY |
| 010 | app DB role cannot TRUNCATE audit | Le rôle applicatif PostgreSQL ne peut pas TRUNCATE la table d'audit. | Audit append-only garanti par PostgreSQL | COMPLIANCE-1 | Test d'infra : vérification des permissions PostgreSQL | DOCUMENTED_ONLY |
| 011 | cross-tenant IDOR denial | Un identifiant d'un autre tenant ne peut pas être utilisé pour accéder à des données. | Frontière d'isolation Tenant respectée | COMPLIANCE-1 | Test d'intégration : requête cross-tenant → 403/404 | DOCUMENTED_ONLY |
| 012 | provider without approved compliance profile denied | Un provider sans `ProviderComplianceProfile` approuvé est refusé pour toute donnée C2+. | ProviderComplianceProfile requis pour données C2+ | D3 | Test unitaire AiRoutingPolicy + registry lookup | DOCUMENTED_ONLY |
| 013 | memory retention requires explicit policy | La mémoire agent ne peut retenir une donnée sans politique de rétention associée. | RetentionPolicy requise pour MemoryPort | E1 | Test d'intégration MemoryPort : retention policy required | DOCUMENTED_ONLY |
| 014 | deleted source invalidates derived memory | Une mémoire dérivée est invalidée si sa source est supprimée. | DataProvenance respectée dans MemoryPort | E1 | Test d'intégration MemoryPort : cascade d'invalidation | DOCUMENTED_ONLY |
| 015 | observability payload redaction | Les payloads C3 sont automatiquement masqués dans les traces d'observabilité. | Pas de C3 dans l'observabilité technique | COMPLIANCE-1 | Test d'intégration : grep pattern sur payloads exportés | DOCUMENTED_ONLY |
| 016 | purpose mismatch denied | Un traitement sollicité ne correspondant à aucune finalité déclarée est refusé. | ProcessingPurpose vérifié par PolicyEngine | D1 | Test unitaire PolicyEngine avec purpose registry | DOCUMENTED_ONLY |
| 017 | legal hold prevents destructive deletion | Une donnée sous gel (legal hold) ne peut pas être détruite par la purge automatique. | LegalHold suspend RetentionPolicy | COMPLIANCE-2 | Test d'intégration purge worker + legal hold flag | DOCUMENTED_ONLY |
| 018 | connector SEND requires external-effect policy | Un connecteur externe nécessite une policy de type `external_effect` pour envoyer des données. | Effet externe nécessite policy dédiée | G1 | Test unitaire ConnectorGateway + PolicyEngine | DOCUMENTED_ONLY |
| 019 | provider trainingAllowed enforcement | Les données C3 ne sont jamais envoyées à un provider dont `trainingAllowed` est vrai sans consentement explicite. | ProviderComplianceProfile.trainingAllowed respecté | D3 | Test unitaire AiRoutingPolicy avec flag training | DOCUMENTED_ONLY |
| 020 | tenant-scoped export contains no foreign data | L'export des données d'un tenant ne contient aucune donnée d'un autre tenant. | Frontière Tenant respectée à l'export | COMPLIANCE-3 | Test d'intégration export + vérification tenant boundaries | DOCUMENTED_ONLY |
| 021 | consent record | L'enregistrement, la preuve, le retrait et l'effet du retrait du consentement sont tracés et opposables. | ConsentRecord horodaté, append-only, révocable | COMPLIANCE-2 | Test d'intégration ConsentService : création, révocation, audit | DOCUMENTED_ONLY |
| 022 | data portability | L'export JSON des données d'un tenant respecte les frontières et ne contient aucune donnée étrangère. | Tenant boundaries respectées à l'export | COMPLIANCE-3 | Test d'intégration export portability : scope tenant vérifié | DOCUMENTED_ONLY |
| 023 | personal data breach | La détection, qualification, escalade et notification CNIL (72h) d'une violation de données. | Workflow breach actionnable dans les délais | COMPLIANCE-2 | Test d'intégration BreachWorkflow : détection → notification | DOCUMENTED_ONLY |
| 024 | right to erasure | La demande d'effacement est vérifiée, exécutée (soft-delete, purge), propagée aux données dérivées et suspendue si legal hold. | DeletionRequest → vérification → soft-delete → purge | COMPLIANCE-2 | Test d'intégration DeletionService : cycle complet avec legal hold | DOCUMENTED_ONLY |

Les tests documentaires (CT-DOC-*) de COMPLIANCE-0 couvrent la gate humaine en
PR. Les scénarios ci-dessus seront résolus par les tests automatisés des lots
cibles. Chaque lot devra ajouter une entrée dans ce tableau avec le statut de
couverture au moment de sa PR.

## 6. Cycle de vie des tests

- Les tests documentaires (CT-DOC-*) s'appliquent dès COMPLIANCE-0.
- Les tests automatisés (CT-AUTO-*) sont ajoutés au fur et à mesure des lots
  C1, D1, D3, G1.
- La couverture est révisée annuellement.
