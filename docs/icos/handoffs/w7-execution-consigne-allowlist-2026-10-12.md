# Handoff W7 — la consigne d'exécution ne disait pas ce que l'exécuteur autorise

De : FABLE 5.1 (convergence, `feat/fable-5-1-convergence`). Pour : lanes W7 (porte / isolation) et
W10 (exécuteur Claude Code). Corrigé et épinglé par tests sur la branche de convergence (commit
`b3e0ffb`) ; rien n'a été modifié dans votre worktree ni en production.

## Reproduction (labo N1 FABLE, runs 8–9, 2026-10-12)

Déclaration de lancement (`ICOS_WORKER_EXEC_COMMANDS`) :
`--allow-bash "pnpm vitest run src/server/workspace-manager/*" --allow-bash "pnpm exec eslint src/server/workspace-manager/*"`.
L'adaptateur `bin/icos-claude-worker.mjs` traduit chaque motif en règle `Bash(<motif>)` et lance le
CLI avec `--permission-prompts none` : toute commande hors motif est **refusée sans invite** (c'est la
sécurité voulue). Le prompt (`executionPrompt`, `src/core/review/output-contract.ts`) donnait
l'objectif, le périmètre de fichiers et le contrat de sortie — **pas** les formes de commande
autorisées. Le writer a essayé `npx eslint …` (refus : « no approval surface ») puis a renoncé à
vérifier. Le reviewer a exigé la preuve. Boucle de corrections jusqu'au plafond (voir handoff W10).

## Cause

Deux sources de vérité pour une même autorisation : l'exécuteur appliquait la déclaration, le writer
ne la connaissait pas. Une consigne qui ne nomme pas les formes permises pousse un writer de bonne
foi à deviner, et chaque devinette refusée coûte un tour (18 k → 73 k tokens de contexte par tour en
run 9).

## Correctif

`src/server/execution/temporal/activities.ts` : `withExecutionEnvironment(prompt, {shellPatterns,
dependencies})` ajoute au prompt, **à partir de la déclaration que l'exécuteur applique** (une seule
source, `allowBashPatterns(declared.args)`), un bloc :

```
Execution environment (ICOS sandbox, enforced — not advice):
- Dependencies are installed in this worktree (node_modules present). Do not install anything.
- Shell commands permitted, in these exact forms and no other: `pnpm exec eslint src/core/autonomy/*` ; `pnpm vitest run src/core/autonomy/*`
- Any other command is refused without a prompt; do not retry it — verify with the permitted forms and report their output.
```

Sans `--allow-bash` : « No shell command is permitted: edit files only. » L'objectif reste en tête du
prompt ; le contrat de sortie et le périmètre de fichiers sont inchangés. **Aucun refus de sécurité
n'est assoupli** : la liste d'outils, `--disallowedTools`, `--setting-sources user`, le sandbox et
le proxy compté sont identiques ; seule l'information donnée au writer change.

Alignement de la déclaration labo (`/home/icos/.icos-fable-lab/lab.env`, run10) : motifs
`pnpm exec eslint src/core/autonomy/*` et `pnpm vitest run src/core/autonomy/*`, soit exactement le
périmètre de la mission canari (`ICOS_SELF_DEVELOPMENT_DETECTOR_PATHS=src/core/autonomy/learning-harvester.ts`).
`npx` n'est volontairement **pas** ajouté : avec la consigne, il n'a plus de raison d'être deviné, et
`npx` peut télécharger un paquet (réseau coupé, mais l'intention compte).

## Tests

`src/server/execution/temporal/worktree-dependencies.test.ts` : `ALLOWLIST_STATED_FROM_DECLARATION`
(les motifs du prompt sont ceux de `--allow-bash`, l'objectif reste en tête, « npx » absent),
`allowBashPatterns` (ordre, valeurs seules), `NO_SHELL_MEANS_EDIT_ONLY`.
`metered-egress-activity.test.ts` adapté (argv = objectif + bloc).

## Critères d'acceptation

1. Run labo : le rapport du writer cite la sortie des commandes permises (pas de « vérification impossible ») ; zéro refus `Bash(...)` dans la trace de l'exécuteur.
2. Nombre d'appels writer par exécution ≤ 34 (mesure run 9, exec 1) et contexte max < 50 k tokens.
3. En production, les motifs `--allow-bash` du candidat d'env (`deploy/vps/env/icos.env.autonomy.example`) couvrent le périmètre réel des missions autorisées (`src/*`), et le bloc apparaît dans le prompt (vérifiable par le test ci-dessus et par `pnpm mission:trace`).
