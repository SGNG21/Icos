# Séquence recommandée des futurs lots

> Cette séquence commence **après** les fondations fusionnées. Les lots COMPLIANCE-0/1/2/3 sont
> transverses et menés en parallèle ; leurs dépendances sont indiquées dans la table. Le Lot 2B-2
> est un prérequis externe en cours. Les identifiants proposés servent au cadrage ; ils ne remplacent
> pas la numérotation officielle tant que celle-ci n'est pas validée dans `ICOS_PROGRESS.md`.

## 1. Vue synthétique

| Ordre | Lot proposé | Phase Master Plan | Résultat principal | Dépendances |
|---:|---|---|---|---|
| transverse | CMP-0 — Compliance Foundation | Transverse | Classification, rétention, registre, gate | Aucune ; prérequis doc. pour 2B-2 |
| transverse | CMP-1 — Automated Compliance Checks | Transverse | Marquage des schémas, CI classification | CMP-0, C1 |
| transverse | CMP-2 — Technical Controls | Transverse | Chiffrement C3, purge auto, consentement | CMP-1, D1 |
| transverse | CMP-3 — Full RGPD & AI Act | Transverse | DPIA, mentions, sous-traitance, DPO | CMP-2, F1, G1 |
| 0 | Lot 2B-2 — User-Agent Administration | B | Liens humain↔agent gouvernés | En cours ailleurs ; CMP-0 requis |
| 1 | C1 — Capability Registry | C | Vocabulaire versionné `Capability` | 2B-2 non strict pour le stockage, requis avant usage orchestré |
| 2 | C2 — Skill Registry & Trust Lifecycle | C | Skills avec provenance, trust, états et activation humaine | C1 |
| 3 | D1 — Policy/Approval Engine v2 | D | Risque 0-4, policy versionnée, preview, décision CAS | Fondations existantes, C1 |
| parallèle après C2 | C3 — SkillsMP Discovery (read-only) | C | Import de candidats en quarantaine, jamais activation directe | C2 ; non bloquant pour D1-D4 |
| 4 | D2 — Mission, Plan, Run & Event Journal | D | État durable et stoppable de l'orchestration | D1 |
| 5 | D3 — AI Gateway / OmniRoute Business Layer | D | AiGatewayPort + contraintes métier + adapter + corrélation usage | C1, D1, D2 |
| 6 | D4 — Orchestrateur v1 | D | Mission → plan → agents/skills → résultats, sans effet externe direct | C2, D1-D3 |
| 8 | Q1 — Behavioral/Eval Harness | D/F | Tests de comportement et évaluations versionnées | D4 |
| 9 | E1 — Memory/Context Port + provenance | E | Mémoire non-authoritative, corrigeable et scoped | D2 |
| 10 | E2 — Ingestion + PostgreSQL FTS | E | Retrieval lexical avec chunks/provenance | E1 |
| 11 | F1 — Contract Conversationnel v1 | F | Intention, clarification minimale, continuité | D4, E1 recommandé |
| 12 | G1 — Tool/MCP Gateway + ExecutionRecord | G | Policy/approval/idempotence juste avant effet | D1, D2, D4 |
| 13 | G2 — Premier connecteur métier | G | Une intégration réelle, désactivée par défaut | G1 |
| 14 | M1 — Premier ICOS semi-autonome | D-G | Scénario Dupont bout en bout | Q1, F1, G2 |
| 15 | R1 — AI Business Routing Policy & Usage | G | Overlay abonnement/budget + UsageLedger métier + AiRoutingPolicy | D3 + usage réel |
| 16 | R2 — OmniRoute Operational Projections | G | Exploitation health/quota/latence/explanations d'OmniRoute | R1 |
| 17 | P1 — Proactivity Engine + Heartbeat | E/F | Réévaluation périodique gouvernée | D2, D4, D1 |
| 18 | S1 — Persistent Scheduler | E/F | Déclenchements durables simples | P1 |
| 19 | Q2 — Skill Discovery from Traces | K préparatoire | `SkillCandidate` → evidence → eval → review → approval | Q1, traces, C2 |
| 20 | R3 — Eval-based Model Routing | K préparatoire | Routage fondé sur qualité observée | R2, Q1, EvaluationStore |
| 21 | E3 — Hybrid Retrieval (pgvector si justifié) | E | Retrieval lexical+sémantique mesuré | E2 + benchmark |
| 22 | H1+ — DigitalOS/Polivia vertical slices | H | Pipelines métier par tranches | M1 |
| 23 | I1 — Channel Adapter Contract | I | Commandes/résultats canal-agnostiques | F1, G1 |
| 24 | I2+ — WhatsApp/Telegram adapters | I | Canaux sans logique d'autorité propre | I1 |
| 25 | J1 — Voice Adapter | J | Voix comme adapter seulement | I1, consentement/retention ADR |
| 26 | K1 — Advanced Autonomy | K | Auto-amélioration gouvernée, jamais auto-permission | Q2, R3, P1 |
| 27 | E2 — Browser Capability | E | BrowserPort + BrowserUseAdapter + risk/action classification | M1, policy étendue |
| 28 | E3 — Development Capability | E | DevelopmentGateway + OpenHandsAdapter + repo/guardrails | M1, D4, policy étendue |
| 29 | E4 — Sandbox Capability | E | SandboxPort + Docker/E2B adapters + sélection risque/coût | M1, policy étendue |
| 30 | E5 — Observability IA | E | ObservabilityPort + LangfuseAdapter + tracing/evals token/cost | M1, traces techniques |
| conditionnel | T1 — Temporal Durable Workflows | H+ | Sagas/reprises longues si besoin démontré | D2, S1 insuffisant empiriquement |
| conditionnel | E4 — Knowledge Graph | H+ | Relations riches si retrieval relationnel requis | E3 insuffisant empiriquement |

## 2. Placement précis de l'AI Runtime

### D3 — AiGatewayPort + OmniRouteAdapter minimal

Ce lot doit précéder le premier appel IA orchestré, mais il ne crée ni ProviderRegistry technique,
ni ModelRegistry authoritative, ni routeur, monitor, quota engine ou fallback maison :

- `AiGatewayPort` comme abstraction ICOS remplaçable en théorie ;
- `CapabilityRequirement`, criticité, privacy, qualité minimale, budget, classes de providers et
  préférence abonnement/crédits/free tier ;
- `AiRoutingPolicy` métier minimal et restrictions client/projet ;
- `OmniRouteAdapter` qui traduit ces contraintes vers les presets/budgets par requête OmniRoute ;
- résultat normalisé avec provider/modèle/compte réel, route explanation, tokens, latence, fallback
  et coûts techniques retournés ;
- corrélation Mission/Run/Task et proposition de génération persistée avant tout effet externe.

Provider accounts, credentials/OAuth, catalogues, quotas, health, pricing, circuit breakers, retries,
fallback et technical routing restent dans OmniRoute.

### R1 — Politique de routage métier et usage

Après usage réel, ce lot ajoute l'overlay business d'abonnement/budget, le `UsageLedger` corrélé et
les policies de haut niveau. Il distingue `estimatedListCost`, `providerReportedCost`,
`subscriptionIncludedCost`, `incrementalCost` et `savingsEstimate`. ICOS choisit WHY/WHAT et les
contraintes ; OmniRoute optimise HOW/WHERE.

### R2 — Projections opérationnelles OmniRoute

Ce lot consomme les API ou le MCP OmniRoute pour health, quotas, reset windows, latence, catalogues,
route explanations et budgets. ICOS conserve des projections datées et définit ses réactions métier
(pause, budget, notification, refus), mais ne reconstruit ni monitor, circuit breaker, lockout ou
fallback technique. Les tools MCP read-only et write sont séparés ; les writes passent Policy.

### R3 — Evals métier vers policy

Ce lot exploite `EvaluationStore` ICOS pour mesurer le succès métier, distinct des evals
route/modèle d'OmniRoute. Les résultats produisent une proposition de policy/contraintes envoyées à
OmniRoute ; aucune policy critique n'est auto-promue.

## 3. Lots qui peuvent être combinés — et ceux qui ne doivent pas l'être

### Combinaisons acceptables

- **C1 + C2** pour une première PR si les contrats restent distincts et la taille demeure vérifiable.
- **D2 + extension minimale de l'Event Journal**, car les événements Mission/Plan/Run font partie de
  l'atomicité du domaine.
- **D3 AiGatewayPort + OmniRouteAdapter**, car ils forment ensemble la frontière minimale sans
  dupliquer les registres techniques OmniRoute.
- **E1 + provenance minimale**, car une mémoire sans provenance violerait l'invariant dès sa
  naissance.

### Séparations obligatoires

- **Skill discovery et skill activation** : import/quarantaine ne doit pas partager une transaction
  ou un endpoint qui active.
- **Policy decision et effet externe** : une approval autorise une exécution précise ; elle n'est pas
  l'exécution.
- **Génération modèle et effet externe** : garantit qu'un retry/fallback modèle ne double pas l'effet.
- **Heartbeat et Policy Engine** : le heartbeat propose ou déclenche une commande gouvernée ; il ne
  reçoit aucun bypass.
- **EventBus/traces et Event Journal** : observabilité technique distincte de l'audit immuable.
- **Scheduler et Temporal** : le premier n'est pas une version simplifiée qu'il faudrait migrer
  automatiquement vers le second.
- **Channel adapter et use case** : WhatsApp/Telegram/voix ne contiennent ni rôle, ni policy, ni
  logique métier propre.

## 4. Les cinq prochains lots recommandés

Sous réserve de l'achèvement du Lot 2B-2, et **avec COMPLIANCE-0 comme prérequis transverse
documentaire** désormais disponible, les cinq prochains lots sont :

1. **C1 — Capability Registry** (déjà réalisé) ;
2. **C2 — Skill Registry & Trust Lifecycle** ;
3. **D1 — Policy/Approval Engine v2** ;
4. **D2 — Mission, Plan, Run & Event Journal** ;
5. **D3 — AI Gateway / OmniRoute Business Layer**.

C3 (SkillsMP Discovery read-only) est parallèle et non bloquant après C2. D3 doit être livré avant le
premier appel modèle de D4, mais reste volontairement minimal : aucune reconstruction des catalogues,
credentials, quotas, health, pricing, circuit breakers, retries ou fallback OmniRoute.

## 5. Lots transverses COMPLIANCE

Les lots COMPLIANCE-0/1/2/3 sont **transverses** : ils s'exécutent en parallèle des phases A–K
et imposent des gates de conformité aux lots fonctionnels. Ils ne produisent pas de fonctionnalité
métier visible, mais sont des prérequis documentaires et techniques pour tout traitement de données
personnelles réelles.

### 5.1 COMPLIANCE-0 — Fondation documentaire

- **État** : accepté (ADR-0023, 7 documents de conformité livrés).
- **Blocant pour** : Lot 2B-2 (données personnelles dans l'administration humaine), C1 (classification
  dans le registre), tout lot manipulant des données C2/C3.
- **Gate** : revue de conformité humaine obligatoire avant fusion (critères CT-DOC-01 à CT-DOC-06
  dans `docs/compliance/ICOS_COMPLIANCE_TESTS.md`).

### 5.2 COMPLIANCE-1 — Vérification automatisée

- Déclenché après C1 (champ `dataClassification` dans le registre).
- Ajoute le marquage des schémas Drizzle et la validation CI.
- Ne bloque aucun lot fonctionnel immédiat mais renforce la gate.

### 5.3 COMPLIANCE-2 — Contrôles techniques

- Déclenché après D1 (Policy Engine).
- Implémente le chiffrement at-rest C3, la purge automatique et le consentement.
- **Blocant pour** : Phase E (Mémoire), Phase G (Intégrations).

### 5.4 COMPLIANCE-3 — Conformité complète

- Déclenché après F1 (Contrat conversationnel) et G1 (Tool Gateway).
- DPIA, mentions RGPD, sous-traitance, DPO.
- **Blocant pour** : production avec utilisateurs réels non internes.

### 5.5 Résumé des dépendances avec les lots fonctionnels

```text
CMP-0 ──┬── 2B-2 ── C1 ── C2 ── D1 ── D2 ── D3 ── D4 ── ...
        │               │             │
        └── CMP-1 ──────┘             │
                          └── CMP-2 ──┘
                                        └── CMP-3 (après F1, G1)
```
