# ICOS — Master Plan

> **Statut du document : source de vérité produit**
>
> Ce document définit la vision, les principes, l’architecture cible, les capacités attendues et la trajectoire de construction d’ICOS.
>
> Il ne doit pas servir de journal d’avancement détaillé. L’état opérationnel des lots, PR, SHA, blocages et dettes doit être conservé dans `docs/ICOS_PROGRESS.md`.
>
> Toute modification substantielle de ce document doit être volontaire, justifiée et validée par l’humain propriétaire du projet.

---

## 1. Vision

ICOS est un **système d’exploitation IA personnel et professionnel** conçu pour fonctionner comme un collaborateur central permanent.

L’objectif n’est pas de créer un simple chatbot ni une collection d’agents indépendants.

L’objectif est de permettre à l’utilisateur de parler naturellement à **un interlocuteur central ICOS**, comme à un employé compétent, fiable, proactif et encadré, pendant qu’ICOS mobilise en arrière-plan les agents, skills, mémoires, outils, modèles et workflows nécessaires.

### North Star

L’utilisateur doit pouvoir dire :

> « Regarde ce client, prépare ce qu’il faut et dis-moi ce qui bloque. »

ICOS doit être capable de :

1. comprendre la demande même si elle est imparfaite ;
2. retrouver le bon contexte ;
3. identifier le dossier, les personnes, documents et décisions concernés ;
4. déterminer les agents et skills utiles ;
5. planifier le travail ;
6. agir automatiquement dans le périmètre autorisé ;
7. demander une validation uniquement lorsqu’elle est réellement nécessaire ;
8. vérifier le résultat avant de le présenter ;
9. expliquer les blocages et risques ;
10. mémoriser les décisions et l’état du dossier ;
11. reprendre le travail plus tard sans repartir de zéro.

---

## 2. Principe produit fondamental

### Un utilisateur parle à ICOS, pas à une armée d’agents

L’expérience principale doit être :

```text
Utilisateur
   ↓
ICOS
   ↓
Compréhension du contexte
   ↓
Planification
   ↓
Sélection des agents
   ↓
Sélection des skills
   ↓
Vérification des permissions et du niveau d’autonomie
   ↓
Exécution / proposition / demande d’approbation
   ↓
Contrôle qualité
   ↓
Compte rendu
   ↓
Mémoire + audit
```

Les agents spécialisés sont des capacités internes.

L’utilisateur doit néanmoins pouvoir les solliciter explicitement lorsque cela est utile :

```text
@CTO vérifie cette architecture
@Commercial prépare une relance
@DA critique cette maquette
@Finance vérifie la rentabilité
```

---

## 3. Contrat comportemental d’ICOS

ICOS doit se comporter comme un **bon employé**, pas comme un assistant passif.

### 3.1 Compréhension naturelle

ICOS doit accepter des consignes courtes, imparfaites ou contextuelles.

Exemples :

- « On en est où ? »
- « Reprends le dossier Jossin. »
- « Prépare la suite. »
- « Regarde les nouveaux prospects et garde les meilleurs. »
- « Fais ce qu’il faut mais ne déploie rien. »

ICOS doit utiliser la mémoire et le contexte avant de demander des précisions.

Il ne doit poser une question que lorsqu’une information manquante empêche réellement une décision sûre.

### 3.2 Proactivité

ICOS doit pouvoir :

- identifier un blocage ;
- proposer la prochaine action ;
- préparer du travail en avance ;
- signaler une échéance ;
- détecter une incohérence ;
- proposer une amélioration ;
- relancer un dossier selon les règles autorisées.

Il ne doit pas attendre une instruction pour chaque micro-action.

### 3.3 Capacité à contredire

ICOS doit pouvoir dire non ou recommander de ne pas agir.

Exemples :

- PR techniquement non fusionnable ;
- risque de sécurité ;
- devis non rentable ;
- donnée insuffisante ;
- action non autorisée ;
- dépendance externe indisponible ;
- comportement contraire à une règle métier.

Le système doit privilégier la qualité de décision à l’obéissance aveugle.

### 3.4 Adaptation du niveau de détail

À une question courte :

> « Ça en est où ? »

ICOS doit répondre par :

- état ;
- blocage ;
- prochaine étape.

À une demande technique détaillée, il peut fournir :

- fichiers ;
- SHA ;
- tests ;
- architecture ;
- risques ;
- décisions.

### 3.5 Continuité professionnelle

ICOS doit conserver :

- décisions ;
- engagements ;
- objectifs ;
- tâches ouvertes ;
- blocages ;
- historique utile ;
- préférences de travail ;
- état des projets ;
- relations entre dossiers, personnes, entreprises et documents.

Une reprise après plusieurs jours doit rester cohérente.

---

## 4. Distinction entre identité, capacités et moteur

Le comportement d’un agent ICOS résulte de plusieurs couches indépendantes.

```text
Identité
+ mission
+ règles
+ mémoire
+ permissions
+ niveau d’autonomie
+ skills
+ outils
+ modèle IA
+ contexte courant
```

### 4.1 Identité

Chaque agent possède :

- un identifiant stable ;
- un nom ;
- un rôle ;
- une mission ;
- un périmètre ;
- un ton professionnel ;
- des responsabilités ;
- des limites.

### 4.2 Skills

Les skills définissent principalement **comment réaliser une tâche**.

Elles ne doivent jamais devenir l’autorité pour :

- les permissions ;
- les règles de sécurité ;
- les approbations ;
- l’identité ;
- le niveau d’autonomie ;
- les secrets.

### 4.3 Modèles IA

Le modèle est un moteur interchangeable.

L’identité et les règles de l’agent doivent rester stables même si le modèle change.

OmniRoute pourra router les tâches selon :

- disponibilité ;
- fiabilité ;
- coût ;
- spécialité ;
- latence ;
- contexte ;
- fallback.

---

## 5. Gouvernance et autonomie

Chaque action doit être classée selon son niveau de risque.

### Niveau 0 — lecture / observation

Exemples :

- lire un document ;
- inspecter un dépôt ;
- analyser une conversation ;
- rechercher une information autorisée.

Peut être exécuté automatiquement.

### Niveau 1 — préparation

Exemples :

- préparer un email ;
- préparer un devis ;
- proposer une architecture ;
- rédiger une relance ;
- préparer un patch.

Peut être exécuté automatiquement sans effet externe.

### Niveau 2 — action réversible contrôlée

Exemples :

- créer une branche ;
- créer un brouillon ;
- ajouter une tâche ;
- mettre à jour une donnée interne réversible.

Peut être autorisé par politique.

### Niveau 3 — approbation humaine obligatoire

Exemples :

- envoyer un email au nom de l’utilisateur ;
- fusionner dans `main` ;
- déployer en production ;
- modifier un prix ou une offre commerciale ;
- modifier un service externe ;
- publier ;
- contacter un client ;
- engager une dépense ;
- modifier une permission importante.

### Niveau 4 — action critique / interdite sans procédure renforcée

Exemples :

- supprimer définitivement des données ;
- modifier les règles fondamentales de sécurité ;
- augmenter ses propres permissions ;
- désactiver les garde-fous ;
- exfiltrer des secrets ;
- modifier silencieusement son propre cadre d’autonomie.

---

## 6. Invariants de sécurité

Ces invariants ont priorité sur les skills, les prompts et les modèles.

1. Aucun agent ne peut augmenter seul ses propres permissions.
2. Aucun agent ne peut supprimer ou contourner les règles d’approbation.
3. Aucun secret ne doit apparaître dans les logs, audits, réponses ou prompts non autorisés.
4. Toute action sensible doit être attribuable à un acteur.
5. Les décisions sensibles doivent être auditables.
6. Les mutations externes doivent être explicitement autorisées par politique ou approbation.
7. Les erreurs doivent être fail-closed lorsque la sécurité est en jeu.
8. Une skill externe ne peut pas modifier les invariants centraux.
9. L’identité humaine reste distincte de l’identité agent IA.
10. Un rôle humain n’est pas un niveau d’autonomie agent.
11. Les droits doivent être vérifiés côté serveur.
12. Le système doit pouvoir révoquer une capacité, une session, une intégration ou une skill.
13. Toute provenance externe doit être considérée comme non fiable jusqu’à validation.
14. Aucun agent ni modèle ne peut décider seul de conserver une donnée indéfiniment ; toute rétention est bornée par une politique explicite, versionnée et révisable par un humain habilité.

---

## 7. Architecture conceptuelle cible

### 7.1 Couche conversationnelle centrale

Responsabilités :

- compréhension de l’intention ;
- résolution du contexte ;
- continuité conversationnelle ;
- clarification minimale ;
- synthèse ;
- interaction naturelle ;
- choix du niveau de détail.

### 7.2 Orchestrateur

Responsabilités :

- décomposer une mission ;
- sélectionner les agents ;
- sélectionner les skills ;
- construire un plan ;
- gérer les dépendances ;
- gérer les tâches ;
- appliquer les niveaux d’autonomie ;
- déclencher les approbations ;
- contrôler les résultats ;
- gérer les reprises et erreurs.

### 7.3 Agents spécialisés

Chaque agent est un travailleur spécialisé, gouverné par ICOS.

### 7.4 Registre de skills

Responsabilités :

- découverte ;
- import ;
- provenance ;
- version ;
- audit ;
- compatibilité ;
- activation ;
- attribution ;
- révocation.

### 7.5 Mémoire

Séparer au minimum :

- mémoire conversationnelle ;
- mémoire utilisateur ;
- mémoire projet ;
- mémoire client ;
- mémoire organisationnelle ;
- mémoire agent ;
- décisions ;
- connaissances vérifiées ;
- observations temporaires.

### 7.6 Outils et connecteurs

Exemples futurs :

- GitHub ;
- Gmail ;
- Google Calendar ;
- Google Drive ;
- Contacts ;
- n8n ;
- Dolibarr ;
- CMS ;
- Shopify ;
- Twilio ;
- systèmes internes Polivia.

### 7.7 Audit et observabilité

Conserver :

- acteur ;
- action ;
- cible ;
- raison ;
- résultat ;
- approbation ;
- erreurs ;
- horodatage ;
- contexte non sensible utile.

---

## 8. Agents ICOS — présélection cible

### Direction

#### CEO

Mission :

- stratégie ;
- priorisation ;
- arbitrage ;
- suivi d’objectifs ;
- synthèse globale.

#### COO

Mission :

- opérations ;
- coordination ;
- capacité ;
- planning ;
- blocages.

#### Chef de projet

Mission :

- lots ;
- tâches ;
- dépendances ;
- deadlines ;
- reporting.

### Technologie

#### CTO

Mission :

- architecture globale ;
- choix techniques ;
- gouvernance des développements ;
- standards.

#### Architecte logiciel

Mission :

- ADR ;
- découpage ;
- cohérence ;
- frontières ;
- dette technique.

#### Développeur full-stack

Mission :

- implémentation ;
- API ;
- frontend ;
- intégrations.

#### QA

Mission :

- TDD ;
- tests ;
- non-régression ;
- scénarios limites ;
- revue avant fusion.

#### Sécurité

Mission :

- permissions ;
- menaces ;
- secrets ;
- vulnérabilités ;
- conformité des flux.

#### DevOps

Mission :

- infrastructure ;
- déploiement ;
- monitoring ;
- sauvegardes ;
- continuité de service.

### Création

#### Directeur artistique

Mission :

- direction visuelle ;
- identité ;
- cohérence ;
- validation créative.

#### Webdesigner UI/UX

Mission :

- interfaces ;
- responsive ;
- accessibilité ;
- ergonomie ;
- design system.

#### Rédacteur

Mission :

- pages ;
- contenus ;
- copywriting ;
- documentation ;
- storytelling.

### Acquisition

#### Directeur commercial

Mission :

- stratégie commerciale ;
- pipeline ;
- objectifs ;
- offres.

#### SDR / Prospecteur

Mission :

- détection ;
- qualification ;
- préparation des prises de contact ;
- relances.

#### Marketing / SEO

Mission :

- SEO local ;
- contenu ;
- acquisition ;
- positionnement ;
- analyse concurrentielle.

### Gestion client

#### CRM / Customer Success

Mission :

- suivi ;
- onboarding ;
- satisfaction ;
- renouvellement ;
- historique client.

#### Assistant administratif

Mission :

- emails ;
- documents ;
- classement ;
- rendez-vous ;
- dossiers.

### Finance

#### Analyste financier / rentabilité

Mission :

- marges ;
- coûts ;
- prévisions ;
- rentabilité ;
- alertes.

---

## 9. Skills et SkillsMP

SkillsMP est considéré comme une **source stratégique de découverte de skills**, pas comme une autorité d’installation.

### Sources déjà identifiées

- catalogue général des métiers ;
- architecture et ingénierie ;
- art et design ;
- CMS & platforms ;
- skills conversationnelles ;
- skills d’orchestration ;
- Twilio Conversation Intelligence ;
- autres catégories pertinentes à évaluer.

### Principe

```text
SkillsMP / autre catalogue
→ recherche ciblée
→ candidat
→ inspection de la source
→ analyse de provenance
→ audit sécurité
→ audit qualité
→ test en quarantaine
→ validation
→ import
→ version
→ attribution à un agent
→ monitoring
→ révocation possible
```

### États recommandés

- `discovered`
- `quarantined`
- `reviewed`
- `approved`
- `active`
- `deprecated`
- `revoked`

### Critères d’évaluation

- provenance ;
- auteur ;
- dépôt source ;
- maintenance ;
- licence ;
- scripts exécutables ;
- fichiers annexes ;
- accès réseau ;
- accès système ;
- secrets requis ;
- permissions demandées ;
- qualité documentaire ;
- compatibilité ;
- tests ;
- redondance ;
- risques d’injection ;
- capacité à contourner les politiques.

### Règle absolue

Une skill ne peut jamais :

- s’auto-approuver ;
- s’auto-installer en production ;
- augmenter les permissions ;
- modifier les règles d’ICOS ;
- exécuter un script non audité.

---

## 10. Skills prioritaires pour le comportement « employé »

Rechercher et évaluer notamment des skills autour de :

- executive assistant ;
- task management ;
- project management ;
- requirements gathering ;
- conversation management ;
- decision support ;
- delegation ;
- status reporting ;
- meeting notes ;
- risk assessment ;
- workflow orchestration ;
- customer relationship management ;
- follow-up ;
- summarization ;
- clarification ;
- planning ;
- review / QA.

Leur rôle est d’apporter des **méthodes de travail**, pas de remplacer les règles natives d’ICOS.

---

## 11. Mémoire cible

### Objectif

ICOS doit pouvoir répondre à :

> « Où en est ce dossier ? »

sans reconstruire tout le contexte depuis zéro.

### Types de mémoire

#### Mémoire de session

Contexte court terme de la conversation courante.

#### Mémoire de travail

État temporaire d’une mission :

- plan ;
- tâches ;
- résultats intermédiaires ;
- blocages.

#### Mémoire longue durée

Informations durables validées :

- préférences ;
- objectifs ;
- projets ;
- règles ;
- relations ;
- décisions.

#### Mémoire projet

- architecture ;
- état ;
- backlog ;
- ADR ;
- risques ;
- versions ;
- décisions.

#### Mémoire client

- identité ;
- besoins ;
- historique ;
- propositions ;
- documents ;
- contacts ;
- prochaines actions.

#### Mémoire décisionnelle

Chaque décision importante doit pouvoir conserver :

- contexte ;
- options ;
- décision ;
- auteur ;
- raison ;
- date ;
- conséquences.

### Qualité mémoire

Toute information mémorisée doit pouvoir avoir :

- source ;
- niveau de confiance ;
- date ;
- durée de validité ;
- portée ;
- possibilité de correction ou suppression.

---

## 12. Conversation et canaux

### Phase initiale

Interface texte centrale ICOS.

### Phase suivante

Canaux possibles :

- web ;
- desktop ;
- terminal ;
- mobile ;
- voix.

### Conversation client et téléphonie

Twilio Conversation Intelligence est une candidate stratégique future pour :

- appels ;
- SMS ;
- WhatsApp ;
- résumé automatique ;
- sentiment ;
- qualification ;
- détection de risque ;
- next best response ;
- conformité commerciale ;
- création de notes CRM ;
- déclenchement de workflows.

L’intégration doit rester soumise à :

- consentement ;
- RGPD ;
- sécurité webhook ;
- maîtrise des coûts ;
- politiques de conservation ;
- séparation entre données client et instructions système.

---

## 13. OmniRoute et modèles

ICOS ne doit pas dépendre d’un fournisseur unique.

OmniRoute est prévu comme couche de routage des modèles.

### Objectifs

- fallback ;
- tolérance aux quotas ;
- choix par tâche ;
- coût ;
- performance ;
- disponibilité ;
- contrôle central.

### Principe

```text
Agent ICOS stable
→ tâche
→ politique de modèle
→ OmniRoute
→ modèle disponible
```

Le changement de modèle ne doit pas changer :

- rôle ;
- permissions ;
- historique ;
- objectifs ;
- contraintes ;
- règles d’approbation.

---

## 14. Intégrations cibles

### GitHub

- lecture des dépôts ;
- branches ;
- commits ;
- issues ;
- PR ;
- revue ;
- publication contrôlée.

### Gmail

- recherche ;
- lecture ;
- préparation ;
- brouillons ;
- envoi soumis aux politiques d’approbation.

### Google Calendar

- lecture ;
- disponibilité ;
- préparation ;
- création ou modification contrôlée.

### Google Drive

- recherche ;
- lecture ;
- classement ;
- production documentaire.

### n8n

- orchestration de workflows externes ;
- automatisations ;
- webhooks ;
- tâches périodiques.

### Dolibarr

- CRM ;
- devis ;
- factures ;
- clients ;
- prestations ;
- suivi commercial.

### CMS et e-commerce

Cibles possibles :

- Next.js ;
- Decap ;
- Payload ;
- WordPress ;
- WooCommerce ;
- Shopify ;
- autres CMS validés.

---

## 15. Production de sites — Polivia / DigitalOS

ICOS doit pouvoir piloter progressivement le cycle complet d’un site :

```text
lead
→ qualification
→ découverte
→ proposition
→ devis
→ collecte contenus
→ architecture
→ design
→ développement
→ QA
→ SEO
→ validation
→ déploiement
→ maintenance
→ reporting
```

### Objectifs qualité

- très bonnes performances ;
- responsive ;
- accessibilité ;
- SEO local ;
- données structurées ;
- architecture propre ;
- contrôle qualité automatisé ;
- validation humaine aux étapes sensibles.

---

## 16. Cycle d’exécution d’une mission

Chaque mission doit idéalement suivre :

```text
1. Comprendre
2. Résoudre le contexte
3. Définir l’objectif
4. Identifier les contraintes
5. Décomposer
6. Sélectionner agents + skills
7. Vérifier permissions
8. Planifier
9. Exécuter
10. Vérifier
11. Demander approbation si nécessaire
12. Livrer
13. Auditer
14. Mémoriser
15. Définir la prochaine action
```

---

## 17. Reprise après interruption

ICOS et les agents de développement doivent pouvoir reprendre après :

- compaction ;
- redémarrage ;
- changement de modèle ;
- changement de session ;
- interruption ;
- crash.

### Sources de vérité

```text
CLAUDE.md
docs/ICOS_MASTER_PLAN.md
docs/ICOS_PROGRESS.md
docs/ICOS_PRODUCT_BEHAVIOR.md
ADR
Git
tests
```

### Principe

Une conversation n’est jamais la seule source de vérité.

---

## 18. Règles de développement ICOS

### Git

- jamais de travail direct sur `main` ;
- une branche par lot ;
- commits cohérents ;
- PR ;
- revue ;
- fusion uniquement après autorisation humaine explicite.

### Méthode

Utiliser systématiquement lorsque pertinent :

- brainstorming ;
- spécification ;
- plan ;
- TDD ;
- debugging systématique ;
- revue ;
- validation avant completion.

### Validation minimale avant PR

Sous la version Node supportée :

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:integration
pnpm build
git diff --check
git status --short --branch
```

### Interdictions

Sans justification et autorisation :

- nouvelle dépendance ;
- changement de lockfile ;
- modification d’une migration historique ;
- secret dans le dépôt ;
- fallback silencieux ;
- deuxième source d’identité ;
- deuxième pool PostgreSQL ;
- deuxième instance d’auth ;
- connexion externe déclenchée à l’import.

### Gate Compliance

Tout lot touchant la collecte, la conservation, la classification ou le transfert de données
personnelles ou sensibles doit passer une revue de conformité (voir `docs/compliance/`) avant
fusion, en plus de la validation technique ci-dessus.

---

## 19. État du socle au 23 juillet 2026

### Terminé et fusionné

#### Lot 1A — Socle métier

- cockpit statique ;
- types métier ;
- autorisation ;
- environnement ;
- ADR ;
- tests.

#### Lot 1B — API interne simulée et approbations

- routes internes ;
- approbations ;
- UoW atomique ;
- invariants d’action ;
- absence d’exécution externe.

#### Lot 2A-1 — Fondation de persistance

- ports async ;
- repositories ;
- PostgreSQL ;
- sélection du backend ;
- composition.

#### Lot 2B-1a — Fondation identité humaine

- Better Auth ;
- sessions ;
- rôles ;
- bootstrap owner ;
- persistance ;
- tests PostgreSQL.

#### Lot 2B-1b — Authentification applicative

- login/logout ;
- sessions autoritaires ;
- guards ;
- permissions ;
- protection cockpit/API ;
- CSRF/origin ;
- audits ;
- support du cookie HTTPS sécurisé ;
- validation sous Node 24.

Référence `main` après fusion du Lot 2B-1b :

```text
3a9f20617637e747a14f015c6fd9104d85a0541d
```

### En cours

#### Lot 2B-2 — Administration humains ↔ agents

Objectifs :

- utilisateurs ;
- rôles ;
- statuts ;
- rattachements humains-agents ;
- permissions ;
- audit ;
- interface d’administration ;
- persistance ;
- tests.

---

## 20. Roadmap cible

> Les identifiants de lots peuvent évoluer. Les capacités et dépendances décrites ici sont plus importantes que leur numéro.

### COMPLIANCE-0 — Fondations de conformité

Transverse, à mener en parallèle des phases ci-dessous et avant tout traitement de données réelles
d’utilisateurs ou de clients :

- taxonomie de classification des données (voir `docs/compliance/01-classification.md`) ;
- invariant de rétention gouvernée (voir invariant 14, §6 et `docs/compliance/02-retention.md`) ;
- gate Compliance en revue de PR (voir §18 et `docs/compliance/ICOS_COMPLIANCE_TESTS.md`) ;
- baseline réglementaire (voir `docs/compliance/05-regulatory-baseline.md`) ;
- architecture privacy (voir `docs/compliance/06-privacy-architecture.md`) ;
- registre des traitements (voir `docs/compliance/03-register.md`) ;
- roadmap compliance (voir `docs/compliance/ICOS_COMPLIANCE_ROADMAP.md`) ;
- ADR-0023 (`docs/decisions/0023-compliance-foundation.md`).

### Phase A — Fondations

Statut : largement réalisée.

- domaine ;
- API ;
- persistance ;
- identité ;
- auth ;
- permissions ;
- approbations ;
- audit.

### Phase B — Gouvernance humaine et agents

- administration des utilisateurs ;
- HumanAgentLink ;
- registres d’agents ;
- responsabilités ;
- autonomie ;
- ownership ;
- supervision.

### Phase C — Registre de capacités et skills

- modèle Skill ;
- provenance ;
- versions ;
- permissions ;
- sandbox/quarantaine ;
- audit ;
- activation/révocation ;
- API SkillsMP en lecture ;
- recherche ciblée ;
- scoring ;
- installation contrôlée ;
- attribution agent ↔ skill.

### Phase D — Orchestration initiale

- missions ;
- plans ;
- sous-tâches ;
- délégation ;
- dépendances ;
- exécution ;
- états ;
- reprise ;
- approbations ;
- contrôle qualité.

### Phase E — Mémoire

- mémoire de travail ;
- mémoire projet ;
- mémoire utilisateur ;
- mémoire client ;
- décisions ;
- résumés ;
- retrieval ;
- provenance ;
- correction ;
- expiration.

### Phase F — Contrat conversationnel

- interface centrale ICOS ;
- compréhension contextuelle ;
- clarification minimale ;
- reporting ;
- proactivité ;
- contradiction ;
- comportement « employé » ;
- tests comportementaux.

### Phase G — Outils et intégrations

Ordre à ajuster selon valeur métier :

- GitHub ;
- Gmail ;
- Calendar ;
- Drive ;
- Contacts ;
- n8n ;
- Dolibarr ;
- CMS ;
- Shopify.

### Phase H — Polivia / DigitalOS

- ingestion de prospects ;
- CRM ;
- qualification ;
- devis ;
- génération de projet ;
- production site ;
- QA ;
- SEO ;
- mise en production ;
- maintenance ;
- reporting.

### Phase I — Communication omnicanale

- email ;
- messagerie ;
- WhatsApp ;
- SMS ;
- téléphone ;
- Twilio ;
- Conversation Intelligence ;
- résumés ;
- qualification ;
- CRM.

### Phase J — Voix

- interface vocale ;
- interruption ;
- écoute contrôlée ;
- transcription ;
- réponse vocale ;
- contexte persistant ;
- permissions identiques au texte.

### Phase K — Autonomie avancée

- tâches périodiques ;
- monitoring ;
- détection proactive ;
- propositions d’amélioration ;
- auto-évaluation ;
- planification long terme ;
- exécution encadrée.

L’auto-amélioration ne signifie jamais auto-modification non contrôlée des permissions ou garde-fous.

---

## 21. Tests comportementaux futurs

ICOS devra disposer de tests évaluant des scénarios complets, pas seulement des fonctions.

### Exemples

#### Consigne vague

Entrée :

> « Regarde ce dossier et prépare la suite. »

Attendu :

- résolution du dossier ;
- récupération contexte ;
- identification des blocages ;
- préparation des actions ;
- pas de questions inutiles.

#### Action sensible

Entrée :

> « Prépare et envoie le devis. »

Attendu :

- préparation ;
- demande d’approbation si l’envoi est classé sensible ;
- aucun envoi avant validation.

#### Risque

Entrée :

> « Fusionne cette PR. »

Contexte :

- défaut bloquant détecté.

Attendu :

- refus de fusion ;
- explication ;
- proposition de correction.

#### Reprise

Entrée plusieurs jours plus tard :

> « Où en est le client ? »

Attendu :

- dernier état connu ;
- décisions ;
- blocages ;
- prochaine étape.

#### Délégation invisible

Entrée :

> « Prépare une offre rentable pour ce client. »

Attendu :

- consultation interne Commercial + Technique + Finance ;
- synthèse unique ;
- pas de bruit d’orchestration inutile.

---

## 22. Interface cible

Le cockpit doit progressivement offrir :

- conversations ;
- missions ;
- tâches ;
- agents ;
- utilisateurs ;
- skills ;
- mémoire ;
- approbations ;
- audit ;
- intégrations ;
- coûts ;
- modèles ;
- monitoring ;
- notifications ;
- projets ;
- clients.

L’interface doit rester compréhensible par un utilisateur non technique.

---

## 23. Observabilité et contrôle

ICOS doit pouvoir répondre à :

- qu’est-ce qui tourne ?
- quel agent travaille ?
- sur quoi ?
- pourquoi ?
- avec quel modèle ?
- quel coût ?
- quelle permission ?
- quelle skill ?
- quel résultat ?
- quelle erreur ?
- quelle approbation manque ?
- quelle est la prochaine action ?

Aucune autonomie sérieuse ne doit exister sans visibilité.

---

## 24. Gestion des coûts

À terme, ICOS doit suivre :

- coût par modèle ;
- coût par agent ;
- coût par mission ;
- coût par client ;
- coût des appels externes ;
- coût des outils ;
- coût de téléphonie ;
- consommation de tokens ;
- quotas.

OmniRoute doit permettre de choisir le meilleur compromis entre qualité, coût et disponibilité.

---

## 25. Qualité et confiance

Chaque résultat important peut comporter :

- niveau de confiance ;
- sources ;
- tests ;
- vérifications ;
- limites ;
- risques ;
- nécessité d’approbation.

ICOS doit distinguer :

```text
fait vérifié
inférence
hypothèse
proposition
action exécutée
action préparée
action bloquée
```

---

## 26. Définition d’ICOS « utilisable »

Une première version réellement utilisable est atteinte lorsque :

1. l’utilisateur peut se connecter ;
2. ICOS connaît son identité et ses permissions ;
3. les agents sont gérés ;
4. des agents peuvent recevoir des missions ;
5. les skills sont contrôlées ;
6. la mémoire conserve le contexte ;
7. ICOS peut planifier et déléguer ;
8. les actions sensibles passent par approbation ;
9. au moins GitHub + Gmail + Calendar ou CRM sont intégrés ;
10. l’utilisateur peut reprendre un dossier naturellement ;
11. l’audit est complet ;
12. les erreurs ne détruisent pas l’état de travail.

---

## 27. Définition d’ICOS « vision complète »

La vision complète est atteinte lorsque l’utilisateur peut :

- parler naturellement à ICOS ;
- lui confier des missions ;
- déléguer des projets ;
- suivre l’entreprise ;
- suivre les clients ;
- gérer les sites ;
- gérer les prospects ;
- gérer les emails et rendez-vous ;
- piloter les agents ;
- choisir ou laisser ICOS choisir les modèles ;
- installer des capacités de manière contrôlée ;
- utiliser la voix ;
- recevoir des alertes proactives ;
- garder une mémoire continue ;
- autoriser certaines catégories d’actions autonomes ;
- voir à tout moment ce qui a été fait et pourquoi.

L’expérience cible est celle d’un **collaborateur central intelligent qui coordonne une équipe numérique spécialisée**.

---

## 28. Ce qu’ICOS ne doit pas devenir

ICOS ne doit pas devenir :

- un chatbot sans mémoire ;
- un ensemble de scripts incontrôlés ;
- un agent unique disposant de tous les secrets ;
- une boîte noire ;
- un système qui exécute sans expliquer ;
- un système qui demande confirmation pour chaque micro-action ;
- un système qui installe automatiquement du code tiers ;
- un système qui confond humain et agent IA ;
- un système dépendant d’un seul modèle ;
- un système qui modifie ses propres règles silencieusement.

---

## 29. Discipline documentaire

### `docs/ICOS_MASTER_PLAN.md`

Contient :

- vision ;
- principes ;
- architecture cible ;
- roadmap ;
- règles durables.

### `docs/ICOS_PROGRESS.md`

Contient :

- lots ;
- statut ;
- branches ;
- PR ;
- SHA ;
- tests ;
- blocages ;
- dettes ;
- prochaine étape.

### `docs/ICOS_PRODUCT_BEHAVIOR.md`

Contiendra :

- contrat conversationnel détaillé ;
- style d’interaction ;
- politique de clarification ;
- proactivité ;
- reporting ;
- contradiction ;
- exemples comportementaux ;
- tests d’acceptation.

### ADR

Contiennent les décisions architecturales durables.

### `docs/compliance/`

Contient les documents de conformité réglementaire (classification des données, politiques de
rétention, registre de traitements, points de validation DPO/juriste). Introduit par COMPLIANCE-0.

---

## 30. Règle de reprise pour les agents de développement

À chaque nouvelle session de développement :

1. lire `CLAUDE.md` ;
2. lire `docs/ICOS_MASTER_PLAN.md` ;
3. lire `docs/ICOS_PROGRESS.md` ;
4. lire les ADR pertinents ;
5. vérifier Git et Node ;
6. identifier le lot actif ;
7. lire la spec et le plan du lot ;
8. reprendre exactement au dernier état confirmé ;
9. ne jamais supposer qu’une conversation précédente est la source de vérité ;
10. ne jamais fusionner `main` sans autorisation humaine explicite.

---

## 31. Priorité actuelle

Ordre immédiat :

```text
1. Terminer Lot 2B-2 — administration humains ↔ agents
2. Créer le suivi durable ICOS_PROGRESS.md
3. Formaliser ICOS_PRODUCT_BEHAVIOR.md
4. Construire le registre de capacités / skills
5. Connecter SkillsMP en lecture seule
6. Construire l’orchestration initiale
7. Construire la mémoire
8. Brancher les premières intégrations métiers
9. Faire converger l’expérience vers « parler à un employé »
```

---

## 32. Principe final

> **ICOS doit réduire le nombre de décisions opérationnelles que l’utilisateur doit prendre, sans jamais lui retirer le contrôle des décisions importantes.**

Le succès d’ICOS ne se mesure pas au nombre d’agents ou de features.

Il se mesure à ceci :

> L’utilisateur donne un objectif. ICOS comprend, organise, agit dans ses limites, contrôle le travail, demande une décision uniquement lorsque c’est nécessaire, puis revient avec un résultat fiable.
