# N1 — certification de la première mission autonome en laboratoire isolé (2026-10-12)

Laboratoire FABLE (jamais la production) : Postgres dédié `fable-pg-lab` (:55460), serveur Temporal
du labo `p0au-temporal` (:17233) **namespace `icos-fable-lab`**, queue `icos-fable-lab`, clone cible
`/srv/icos/worktrees/fable-n1-target` (branche `lab/fable-base`, intégration `integration/fable-n1`),
worktrees sous `/srv/icos/worktrees/fable-n1-trees`, app + worker détachés (`setsid`, sans TTY) via
`~/.icos-fable-lab/lab.sh`. Writer **Claude Code CLI 2.1.292 via OmniRoute sur `codex/gpt-5.6-sol`**
(option B), reviewer **Nemotron 3 Ultra + retry borné**, planner `codex/gpt-5.5-low`. Rien n'a touché
`icos.env` (md5 `34325566dad2`), `icos-web`, OmniRoute, Temporal prod, ni le labo N1 de W6/W8.

## 1. Commits isolés (branche `feat/fable-5-1-convergence`, non poussée)

| Commit    | Correctif                                                                                                                                                                                                                                                                                                                                                                                                                | Preuve                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0a27ae3` | **Reviewer** : `OmniRouteReviewer` — 1 tentative initiale + 1 tentative corrective sur `INVALID_OUTPUT`/`INVALID_RESPONSE` (même règle que `CommandReviewer`), correctif explicite sans suggérer de verdict, contexte renvoyé inchangé ; verdicts/timeouts/erreurs fournisseur jamais réessayés ; après la dernière tentative l'échec reste (aucun PASS) ; timeout par tentative ≤ 180 s (validé). Décision 0054 intacte | 61/61 `src/server/review` (6 nouveaux cas) ; diagnostic réel : 1 JSON malformé `{"}decision":…` sur 6 appels frais de Nemotron                          |
| `96daa94` | **Metering** : une erreur fournisseur dans un flux 2xx (`event error` avant tout `message_start`) = appel échoué (réservation rendue, rien enregistré), pas une consommation non mesurable ; tout autre flux illisible reste UNMETERED, avec sa forme (octets, événements, erreur) journalisée (`SPEND_PROVIDER_ERROR_STREAM`, `SPEND_STREAM_UNMETERED`). Aucun zéro fabriqué, règle de fenêtre intacte                  | 341/341 budget + review ; labo W6/W8 : 2 lignes `cx/gpt-5.6-sol UNMETERED USAGE_ABSENT` → `UNMETERED_USAGE_IN_WINDOW` sur toutes les missions suivantes |
| `714c468` | **Découverte de flotte** : un retry chaud après timeout + `ICOS_COMPUTE_DISCOVERY_TIMEOUT_MS`                                                                                                                                                                                                                                                                                                                            | 38/38 ; OmniRoute `/v1/models` 5–6 s à froid puis < 1 s ; flotte 6/14 inscrite dès le boot du labo (jamais avant)                                       |
| `8b58eb7` | **Dispatcher Temporal** : le `Client` est construit dans `TEMPORAL_NAMESPACE` (il démarrait chaque workflow dans `default`)                                                                                                                                                                                                                                                                                              | test de construction ; labo : workflow `Running` dans `default` alors que le worker sondait `icos-fable-lab`                                            |
| `0e20c24` | **Sonde de reprise** : même namespace que le dispatcher                                                                                                                                                                                                                                                                                                                                                                  | test de construction                                                                                                                                    |
| `7c53d73` | fusion du hub `bab1a3b` : l'allowlist système gouverne les workers qui dépensent (writer `codex/gpt-5.6-sol` routé au lieu de nemotron) ; objectif + périmètre de fichiers transmis au worker ; rien ne démarre sans worker routable                                                                                                                                                                                     | 798/798 sur les suites touchées                                                                                                                         |
| `bf1e863` | **Grant** : identité du worker routé lue dans le registre durable (la vue en mémoire du conteneur de la route était antérieure au bootstrap de flotte → `WORKER_EXEC_UNROUTABLE: … declares none` à chaque run)                                                                                                                                                                                                          | 7/7 route ; run 4 : modèle transmis, Claude Code lancé                                                                                                  |

Config : `ICOS_AUTONOMY_ALLOWED_PROVIDERS` ne doit **pas** être posé (le planner s'identifie
`omniroute` → `PROVIDER_NOT_IN_ALLOWLIST`, 82 reconversions silencieuses observées) ; le planner
doit figurer dans `ICOS_AUTONOMY_ALLOWED_MODELS` ; allow-bash du writer restreint à
`pnpm vitest run src/*` et `pnpm exec eslint src/*` ; `ICOS_GOAL_MAX_TOTAL_TOKENS=1500000`.
Reportés dans `deploy/vps/env/icos.env.autonomy.example` et le candidat.

## 2. Runs du laboratoire (chaque run = base vierge, détection → mission sans intervention)

| Run | Chaîne atteinte                                                                           | Arrêt                                                                                                                                                                                                                                                                                                  | Mesure réelle                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | goal détecté (W11) → mission `draft`                                                      | 82 × `goal.converted` : allumage refusé en silence (`PROVIDER_NOT_IN_ALLOWLIST`, planner)                                                                                                                                                                                                              | 0 appel goal                                                                                                                                                                                                                        |
| 1b  | … → task → dispatch                                                                       | workflow dans `default` (dispatcher) ; 3 instances d'app empilées (ancien processus tenant le port)                                                                                                                                                                                                    | —                                                                                                                                                                                                                                   |
| 2   | goal → task → dispatch dans `icos-fable-lab` → activité worker (11 s)                     | `WORKER_EXEC_UNROUTABLE` (grant sans modèle) → QC `ESCALATE` → `mission.failed`                                                                                                                                                                                                                        | planner 1 049 tokens                                                                                                                                                                                                                |
| 3   | idem avec writer `codex/gpt-5.6-sol` routé (hub `bab1a3b`)                                | idem (grant)                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                   |
| 4   | goal → task → dispatch → **Claude Code réel sous bwrap, proxy compté** (4 min)            | `RESERVATION_EXCEEDS_CAP` : 394 748 + 82 292 > 450 000 → QC `ESCALATE` → `mission.failed`                                                                                                                                                                                                              | **20 appels METERED, 394 748 tokens** ; diff réel `in-memory-git.ts` +33/−12 ; contexte 4,6 k → 29 k                                                                                                                                |
| 5   | idem, plafond 1,5 M (9 min)                                                               | `RESERVATION_EXCEEDS_CAP` : 1 372 827 dépensés                                                                                                                                                                                                                                                         | **27 appels, 1 371 778 tokens** ; diff +11/−11 ; un appel passe de 48 k à 94 k puis 140 k tokens (sortie d'une commande de test complète)                                                                                           |
| 6   | allow-bash ciblé `src/*` (14 min)                                                         | `RESERVATION_EXCEEDS_CAP` : 1 351 031 dépensés                                                                                                                                                                                                                                                         | 22 appels, 1 351 031 tokens ; diff +15/−11 ; contexte 29 k → 63 k → 96 k en deux appels (sortie d'outil)                                                                                                                            |
| 7   | allow-bash restreint à `src/server/workspace-manager/*` (13 min)                          | `RESERVATION_EXCEEDS_CAP` : 1 376 527 dépensés                                                                                                                                                                                                                                                         | 18 appels, 1 375 478 tokens ; contexte 25 k → 58 k → 92 k dès le 6ᵉ appel : avec `gpt-5.6-sol` via la traduction Anthropic, chaque tour renvoie tout le contexte (pas de cache) — le writer codex est fonctionnel mais inéconomique |
| 8   | **writer Claude Code sur `cc/claude-sonnet-5`, reviewer `codex/gpt-5.6-sol`** (cap 1,5 M) | exécution **réussie** (11:43:43, 30 appels) → revue `REQUEST_CHANGES` (codex, 3 236 tokens) → QC `CORRECT` → attempt 2 → `RESERVATION_EXCEEDS_CAP` (1 385 283) → ESCALATE → `mission.failed`                                                                                                           | 44 appels Claude, 1 380 998 tokens ; contexte 18 k → 43 k (cache lu compté en entrée)                                                                                                                                               |
| 9   | idem, cap **4 M** (23 min)                                                                | exécution réussie (11:56:13) → revue 1 `REQUEST_CHANGES` → correction (attempt 2) réussie (12:07:52) → revue 2 `REQUEST_CHANGES` → attempt 3 → `RESERVATION_EXCEEDS_CAP` (3 826 314) → QC `ESCALATE` (3e tentative) → `mission.failed` ; revue déterministe `BLOCK` (« Execution outcome is failure ») | **95 appels Claude, 3 818 913 tokens** (moy. 20 217 / max 73 005 tokens d'entrée par appel), reviewer 2 appels / 6 352, planner 1 049 ; diff final +14/−19 sur `in-memory-git.ts`                                                   |

### Verdicts du reviewer (run 9, `codex/gpt-5.6-sol`, structurés, hors famille du writer)

1. 11:56:37 `REQUEST_CHANGES` (warning) : « The worker could not run the targeted ESLint check and
   explicitly reports a mismatch between the 20 warnings in the mission evidence and only 19 unused
   bindings … » ; `requestedChanges`: « Run ESLint with @typescript-eslint/no-unused-vars against
   the target file, address every remaining warning… ».
2. 12:08:35 `REQUEST_CHANGES` : « The edit does not establish that the lint warnings were resolved.
   The worker only prefixed unused parameters with underscores while explicitly stating that it
   could not confirm an `argsIgnorePattern` … ».
3. 12:14:00 `BLOCK` (déterministe) : « Execution outcome is failure » (plafond atteint).

La boucle **exécution → revue indépendante → correction → nouvelle revue** est donc réelle,
durable et bornée (QC : `CORRECT`, `CORRECT`, `ESCALATE` à la 3e tentative).

### Le blocage exact avant `mission.succeeded` (rapport du writer lui-même, run 9)

> « Bash tool access … restricted … `git status`, `git log`, and `npx eslint` were all denied with
> "no approval surface" errors, and **`node_modules` does not exist in this worktree**. »

Deux causes précises, toutes deux dans le périmètre W10/W7 :

1. **Le worktree du writer n'a pas de dépendances** (`node_modules` absent) : l'installation
   `--offline` n'a lieu qu'à la porte (`ICOS_GATE_COMMANDS.install`), pas avant l'écriture. Le
   writer ne peut donc **jamais** prouver son lint ; le reviewer, à juste titre, refuse sans preuve ;
   chaque correction recoûte 20–70 k tokens de contexte → le plafond est atteint.
2. **L'allowlist bash ne couvre pas la forme utilisée par le modèle** (`npx eslint …` vs
   `pnpm exec eslint src/server/workspace-manager/*`) ; avec `--permission-prompts none`, tout
   écart est refusé sans recours.

Correctifs attendus (W10 ; non appliqués ici, pas de run 10) : installer les dépendances du
worktree avant le lancement (ou monter le store pnpm en lecture seule), et aligner l'allowlist sur
la commande que la consigne demande (ou injecter la commande exacte dans le prompt du worker).
Avec ces deux points, le run 9 aurait fourni la preuve de lint à la première revue.

### Ce que les runs 8–9 certifient

Sans aucune intervention humaine : détection W11 → objectif → mission → planification
(`codex/gpt-5.5-low`) → routage gouverné par l'allowlist (writer Claude Sonnet 5) → dispatch
dans `icos-fable-lab` → worktree isolé → **Claude Code réel sous bubblewrap, réseau coupé, chaque
appel réservé/mesuré** (ledger : 95 lignes METERED, 0 UNMETERED) → résultat `success` →
**revue indépendante structurée** (`REQUEST_CHANGES` + changements demandés) → **correction**
(attempt 2, `success`) → nouvelle revue → plafond de tokens opposé **avant** l'appel → QC escalade
à la 3e tentative → `mission.failed` audité. Non atteint : porte d'intégration, settlement
`succeeded` — bloqués par le point ci-dessus, pas par ICOS.

Ce que les runs prouvent déjà, sans intervention humaine : détection → objectif → mission →
planification → routage gouverné par l'allowlist → dispatch dans le bon namespace → worktree isolé
→ **exécution réelle de Claude Code** sous bubblewrap avec chaque appel réservé et mesuré →
**plafond de tokens opposé avant l'appel** → QC → settlement durable (`mission.failed` audité).
Pas encore atteint : revue Nemotron sur un résultat réel, correction, porte, `mission.succeeded`.

## 3. État du déploiement et des services VPS

Inchangés depuis F1 : `icos-web` sur release `5719213` (actif, 0 restart), `icos-temporal-worker`
non installé, `icos-gate-postgres` actif et isolé (:5434), namespace `icos-prod` créé (0 workflow),
`icos.env` intact ; candidat `/srv/icos/etc/icos.env.candidate-20261012` mis à jour (allowlist
modèles seulement, planner inclus, allow-bash ciblé, plafond 1,5 M).

## 4. Run 10 (2026-10-12, 13:36–14:07 UTC) — jusqu'à l'IntegrationGate

Rapport complet : `docs/icos/N1_RUN10_CERTIFICATION_2026-10-12.md`. Résumé : W10/W7 corrigés
(`b3e0ffb`, `07ceb0d`, `090f80d`, `e83b8f0`), préflight PASS, un seul run : détection → mission →
3 exécutions Claude Code (`cc/claude-sonnet-5`) → revue indépendante (`codex/gpt-5.6-sol` :
RETRY, RETRY, APPROVE) → **IntegrationGate atteint** (typecheck/lint/secrets/périmètre PASS, tests
unitaires FAIL ×4) → REJECT → `mission.failed`. 1 715 079 tokens / 3 M. Deux interventions
manuelles (kill du worker après correctif, reset Temporal de l'attempt 3). **N1_CERTIFIED : FAIL**,
blocages exacts reproduits : (a) réglages pnpm non transmis par l'adaptateur au shell du writer
(corrigé `e83b8f0`, non encore prouvé en run) ; (b) 4 tests unitaires en échec dans le sandbox de la
porte, indépendants du changement (reproduction en §8 du rapport).
