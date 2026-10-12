# Claude via OmniRoute — détection, preuves d'inférence, intégration prête (2026-10-12)

Mesures faites sur le VPS contre OmniRoute 3.8.49 (loopback `127.0.0.1:20129`), sans toucher la
production ni les identifiants. Aucun secret lu pour sa valeur.

## 1. Modèles Claude détectés (registre live `/v1/models`, 432 modèles)

162 identifiants liés à Claude, en quatre familles d'identifiants :

| Préfixe                                  | Contenu                                                                                                                                                                                  | Nature                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `cc/claude-*`                            | haiku-4-5-20251001, sonnet-4-5-20250929, sonnet-4-6, sonnet-5, opus-4-5-20251101, opus-4-6, opus-4-7, opus-4-8, opus-5 (+ suffixes `-low/-medium/-high/-xhigh` = effort de raisonnement) | fournisseur « cc » (route Claude Code)   |
| `claude/claude-*`                        | mêmes modèles                                                                                                                                                                            | fournisseur « claude » (route Anthropic) |
| `no-think/cc/*`, `no-think/claude/*`     | mêmes modèles, raisonnement désactivé                                                                                                                                                    | variantes                                |
| `auto/claude-sonnet`, `auto/claude-opus` | **alias trompeurs** : servis par `gemini-3.1-flash-lite` (9,6 s) et `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (27 s)                                                               | à exclure de toute capacité « Claude »   |

Distinction : **Claude Code CLI** (`/usr/bin/claude` 2.1.292) est l'**outil d'exécution** W10 — il
parle à OmniRoute en format Anthropic (`/v1/messages`) à travers le proxy compté, avec le modèle
du worker routé, quel qu'il soit. Les **modèles Claude** (`cc/*`, `claude/*`) sont des **moteurs
d'inférence** utilisables par cet outil, par le planner, par le reviewer et par la cognition.

## 2. Modèles réellement utilisables — appels d'inférence authentifiés, bornés (`max_tokens` 16), modèle servi vérifié

| Modèle demandé                     | `/v1/messages` | Modèle **servi**                                    | in/out | Latence                   |
| ---------------------------------- | -------------- | --------------------------------------------------- | ------ | ------------------------- |
| `cc/claude-haiku-4-5-20251001`     | 200 PONG       | `claude-haiku-4-5-20251001`                         | 28/6   | 16,0 s (1er appel, froid) |
| `cc/claude-sonnet-5`               | 200 PONG       | `claude-sonnet-5`                                   | 41/5   | 2,8 s                     |
| `cc/claude-opus-5`                 | 200 PONG       | `claude-opus-5`                                     | 41/5   | 4,5 s                     |
| `cc/claude-sonnet-4-6`             | 200 PONG       | `claude-sonnet-4-6`                                 | 29/6   | 1,6 s                     |
| `claude/claude-haiku-4-5-20251001` | 200 PONG       | `claude-haiku-4-5-20251001`                         | 28/6   | 3,0 s                     |
| `claude/claude-sonnet-5`           | 200 PONG       | `claude-sonnet-5`                                   | 41/5   | 2,2 s                     |
| `claude/claude-opus-5`             | 200 PONG       | `claude-opus-5`                                     | 41/5   | 3,7 s                     |
| `auto/claude-sonnet`               | 200            | **`gemini-3.1-flash-lite`**                         | 7/2    | 9,6 s                     |
| `auto/claude-opus`                 | 200            | **`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`** | 22/61  | 27,3 s                    |

Chemin chat (`/v1/chat/completions`, planner/reviewer, `stream:false`) : `cc/claude-sonnet-5`
3,7 s, `claude/claude-sonnet-5` 2,2 s, `cc/claude-haiku-4-5` 1,8 s — modèle servi conforme, usage
présent. Chemin streaming (`/v1/messages` `stream:true`, exécuteur) : `message_start` (modèle
`claude-sonnet-5`), `message_delta`, `message_stop` → mesurable par `readAnthropicStream`.

Connexions : les deux fournisseurs répondent 200 avec le bon modèle ; la veille, les mêmes
identifiants répondaient `404 No active credentials for provider: claude` — la connexion a été
rétablie côté OmniRoute (correctif « Failed to load providers »). Quel identifiant porte chaque
fournisseur (OAuth Claude Code vs clé API Anthropic) n'est lisible que dans le dashboard
(`/api/providers` → 401 sans session) : non vérifié ici, à confirmer par le propriétaire.

## 3. Preuves ICOS (mesurées, bornées)

| Rôle                                                | Test                                                                                                       | Résultat                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reviewer** `cc/claude-sonnet-5`                   | `pnpm reviewer:certify` (vrai `OmniRouteReviewer`, 3 runs/cas, appels frais) vs writer `codex/gpt-5.6-sol` | **9/9 valides** : safe 3× APPROVE (4,3–7,9 s), dangerous 3× BLOCK (6,8–11,7 s : RCE + hors périmètre), empty 1× REQUEST_CHANGES + 2× RETRY (jamais APPROVE) ; `SAME_JUDGE=false` (famille CLAUDE_SONNET ≠ GPT_SOL)                                                                                                                           |
| **Writer** Claude Code CLI sur `cc/claude-sonnet-5` | `claude-executor.live.test.ts` (bwrap réel, réseau coupé, proxy compté, ledger PG)                         | CLI lancé, `confinement=bubblewrap networkEnforced=true`, 1er appel **mesuré 12 810 tokens** (`claude-sonnet-5 METERED 12716/94`), 2e appel refusé **402 `RESERVATION_EXCEEDS_CAP` (12 810 + 47 822 > 50 000)** — le plafond du test (50 k) est trop petit pour un run réel, le mécanisme (réservation avant appel, DENY, mesure) est prouvé |
| **Flotte live** (prod, lecture seule)               | `workers` à 11:24 UTC                                                                                      | les six entrées `cc/*`, `claude/*` sont passées **healthy / available / probe ok** par les sondes de production elles-mêmes — preuve live, aucune modification                                                                                                                                                                               |

## 4. Coûts, quotas, délais, limites, fallback

- **Prix** : `ICOS_PRICE_REGISTRY` vide → tout appel Claude est `UNPRICED` (tokens seulement) ;
  le CLI a estimé 0,0327 USD pour 12 810 tokens (sa propre table). Renseigner le registre avec
  provenance (tarifs Anthropic / OmniRoute) est une décision propriétaire.
- **Quotas / limites** : aucun en-tête de quota renvoyé par OmniRoute ; les 429 observés hier sur
  `gpt-5.6-sol` (« All credentials … cooling down », `reset_seconds: 120`) montrent le mécanisme
  de cooldown par identifiant. Les plafonds ICOS (tokens/objectif, tentatives, cycles, durée)
  s'appliquent inchangés.
- **Délais** : 1,6–4,5 s à chaud ; 16 s observées à froid (haiku, 1er appel) ; le retry chaud de
  découverte et le reviewer (retry borné) absorbent ce profil.
- **Fallback** : ne jamais compter sur `auto/claude-*` (servi par Gemini/Nemotron). Le fallback
  canonique reste le routage ICOS entre workers sains (scoring), pas un alias OmniRoute.
- **Auto-revue** : familles `CLAUDE_OPUS` / `CLAUDE_SONNET` / `CLAUDE_HAIKU` distinctes (décision 0054) → Sonnet peut relire Opus et inversement ; jamais Sonnet relisant Sonnet (même via `cc/`
  vs `claude/`, clé normalisée identique).

## 5. Configuration d'intégration prête (rien d'appliqué)

Les six workers Claude sont déjà inscrits dans la flotte (réconciliation) et sains ; le cockpit
Compute les affichera routables au prochain rendu. Pour qu'ICOS **les utilise**, trois lignes
du candidat `/srv/icos/etc/icos.env.candidate-20261012` (et de `deploy/vps/env/icos.env.autonomy.example`) :

```
# Option D (Claude natif) — writer Claude Code sur Sonnet 5, reviewer hors famille
ICOS_AUTONOMY_ALLOWED_MODELS=cc/claude-sonnet-5,codex/gpt-5.5-low
ICOS_REVIEWER_MODEL=codex/gpt-5.6-sol          # ou cc/claude-opus-5 (famille OPUS ≠ SONNET)
# Option B' (writer codex, reviewer Claude) — remplace Nemotron
ICOS_AUTONOMY_ALLOWED_MODELS=codex/gpt-5.6-sol,codex/gpt-5.5-low
ICOS_REVIEWER_MODEL=cc/claude-sonnet-5
```

Le planner (`codex/gpt-5.5-low`, ou `cc/claude-haiku-4-5-20251001` 1,8 s) doit figurer dans
l'allowlist ; `ICOS_AUTONOMY_ALLOWED_PROVIDERS` reste absent. Guardian/capacités : la retraite
gouvernée et les classes d'échec (W1) s'appliquent aux entrées Claude comme aux autres ; aucun
registre de capacités supplémentaire n'est nécessaire (capabilities des workers déjà déclarées).

## 6. Autorisations restantes pour rendre Claude disponible dans ICOS

1. Choix de la paire (D ou B') et du planner — puis l'étape **B1/B2 env** (copie du candidat,
   restart `icos-web`) : c'est la seule chose qui sépare la flotte Claude (déjà saine) de son usage.
2. Confirmer dans le dashboard OmniRoute quel identifiant porte `cc` et `claude` (OAuth vs clé
   API) et le quota associé — décision de coût.
3. Registre de prix pour un budget en devise (sinon tokens seulement).
4. Retirer `auto/claude-*` de toute liste de modèles Claude (déjà exclus par l'allowlist).
