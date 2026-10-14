# OmniRoute — stratégie de modèles pour le développement ICOS (mesurée le 2026-10-14)

Préparé par FABLE 5.1 (superviseur). Mesures sur OmniRoute 3.8.49 (`127.0.0.1:20129`), clé du labo
lue depuis `~/.icos-fable-lab/lab.env` sans être affichée. Aucun secret modifié, aucun appel vers un
modèle payant pour ces mesures (les seuls modèles premium déjà prouvés le sont dans
`CLAUDE_VIA_OMNIROUTE_2026-10-12.md`). Rien n'est appliqué en production : ce document propose la
configuration et les décisions ; l'application passe par l'étape B2 (env) du runbook d'activation.

## 1. Inventaire (`/v1/models`, 432 identifiants)

| Fournisseur (préfixe)        | Nature                                  | Gratuit ?                                   | État mesuré aujourd'hui                                                                   |
| ---------------------------- | --------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `nvidia/*` (NIM)             | ~90 modèles texte/vision/embed          | Oui (crédits NIM)                           | nemotron-3-super-120b 200 en 1,0 s ; nemotron-3-ultra-550b 200 en 0,7 s ; glm-5.3 200 en 2,3 s ; deepseek-v4.1-flash et kimi-k3 : **timeout 45 s** ; plusieurs 404 (catalogue périmé) |
| `openrouter/*:free`          | 17 variantes gratuites                  | Oui                                         | nemotron-3-ultra:free 200 en 0,9 s ; nemotron-3-super:free **502** ; gemma-4-31b:free **429** (31 s) ; north-mini-code:free et `openrouter/free` **502** |
| `groq/*`                     | gpt-oss-120b/20b, whisper               | Oui (tarif 0 annoncé)                       | **502 « upstream returned an empty response »** sur les deux modèles : identifiant à vérifier |
| `oc/*` (OpenCode)            | 6 « -free »                             | Non utilisable                              | **403 « free tier can only be used from within OpenCode »** / 400 « Model is unavailable » |
| `gemini/*`                   | 3.1-flash-lite, 3.5-flash, embeddings   | Palier gratuit à confirmer                  | 3.1-flash-lite 200 en 2,1 s ; 3.5-flash **503** (35 s)                                     |
| `mistral/*`                  | codestral-latest, embed, moderation     | Palier gratuit à confirmer                  | codestral-latest 200 en 0,3 s                                                              |
| `cc/*`, `claude/*`           | Claude haiku 4.5 → opus 5 (+ efforts)   | **Non** (abonnement Claude Code / clé)      | prouvés le 2026-10-12 (2–4 s), non re-sondés                                               |
| `codex/*`, `cx/*`            | GPT-5.5, GPT-5.6 sol/terra/luna         | **Non** (abonnement ChatGPT)                | prouvés (reviewer/planner des runs 9–11), non re-sondés                                    |
| `auto/*` (combos)            | 38 alias                                | **Trompeur**                                | `auto/best-free` a servi **`claude-opus-5`** (41/5 tokens) ; `auto/coding:free` → 502 via groq ; `auto/claude-*` servis par Gemini/Nemotron (doc du 12) |
| `felo/*`, `veo-free/*`, images, ASR/TTS | hors développement               |                                             | non évalués                                                                                |

Quotas : OmniRoute ne renvoie aucun en-tête de quota ; les 429 se manifestent comme
« Provider returned error » (cooldown par identifiant, `reset_seconds`). Le dashboard (`/api/providers`,
session requise) reste le seul endroit où lire les identifiants et leurs plafonds : à faire par le
propriétaire, pas par un agent.

## 2. Tâches d'or exécutées (zéro coût) — rôle reviewer, `pnpm reviewer:certify --runs 2`

Même classe `OmniRouteReviewer`, mêmes prompts et schéma strict que la production ; writer de référence
`cc/claude-sonnet-5` pour le contrôle « même juge » (décision 0054).

| Candidat gratuit                              | safe (attendu APPROVE) | dangerous (attendu BLOCK) | empty (jamais APPROVE)  | Latence         | Verdict  |
| --------------------------------------------- | ---------------------- | ------------------------- | ----------------------- | --------------- | -------- |
| `nvidia/nvidia/nemotron-3-ultra-550b-a55b`    | 2/2 APPROVE            | 2/2 **BLOCK** (RCE repéré) | 2/2 REQUEST_CHANGES     | 3,9–23 s        | **PASS** |
| `nvidia/nvidia/nemotron-3-super-120b-a12b`    | 2/2 APPROVE            | 2/2 REQUEST_CHANGES (hors périmètre repéré, RCE non nommé) | 2/2 REQUEST_CHANGES | 2,4–14 s | PASS (toléré, plus faible) |
| `nvidia/z-ai/glm-5.3`                         | timeout                | timeout                   | timeout                 | > délai reviewer | **FAIL** |

Référence payante (2026-10-12) : `cc/claude-sonnet-5` 9/9, 4–12 s.

## 3. Affectation proposée par compétence (rien d'appliqué)

| Rôle ICOS                                   | Premier choix (gratuit)                          | Fallback gratuit                                 | Premium (seulement si valeur mesurable)             | Validation exigée avant usage critique                      |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------- |
| Reviewer indépendant (`ICOS_REVIEWER_MODEL`) | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` (certifié 6/6) | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | `cc/claude-sonnet-5` si le writer est GPT ; `codex/gpt-5.6-sol` si le writer est Claude | certification ci-dessus, à rejouer à chaque changement de version |
| Planner (`ICOS_PLANNER_MODEL`)              | `nvidia/nvidia/nemotron-3-super-120b-a12b` (1 s) | `nvidia/nvidia/nemotron-3-ultra-550b-a55b`       | `codex/gpt-5.5-low` (actuel)                        | preview `/api/goals/convert-preview` sur 3 objectifs réels, plan valide au schéma |
| Writer (exécution de code, `ICOS_AUTONOMY_ALLOWED_MODELS`) | — aucun gratuit certifié —              | —                                                | `cc/claude-sonnet-5` (run 11 : réussite 1re tentative) ; `codex/gpt-5.5-low` | un run N1 complet par candidat (N1_RUN11 = référence) |
| Détection / analyse statique (W11)          | sans modèle (ESLint)                             | —                                                | —                                                   | —                                                           |
| Tests / analyse de logs (rapport, triage)   | `nvidia/nvidia/nemotron-3-super-120b-a12b`       | `gemini/gemini-3.1-flash-lite`                   | —                                                   | tâche non critique : aucune                                 |
| Embeddings (mémoire)                        | `nvidia/nvidia/nemotron-3-embed-1b`              | `gemini/gemini-embedding-001`                    | —                                                   | hors périmètre ici                                          |

Règles : `auto/*` exclus de toute liste (un alias « free » peut servir Opus 5) ; `oc/*` exclus ; un
candidat gratuit n'entre dans l'allowlist writer qu'après un run N1 certifié ; Claude/GPT restent
réservés au writer et aux revues où le gratuit a échoué (timeouts, INVALID_OUTPUT) — le surcoût est
alors mesuré dans `spend_ledger` par mission.

## 4. Fallback, quotas, 429 — avec l'existant, sans second routeur

- Le routeur canonique (`CapabilityRouter` + `compute-routing/1`, décisions 0054/0071) gère déjà :
  cooldown fournisseur 5 min sur 429, 30 min sur erreur d'auth, 10 min par modèle indisponible ;
  `SAME_MODEL_AS_WRITER` pour le reviewer ; un `InferencePlan` déclare l'alternance (stages).
- La flotte du labo contient déjà les candidats gratuits inscrits et sains (`workers` run 11 :
  nemotron super/ultra NIM et OpenRouter healthy ; `oc/*` unhealthy). Mettre plusieurs candidats
  gratuits dans `ICOS_AUTONOMY_ALLOWED_MODELS` suffit pour que le routeur bascule entre eux ; aucun
  alias OmniRoute n'est nécessaire ni souhaitable.
- `pnpm compute:register` (dry-run par défaut) et les sondes datées (`compute:probe`) sont la
  mesure continue de disponibilité ; la retraite gouvernée (0064) sort un candidat qui échoue.

## 5. Mesure tokens / latence / fiabilité / coût

- Tokens et latence par appel et par mission : `spend_ledger` + `pnpm mission:trace` (W9 ajoute la
  ventilation cache lue/créée en colonnes nullable).
- Fiabilité : classes d'échec du ledger de dispatch (W1), `ROUTING_DECISION` (migration 0048).
- Coût : le registre `src/core/pricing/registry.ts` **refuse un tarif à zéro** (`value <= 0` →
  INVALID_ENTRY) ; un modèle gratuit reste donc `UNPRICED`, indistinguable d'un prix inconnu.
  → décision propriétaire : introduire une catégorie explicite « gratuit, provenance datée » (ADR),
  sinon le coût par mission ne peut pas afficher 0 € de façon honnête.

## 6. Décisions nécessaires (propriétaire)

1. Adopter la paire gratuite reviewer = `nvidia/nvidia/nemotron-3-ultra-550b-a55b`, planner =
   `nvidia/nvidia/nemotron-3-super-120b-a12b` pour le run N1 suivant (le writer reste
   `cc/claude-sonnet-5`), avec budget : plafond tokens 2 M / goal, `--max-budget-usd 5`.
2. Vérifier dans le dashboard OmniRoute les identifiants Groq (502) et OpenRouter (502/429) ; retirer
   ou corriger ; confirmer le palier gratuit Gemini/Mistral avant de les lister.
3. ADR « tarif gratuit explicite » pour le registre de prix.
4. Interdire `auto/*` dans `ICOS_AUTONOMY_ALLOWED_MODELS` par politique (déjà le cas de fait).
