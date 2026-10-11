# DIAGNOSTIC_VOCAL_ICOS_2026-10-11

Audit en lecture seule, réalisé le 2026-10-11 par le superviseur P0 autonomie. Aucune donnée de
production modifiée, aucune base interrogée, aucun secret lu ni affiché.

## 1. Où vivent les conversations vocales

| Support | Contenu | Statut pour le 11/10 |
|---|---|---|
| PostgreSQL production — `cognitive_conversations` (titre `Voice`), `cognitive_turns` (texte STT de l'utilisateur, texte de réponse = texte envoyé au TTS), `cognitive_events`, `cognitive_context_snapshots` | **Source canonique.** Tables en ajout seul (triggers no-delete), aucune purge | Non consulté : la règle du dépôt interdit de contourner la couche service ; requête en lecture seule fournie §6 |
| Journaux d'appels OmniRoute — `/srv/icos/omniroute/call_logs/2026-10-11/*.json` | Requête et réponse complètes de chaque appel au modèle cognitif, dont le contexte `[runtime:capability.*]` | **Source utilisée.** Lecture seule, extraction limitée au message utilisateur, aux lignes de capacité et à la réponse |
| `/srv/icos/logs/icos-web.log` | Journal applicatif | Aucune ligne datée du 11/10 |
| Journal système (`icos-web.service`) | Sortie standard du serveur vocal | Illisible sans sudo (non tenté) |
| Audio brut | — | Jamais conservé (ADR 0061 §8) |

Le canal (voix/texte) n'est stocké dans aucune colonne : il se déduit du titre `Voice` et des
clés d'idempotence `t-<uuid>` du client vocal.

## 2. Déclarations retrouvées (verbatim)

Heures UTC, Paris = UTC+2. Modèle : `nvidia/nemotron-3-ultra-550b-a55b`. Chaque citation a été
relue par le superviseur dans le fichier indiqué (`responseBody.choices[0].message.content`).

**09:47 Paris** — fichier `2026-10-11T07-47-32.071Z_…-d3a61c.json`, intention
`clarify_autonomy_gaps`.

> Utilisateur : « autonome. Qu'est-ce qui manque pour ça ? »
>
> ICOS : « Deux points limitent l'autonomie complète aujourd'hui :
> 1. **mission.execute = GOVERNED** — une mission approuvée s'exécute sans supervision, mais le
> *lancement* de toute mission à effet externe, destructif ou irréversible exige une approbation
> humaine (policy). Seules les missions en lecture seule ou confinées à un worktree isolé partent
> sans approbation.
> 2. **workforce.delegate = DEGRADED** — 6 workers routables sur 8, et **aucun cerveau durable**
> (pas de worker persistant avec état propre).
>
> Côté calcul : **compute.providers = DEGRADED** aussi (oc 0/2 indisponibles).
>
> En résumé : le moteur tourne, la mémoire persiste, la voix fonctionne, mais le déclenchement
> autonome d'actions à effet de bord reste gouverné, et la délégation n'a pas encore de workers
> « cerveau » durables. »

**11:04 Paris** — fichier `2026-10-11T09-04-09.704Z_…-537719.json`, intention
`check_provider_visibility`.

> Utilisateur : « J'ai ajouté Claude dans les providers disponibles, est-ce que tu le vois ? »
>
> ICOS : « Non, je ne vois pas Claude dans la liste actuelle des providers. Les workers routables
> sont : codex (1/1), cx (1/1), nvidia (2/2), oc (0/2), openrouter (2/2). Soit l'ajout n'a pas
> encore été propagé, soit il faut vérifier la configuration. »

Échanges précédents, sans contenu de diagnostic : « Salut, tu vas bien ? » / « Est-ce que je peux
te donner une mission ? ».

**Mesures fournies à ICOS à 09:47** (lignes `[runtime:capability.*]` du même appel) :
`compute.providers` DEGRADED (6/8 : codex 1/1, cx 1/1, nvidia 2/2, **oc 0/2**, openrouter 2/2) ;
`tools.governed` NOT_CONNECTED (connecteurs 0, habilitations 0, exécuteurs 0) ;
`external.realtime` NOT_CONNECTED ; `workforce.delegate` DEGRADED (6/8, aucun cerveau durable) ;
`mission.execute` GOVERNED ; `memory.durable`, `conversation.context`, `reasoning.propose`,
`voice.speech` AUTONOMOUS.

## 3. Ce qui reste une déduction (non vérifié)

- Le message « autonome. Qu'est-ce qui manque pour ça ? » commence au milieu d'une phrase : la
  STT a probablement coupé un début d'énoncé. Seule `cognitive_turns` peut le confirmer.
- Le texte stocké d'un tour assistant peut différer légèrement de la réponse brute du modèle
  (`governOutcome`). `cognitive_turns` fait foi.
- Le tour de 11:04 appartient vraisemblablement à une autre conversation que ceux de 09:47.

## 4. Vérification de chaque manque annoncé

| Manque déclaré par ICOS | Vérifié contre le code | Classement | Statut sur `feat/p0-autonomy-unblock` |
|---|---|---|---|
| `mission.execute = GOVERNED` | Plafond par construction dans le modèle de soi ; surtout, **aucun contrôle de risque par tâche après le lancement** | Partiel | Politique de risque à 8 classes appliquée **avant chaque dispatch** (ADR 0074) ; état `AUTONOMOUS_BY_POLICY` lu depuis le superviseur réellement composé (ADR 0075) |
| « le lancement… exige une approbation » | Exact : c'est la politique voulue, conservée | Fonctionnel (par conception) | Inchangé ; destructif, financier, secret, irréversible : approbation |
| 6 workers routables sur 8, oc 0/2 | Exact. La raison de l'échec était **jetée** et les lignes mortes ne sortaient jamais du dénominateur | Défaillant (mesure) | Classe d'échec persistée (migration 0062), retrait gouverné des orphelins, état `PARTIAL` qui **nomme** un fournisseur sans identifiants |
| « aucun cerveau durable » | Exact. Les cerveaux ne sont créés que par `scripts/workforce-bootstrap.ts`, lancé par le propriétaire (ADR 0068 : ICOS ne crée pas ses cerveaux) | Non raccordé (action propriétaire) | Inchangé, par gouvernance |
| `compute.providers = DEGRADED` | Même cause que la délégation | Défaillant (mesure) | Corrigé (READY / PARTIAL / DEGRADED distingués) |
| « je ne vois pas Claude » | **Défaut réel non annoncé comme tel** : la flotte n'est réconciliée **qu'au démarrage**. Un fournisseur ajouté à OmniRoute ensuite reste invisible jusqu'au redémarrage ou à `pnpm compute:register` | Absent | **Ouvert** — priorité P1 ci-dessous |
| (non annoncé) `tools.governed` NOT_CONNECTED | Gateway complète mais construite seulement par les routes admin ; aucun appelant en production | Non raccordé | Gateway composée au démarrage, identité runtime niveau 0 ; READY après une habilitation explicite du propriétaire |
| (non annoncé) `external.realtime` NOT_CONNECTED | Aucun connecteur déclaré, aucun appelant | Non raccordé | Source de contexte web gouvernée ; nécessite un connecteur déclaré + habilitation propriétaire |
| (non annoncé) LDS Rénov non reconnu | Annuaire clients alimenté seulement par un script manuel | Non raccordé | Amorçage idempotent au démarrage, domaine et traits déclarés |

## 5. Recommandations classées

| Priorité | Action | Qui | Preuve d'acceptation |
|---|---|---|---|
| P0 | Intégrer `feat/p0-autonomy-unblock` après revue (porte d'intégration confinée, finalisation ADR 0073, mesures honnêtes, politique de risque) | Propriétaire / intégration | Tests listés dans le rapport de mission ; table des capacités mesurée en production |
| P1 | Réconcilier la flotte de calcul **périodiquement** (job durable existant, pas un `setInterval`), pour qu'un fournisseur ajouté apparaisse sans redémarrage | Code | Test : un modèle ajouté à la liste OmniRoute devient un worker en une période |
| P1 | Exécuter `pnpm workforce:bootstrap` (cerveaux durables) | Propriétaire | `workforce.delegate` cite N cerveaux durables |
| P1 | Déclarer un connecteur `search`/`web` puis `pnpm tools:grant-realtime --reason …` | Propriétaire | `external.realtime` et `tools.governed` passent à READY |
| P2 | Persister le canal (`voice`/`text`) sur `cognitive_turns`, et garder le transcript STT brut à côté du texte normalisé, pour que ces diagnostics ne dépendent plus des journaux d'un fournisseur | Code (migration additive) | Requête §6 filtrable par canal |
| P2 | Registre persistant des besoins d'ICOS (voir §7) | Code | Besoins visibles et suivis dans le cockpit |

## 6. Requête en lecture seule (à lancer par le propriétaire)

```sql
BEGIN TRANSACTION READ ONLY;
SELECT c.id AS conversation_id, c.title, t.seq, t.role, t.intent,
       t.created_at AT TIME ZONE 'Europe/Paris' AS created_paris,
       (SELECT string_agg(p->>'text', E'\n') FROM jsonb_array_elements(t.content->'parts') p) AS text
FROM cognitive_turns t
JOIN cognitive_conversations c ON c.id = t.conversation_id
WHERE t.created_at >= timestamptz '2026-10-11 00:00 Europe/Paris'
  AND t.created_at <  timestamptz '2026-10-12 00:00 Europe/Paris'
ORDER BY c.id, t.seq;
ROLLBACK;
```

## 7. Registre des besoins d'ICOS — proposition (non implémentée)

Pas de nouvelle mémoire ni de nouveau registre parallèle. Le besoin est une **projection** de ce
qui existe déjà :

- **Source** : les faits du modèle de soi (`capabilityFacts`, ADR 0062/0075), déjà mesurés à
  chaque tour, avec état, preuve et action nommée (ex. « pnpm tools:grant-realtime »).
- **Historisation** : un instantané horodaté par changement d'état, écrit dans la mémoire
  cognitive (`memory_records`, type `self`, `subjectKey = self.capability.<clé>`, provenance
  `system`), ce qui donne la supersession et la traçabilité sans table nouvelle.
- **Résolution** : un besoin est résolu quand l'état mesuré atteint READY / AUTONOMOUS(_BY_POLICY),
  jamais par déclaration.
- **Cockpit** : la projection de vérité (`features/cockpit/truth-projection.ts`, ADR 0069) affiche
  déjà ces faits ; il suffit d'y ajouter l'action attendue et l'ancienneté de l'état.
