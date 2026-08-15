---
name: icos-legacy-reuse
description: Use before building any new ICOS capability that might already exist in some form in SGNG21/holding-ia or SGNG21/Holding-ia-hermes
---

# icos-legacy-reuse

## Objectif

Empêcher deux échecs symétriques : reconstruire depuis zéro une capacité
déjà résolue ailleurs, et importer sans discernement de la dette
architecturale ou des secrets depuis Holding IA. Holding IA est une source
de composants et d'idées à évaluer, **jamais l'architecture cible d'ICOS**.

## Contexte d'utilisation

- Avant de concevoir ou d'implémenter toute nouvelle capacité ICOS
  (approbations, mémoire/RAG, orchestration d'agents, canaux WhatsApp/voix,
  fabrication de sites, qualification de prospects, etc.).
- Avant de décider qu'une capacité doit être construite « from scratch ».
- Lors de la revue d'un composant dont l'équivalent fonctionnel existe dans
  Holding IA.

**Ne doit PAS s'activer** pour trancher une question technique propre à la
compétence spécialisée concernée (couche, sécurité, schéma, mémoire,
orchestration, workflows, MCP) : `icos-legacy-reuse` est une méthode de
recherche préalable, elle ne remplace jamais le jugement de la compétence
spécialisée et ne statue elle-même sur aucun invariant technique ICOS.

## Invariants ICOS

- Toute nouvelle capacité pertinente déclenche une recherche préalable dans
  `SGNG21/holding-ia` (et, à titre de vérification uniquement,
  `SGNG21/Holding-ia-hermes`) avant toute conception. Absence de recherche =
  travail non conforme à cette compétence.
- `Holding-ia-hermes` n'est jamais traité comme une seconde source de vérité
  architecturale : c'est une copie/snapshot du dépôt principal (mêmes SHA
  sur les fichiers clés, historique de commits générique — « Add files via
  upload », « Initial commit » — sans traçabilité fonctionnelle autonome).
  Il peut servir à confirmer un doute, jamais à fonder une décision.
- Aucune implémentation Holding IA n'est fiable par défaut. Chaque élément
  identifié est classé explicitement **REUSE / ADAPT / REBUILD / DISCARD**
  avant toute décision d'usage.
- Le classement repose sur des preuves concrètes, jamais une déclaration :
  chemin de fichier exact, commit, comportement réel observé, preuve
  (ou absence de preuve) de fonctionnement en production.
- Une comparaison coût d'adaptation vs coût de reconstruction est explicite
  avant de choisir ADAPT plutôt que REBUILD — l'économie de temps doit être
  réelle, pas supposée.
- Interdiction absolue de copier : secrets, credentials, tokens, URLs de
  connexion, identifiants historiques, infrastructure legacy (n8n comme
  orchestrateur, Supabase comme état métier), ou dette n8n (webhooks non
  authentifiés, transitions non atomiques, retries aveugles) — même si le
  composant environnant est classé REUSE ou ADAPT.
- Un composant classé REUSE ou ADAPT est réécrit dans le style et les
  invariants ICOS (TypeScript strict, Zod, ports/repositories, migrations
  additives) — jamais copié-collé tel quel depuis Holding IA.
- Holding IA reste un fournisseur de vocabulaire métier, de règles, de
  prompts et de scénarios de test — jamais de runtime, de schéma de base,
  ou d'orchestrateur pour ICOS.

## Ce qu'elle doit vérifier avant d'agir

1. Une recherche dans `SGNG21/holding-ia` a-t-elle été faite pour cette
   capacité avant toute conception ICOS ?
2. Le fonctionnement réel de l'implémentation trouvée a-t-il été inspecté
   (pas seulement son intitulé ou sa présence) ?
3. Existe-t-il une preuve que ce composant a réellement fonctionné en
   production (logs, historique de commits significatif, absence de bug
   confirmé) — ou seulement une déclaration ?
4. Les dépendances et la dette associées (n8n, Supabase, credentials
   embarqués, schéma divergent) ont-elles été mesurées explicitement ?
5. Le classement REUSE/ADAPT/REBUILD/DISCARD est-il justifié par une
   comparaison de coût réelle, pas par défaut ?
6. Un secret, un credential, une URL de connexion ou un identifiant
   provenant de Holding IA est-il sur le point d'être copié ? Si oui,
   arrêt immédiat — jamais acceptable, même en variable d'environnement
   locale de test.
7. Le composant retenu sera-t-il réécrit selon les invariants ICOS
   (`icos-architecture`, `icos-postgresql`, `icos-security`), ou copié tel
   quel ?

## Technologies autorisées

Aucune technologie de Holding IA n'est adoptée par transitivité. Chaque
technologie candidate (ex. pgvector, Temporal, MCP) suit sa propre
compétence ICOS (`icos-rag-memory`, `icos-workflows-temporal`,
`icos-mcp-integrations`) et sa propre validation explicite si elle
introduit une dépendance externe significative.

## Référentiel d'audit (état au moment de la rédaction)

Verdicts issus de l'audit Holding IA → ICOS (24 lignes scorées : REUSE=3,
ADAPT=8, REBUILD=8, DISCARD=5, plus les lignes DISCARD dédiées aux agents
fantômes / infrastructure-comme-agents / Holding-ia-hermes) :

- **REUSE** (logique portable telle quelle, sans dette) : script de backfill
  embeddings (`scripts/backfill-embeddings.js`, commit `b1aa5c1` — sans
  retry/checkpoint, à durcir) ; parseur/fill-agent de brief site
  (`agents/site-fill/build-request.js`, `slots.json`, `validate.js`, commit
  `05747ce`) ; classification des agents réels/infra/fantômes
  (`agents/CLASSIFICATION.md`).
- **ADAPT** (logique/vocabulaire valable, implémentation à refaire) :
  contrat d'approbation (`migrations/005_agent_actions.sql`, commit
  `689551e` — vocabulaire `auto/gate/hard_gate`, mais schéma Supabase
  mutable, aucun événement immuable, aucune idempotence) ; politique
  d'autonomie client (`client_autonomy`, `hard_gate` protégé uniquement
  côté code n8n) ; règle d'expiration (`n8n/action-expire.json` — commentée
  « toutes les 6h », cron réel `0 6 * * *` = une fois par jour, aucun
  événement d'expiration) ; prompts canoniques (`agents/prompts/**`,
  `migrations/006_agent_prompts.sql`, commit `3e46f07` — sans validation de
  schéma, promotion, checksum ni rollback) ; 57 prompts métier sites
  (qualité hétérogène) ; qualification de prospects
  (`n8n/pipeline-prospect-qualification.json`,
  `agence-web-pipeline.json` — deux pipelines qui se chevauchent) ; boutons
  WhatsApp d'approbation (`n8n/action-dispatch.json` — payload Meta Graph
  API correct, limite 3 boutons bien gérée, mais couplé aux variables/numéro
  propriétaire n8n) ; proxy Vercel→n8n (`api/n8n/[...path].js` — nombreux
  correctifs de routage, timeout 60-120s).
- **REBUILD** (concept valable, implémentation non réutilisable en l'état) :
  ingestion Sofia (`n8n/sofia-obsidian-pipeline.json` — credentials
  historiques encore présents dans l'export, upsert ambigu) ; retrieval
  Sofia (`n8n/sofia-search-rag.json`, `functions.sql` — Voyage/1024 vs
  OpenAI/1536, `triggerCount: 0`) ; schéma mémoire (`knowledge_base`,
  `client_memory`, `agent_memory` — divergence de dimension, provenance
  faible) ; IRIS (`n8n/whatsapp-iris.json`,
  `agents/prompts/holding/iris-routeur.md` — routage LLM opaque non
  déterministe, prompt de test divergent du prompt canonique, cite des
  agents inexistants) ; WF-A `action-create.json` (bug de séquencement sur
  `risk_forced`, pas d'authentification webhook, pas de transaction) ;
  WF-B `action-dispatch.json` (un seul nœud stub branché, marque quand même
  `executed`) ; WF-C `action-decision.json` (six routes d'exécution vides,
  jamais branché à WhatsApp) ; orchestration n8n générale (29+ workflows,
  84,4 % de taux d'échec historique constaté, images `latest`,
  `NODE_FUNCTION_ALLOW_BUILTIN=*`, aucune DLQ métier) ; journal/audit actuel
  (`agent_actions`, `agent_messages`, logs n8n — mutable, incomplet, sans
  preuve de causalité ou d'idempotence).
- **DISCARD** (à abandonner) : générateurs de sites n8n en doublon
  (`cloud-generateur-sites.json`, `workflow-generateur-sites.json`) ;
  ancien workflow Sofia (`obsidian-sofia-sync.json` — nœud
  « embedding » qui ne produit aucun vecteur réel) ; agents fantômes (ARNO,
  MEMO, TOKI, VALDO, CODER, etc. — aucune implémentation vérifiable) ;
  composants d'infrastructure présentés comme agents (COCKPIT, SYNC,
  DISCOVERY, PIPELINE, BOARD) ; `Holding-ia-hermes` comme source technique.

## Carte de destination logique (Holding IA → ICOS)

| Domaine Holding IA                           | Destination logique ICOS                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Approbations (`agent_actions`, n8n WF-A/B/C) | `Policies` / `ApprovalRequest` / `Decision` / `ExecutionResult` (icos-security) |
| Mémoire (Sofia, `knowledge_base`)            | Service de connaissance séparé, consommé via Context Port (icos-rag-memory)     |
| Agents (57 prompts, classification)          | Catalogue versionné de capacités (icos-agent-orchestration)                     |
| IRIS (routeur WhatsApp)                      | Command API + routage d'intention déterministe, jamais IRIS comme runtime       |
| Sites (fill-agent, site-starter)             | DigitalOS — hors périmètre runtime ICOS                                         |
| CRM / qualification prospects                | Événements Payload/CRM, scénarios de test                                       |
| WhatsApp/voix                                | Adaptateur de canal Polivia (icos-architecture)                                 |
| Observabilité (logs n8n)                     | Event journal ICOS + projections + DLQ (icos-workflows-temporal)                |
| Workflows n8n eux-mêmes                      | Source de cas d'usage/tests, jamais de code runtime                             |

## Anti-patterns

- Traiter `Holding-ia-hermes` comme une architecture de référence ou une
  seconde vérité technique.
- Copier un composant classé REBUILD ou DISCARD au prétexte qu'il « marche
  déjà en partie ».
- Adopter n8n, Supabase ou IRIS comme fondation d'ICOS — ils portent
  exactement la dette qu'ICOS cherche à éliminer (pas de journal
  transactionnel, transitions non atomiques, branches incomplètes, secrets
  historiques, schémas divergents, preuves d'exécution limitées).
- Choisir REUSE/ADAPT sans avoir mesuré le coût réel d'adaptation face au
  coût de reconstruction.
- Copier un identifiant, un token, ou une URL de connexion présente dans un
  export n8n ou un fichier de migration Holding IA, même « juste pour
  tester localement ».
- Faire remonter des données CRM ou mémoire métier de Holding IA directement
  dans l'état métier ICOS sans passer par un port explicite.
- Déplacer un workflow de fabrication de site (DigitalOS) dans le runtime
  ICOS au lieu de le garder dans son périmètre propre.

## Sécurité

Voir `icos-security`. Risque prioritaire identifié dans l'audit : des
secrets (token GitHub, valeurs Supabase) apparaissent dans l'historique
d'exports n8n de Holding IA — ils ne sont jamais copiés, et leur rotation
doit être vérifiée indépendamment de tout travail ICOS, hors périmètre de
cette compétence.

## Stratégie TDD

- Avant toute implémentation d'un composant classé ADAPT ou REUSE, écrire
  le test qui capture le comportement attendu tel que documenté par
  l'audit (ex. limite 3 boutons WhatsApp, format du payload d'approbation)
  — jamais un test qui rejoue le code Holding IA lui-même.
- Test de non-régression garantissant qu'aucun identifiant/secret de
  Holding IA n'apparaît dans le code ou les fixtures de test ICOS (scan
  explicite si un composant ADAPT est introduit).
- Test comparant le comportement reconstruit à la preuve de fonctionnement
  citée dans l'audit, quand une preuve existe.

## Définition de done

- Toute nouvelle capacité documente la recherche Holding IA effectuée et le
  verdict REUSE/ADAPT/REBUILD/DISCARD retenu, avec justification de coût.
- Aucun secret, credential, ou fragment de code Holding IA n'a été copié.
- Le composant retenu respecte les invariants des autres compétences ICOS
  concernées (`icos-architecture`, `icos-postgresql`, `icos-security`,
  `icos-agent-orchestration`, `icos-rag-memory`, `icos-workflows-temporal`).
- La décision est traçable (mini-ADR ou entrée de design doc) pour toute
  capacité classée REUSE ou ADAPT.
