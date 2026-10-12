# Handoff W10 — le worktree du writer n'avait pas ses dépendances : installation hors ligne, confinée, avant le lancement

De : FABLE 5.1 (convergence, `feat/fable-5-1-convergence`). Pour : lane W10 (exécuteur Claude Code)
et lane W7 (porte d'intégration), `feat/p0-autonomy-unblock`. Corrigé et épinglé par tests sur la
branche de convergence (commits `b3e0ffb`, `07ceb0d`) ; rien n'a été modifié dans votre worktree ni
en production.

## Reproduction (labo N1 FABLE, runs 8–9, 2026-10-12)

Mission canari « remove unused declaration » (ESLint `no-unused-vars`), writer Claude Code sur
`cc/claude-sonnet-5`, reviewer `codex/gpt-5.6-sol`. Le worktree alloué par le WorkspaceManager
(`git worktree add` depuis `/srv/icos/worktrees/fable-n1-target`) ne contient **pas** de
`node_modules`. Le writer corrige le fichier, tente de vérifier (`pnpm exec eslint …`,
`pnpm vitest run …`), échoue (`eslint: not found` / modules absents), devine `npx eslint …` — refusé
sans invite par l'exécuteur (`--permission-prompts none`, motif absent de l'allowlist) — et rend un
rapport « correction faite, vérification impossible ». Le reviewer indépendant demande (à juste titre)
la preuve de lint : `REQUEST_CHANGES` → correction → même impasse → `REQUEST_CHANGES` → correction →
`RESERVATION_EXCEEDS_CAP`. Run 9 : 95 appels writer, **3 818 913 tokens** (exec 1,25 M ; correction 1
1,58 M ; correction 2 0,99 M) pour une ligne à supprimer. Jamais de `IntegrationGate`, jamais de
`mission.succeeded`.

## Cause (trois défauts emboîtés, tous mesurés)

1. **Aucune installation avant le lancement.** `runGovernedWorker` (`src/server/execution/temporal/activities.ts`) lançait l'exécuteur dans un worktree nu. Seule la porte installait (`withInstall`), c'est-à-dire *après* la revue — trop tard pour que le writer prouve quoi que ce soit.
2. **L'installation hors ligne confinée échouait de toute façon** (porte comprise — même runner, même environnement). Mesuré avec pnpm 11.10.0 sous bwrap, réseau coupé, HOME éphémère :
   - pnpm dérive son store de `HOME` → store vide → `ERR_PNPM_NO_OFFLINE_TARBALL` sur chaque paquet ;
   - pnpm 11 fixe `minimumReleaseAge=1440` par défaut et **revérifie chaque entrée du lockfile contre le registre** (métadonnées + attestations) même en `--offline` : 826 requêtes, chacune retentée pendant une minute (`EAI_AGAIN`), > 5 min puis échec ;
   - le store est monté **en lecture seule** (c'est un cache partagé, jamais la propriété du worktree) et l'index pnpm est une base SQLite ouverte en écriture : `ERR_SQLITE_ERROR unable to open database file`.
3. **Le writer ignorait les formes exactes autorisées** → handoff W7 séparé (`w7-execution-consigne-allowlist-2026-10-12.md`).

## Correctif (branche de convergence)

| Fichier                                                         | Changement                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/execution/temporal/activities.ts`                   | `ensureWorktreeDependencies(worktree)` **avant** le lancement : si `package.json` + `pnpm-lock.yaml` existent et `node_modules` est absent, exécute l'étape `install` de `ICOS_GATE_COMMANDS` (défaut `pnpm install --frozen-lockfile --offline`) via `SandboxedCommandRunner` (réseau `false`, HOME éphémère, confinement requis). Échec ⇒ `WORKER_DEPENDENCIES_UNAVAILABLE`, le writer **ne démarre pas** (fail-closed). Le store pnpm est ajouté en lecture seule au sandbox du writer. |
| `src/server/workspace-manager/sandboxed-command-runner.ts`      | `offlineInstallEnv()` : `pnpm_config_store_dir=<store>` (le store réel, celui qui est monté `ro`), `pnpm_config_trust_lockfile=true` (pas de revérification registre dans le sandbox), `pnpm_config_frozen_store=true` (index SQLite ouvert en URI immuable). pnpm 11 lit `pnpm_config_*`, pas `npm_config_*`.                                     |
| `src/server/workspace-manager/integration-gate.ts`              | L'étape de porte utilise `offlineInstallEnv()` : la porte avait exactement le même défaut.                                                                                                                                                                                                                                                      |

**Résultat mesuré** (worktree vierge du dépôt cible, bwrap, `--unshare-all`, store `ro`) :
`649 paquets, reused 649, downloaded 0, Done in 1m 1s` ; puis dans le même sandbox
`pnpm exec eslint src/core/autonomy/learning-harvester.ts` → 1 warning attendu (10,8 s) et
`pnpm vitest run src/core/autonomy/learning-harvester.test.ts` → 25/25 (4,4 s). Étapes de porte sur
le même worktree : typecheck 113 s, lint 147 s (0 erreur).

## Sécurité et reproductibilité — ce qui change, ce qui ne change pas

- **Pas de réseau, pas de secret** : l'installation tourne avec le runner de la porte (réseau coupé, HOME éphémère, `envPassthrough: []`) ; l'environnement est construit, jamais hérité (test « aucune variable du serveur n'atteint une étape »). Aucun identifiant de production n'est nécessaire.
- **Reproductible** : `--frozen-lockfile` (le lockfile du commit de base, inchangeable par l'install) + `--offline` (seul le contenu déjà présent dans le store peut être lié ; aucun paquet nouveau ne peut entrer). `frozen_store` rend le store **immuable pour pnpm aussi** — l'install ne peut ni polluer ni modifier le cache partagé.
- **`trust_lockfile`** ne désactive aucun contrôle *de ce dépôt* : il saute la *revérification* par pnpm 11 (`minimumReleaseAge`, attestations) qui exige le registre — contrôle impossible hors ligne et déjà exercé là où le lockfile a été produit (poste de dev/CI, avec réseau). Le sandbox n'est pas le lieu où la politique de chaîne d'approvisionnement se décide ; ce choix est documenté dans pnpm pour « CI runs against an already-verified lockfile ».
- **Un writer qui modifierait `pnpm-lock.yaml`** : l'install pré-lancement a lieu *avant* qu'il n'écrive ; l'install de porte reste `--frozen-lockfile --offline` (un lockfile modifié hors de son file scope est refusé par la vérification de périmètre de la porte ; un lockfile modifié dans le périmètre ne peut lier que des paquets déjà en store). Résiduel à garder en tête : le file scope d'une mission ne devrait jamais inclure `pnpm-lock.yaml` sans revue humaine.
- **Coût disque** : liens durs impossibles entre deux montages (`EXDEV`) → pnpm copie (≈ 930 Mo par worktree, éphémère, 257 Go libres). À surveiller si plusieurs worktrees vivent en parallèle.

## Tests

- `src/server/execution/temporal/worktree-dependencies.test.ts` (nouveau) : `DEPS_INSTALLED_OFFLINE_IN_SANDBOX` (ordre install → lancement, `allowNetwork:false`, `confinement:"required"`, variables exactes, store `ro` et jamais `rw`), `DEPS_PRESENT_NOT_REINSTALLED`, `NOT_A_PACKAGE_NEEDS_NOTHING`, `DEPS_UNAVAILABLE_FAILS_CLOSED` (le writer ne démarre pas), `GATE_INSTALL_COMMAND_REUSED`.
- `src/server/workspace-manager/sandboxed-command-runner.test.ts` : variables d'environnement de porte mises à jour (les trois clés pnpm, store identique à celui monté `ro`).
- `src/server/execution/temporal/metered-egress-activity.test.ts` : l'argv contient l'objectif suivi du bloc d'environnement (W7).
- Suites `src/server/execution/temporal` + `src/server/workspace-manager` : 342/342.

## Critères d'acceptation (pour clore W10)

1. Un run labo où le writer exécute lui-même `pnpm exec eslint <scope>` et `pnpm vitest run <scope>` dans son sandbox et en rapporte la sortie (trace `SPEND_USAGE_SPLIT` + rapport du writer).
2. Le reviewer indépendant rend `APPROVE` sur cette preuve ; `IntegrationGate` passe install/typecheck/lint/unit ; `mission.succeeded`.
3. Aucun appel réseau pendant l'install (bwrap `--unshare-all`, `allowNetwork:false`) ; aucun secret dans l'environnement de l'install.
4. En production : `ICOS_GATE_COMMANDS.install` inchangé (`pnpm install --frozen-lockfile --offline`), le store pnpm du compte de service existant (`defaultToolchainReadOnlyPaths`), Node ≥ 22.15 (URI SQLite immuable — VPS : Node 24).
