# AUTONOMY NOW — Runbook d'activation VPS (préparé, rien d'appliqué)

Préparé par FABLE 5.1, 2026-10-11. Chaque étape ci-dessous **modifie la production** et exige
l'autorisation explicite du propriétaire (politique de release). Rien n'a été exécuté en prod.
Le détail de chaque commande, des préconditions et des rollbacks de la souveraineté VPS est dans
`deploy/vps/README.md` (commit 449fda6) : ce runbook n'y ajoute que l'ordre, les tests préalables,
ce qui manque pour la première mission autonome, et les preuves attendues.

## 0. État de départ (mesuré)

- Live : `icos-web.service` sert `/srv/icos/worktrees/vps-deploy` @049a7d9 (aucun code autonomie).
- Convergence : `feat/fable-5-1-convergence` = hub `d3edd8a` + `449fda6` + `cb10490` + `6239646`,
  3 fusions sans conflit, `tsc --noEmit` exit 0, 801 tests unitaires PASS (54 fichiers) sur les
  modules fusionnés. Non poussée, non déployée.
- Labo N1 run3 (`icos_lab_run4`) : cycle complet sans opérateur jusqu'à `mission.failed`
  (worker Claude Code : `error_max_budget_usd`), 48 appels modèle tous UNPRICED. Le labo est
  la propriété du worker p0-autonomy-unblock, qui itère (run4 démarré 20:27).
- Temporal : namespaces `temporal-system`, `default` seulement, sur le serveur partagé
  (`icos-test-temporal`) comme sur le labo. Preuve d'isolation faite sur le **labo** :
  namespace `icos-fable-lab` créé (id dfe94f55…), `workflow list` vide — la commande est validée.

## 1. Préalables sans effet prod (faisables maintenant, sur autorisation A — faits/faisables)

| # | Vérification | Résultat / commande |
| --- | --- | --- |
| P1 | Convergence typecheck + unit | fait : exit 0, 801/801 |
| P2 | Scripts du kit | `bash -n` OK ×3 ; `systemd-analyze verify` : seule remarque = `/srv/icos/bin/icos-backup.sh` non installé (attendu) |
| P3 | Suites d'intégration ciblées (PG jetable, Temporal labo) | à lancer sur la convergence : `gate-report-audit`, `postgres-external-worker-dispatch`, `p0-autonomy-e2e` — nécessitent un PG jetable dédié (ne pas réutiliser les conteneurs `p0au-*` d'un autre worker) |
| P4 | Preuve bwrap sur l'hôte | `claude-executor` bwrap réel : inclus dans P1 (suite workers) ; profil `/etc/apparmor.d/bwrap` présent |
| P5 | Verdict labo run4 | attendre le worker p0-autonomy-unblock ; critère : `missions.status=completed` + artefact + revue |
| P6 | Résolution `error_max_budget_usd` | lane W10 ; hypothèse : le CLI Claude calcule son propre coût sur un modèle inconnu → plafond `--max-budget-usd` atteint à vide. À confirmer avant toute activation prod |

## 2. Séquence d'activation (chaque ligne = une autorisation)

| Étape | Action | Test préalable | Preuve de succès | Rollback |
| --- | --- | --- | --- | --- |
| B1 | Env souveraineté : ajouter `ICOS_REPO_PATH`, `ICOS_WORKER_WORKSPACE_ROOT`, `ICOS_WORKSPACE_ROOT` (`deploy/vps/env/icos.env.sovereignty.example`), `systemctl restart icos-web` | `icos-sovereignty-check.sh` avant ; `.bak` daté | `MAC_DEPENDENCY_ZERO=PASS` | restaurer `.bak`, restart |
| D | Namespace Temporal prod : `temporal operator namespace create --namespace icos-prod --retention 720h` sur `icos-test-temporal` ; `TEMPORAL_NAMESPACE=icos-prod` pour icos-web **et** le worker | commande validée sur le labo (§0) | `namespace describe icos-prod` = Registered ; `workflow list` vide | retirer la variable ; le namespace peut rester (inerte) |
| F1 | Release : déployer la convergence dans un répertoire de release immuable (`/srv/icos/releases/<sha>`), `pnpm install --frozen-lockfile --offline`, `pnpm build`, pointer `WorkingDirectory` de `icos-web`, restart | P1–P3 PASS ; `pnpm build` hors prod d'abord (charge : à faire hors run labo) | `/login` 200 via Tailscale ; `journalctl -u icos-web` sans erreur ; voix OK | repointer `WorkingDirectory` sur `vps-deploy`, restart |
| B2 | Env autonomie (`deploy/vps/env/icos.env.autonomy.example`, `<RELEASE>` renseigné), retirer `ICOS_REVIEWER_COMMAND=printf` (R7) | PG jetable pour la porte joignable ; `claude --version` ; `bwrap --version` | `icos-web` démarre ; `COMPUTE_BOOTSTRAP` sans `PROVIDER_UNAVAILABLE` | restaurer `.bak`, restart |
| B3 | Worker : `icos-temporal-worker.service` (README étape 2) | `systemd-analyze verify` | `ICOS_WORKERS_VPS=PASS` ; 2 pollers sur `icos-tasks`/`icos-prod` ; `kill -9` → relance ≤ 10 s | README rollback étape 2 |
| B4 | Sauvegardes : `icos-backup.timer` (README étape 3) | restauration labo déjà prouvée (1000/1000) | premier dump + `SHA256SUMS` dans `/srv/icos/backups/daily/` | README rollback étape 3 |
| C | OmniRoute « Require API key » (dashboard, propriétaire) puis Tailscale :8443 (README étape 4) | `omniroute-remote-access.sh` dry-run tout `OK` | `/v1/chat/completions` sans clé → 401 ; ICOS (avec clé) inchangé | `--rollback` |
| E | Première mission : contrat `.icos/contracts/AUTONOMY-NOW-001.yaml` ; déclenchement = détection W11 au prochain passage du scheduler (pas de lancement manuel) | B1–B3, D, F1 PASS ; session SSH fermée pendant le cycle | critères d'acceptation du contrat ; `pnpm mission:trace` | `git branch -D integration/autonomy-now-001` + suppression du worktree |

Ordre recommandé : B1 → D → F1 → B2 → B3 → B4 → E ; C indépendant (sécurité, avant toute
exposition Tailscale d'OmniRoute).

## 3. Ce que ce runbook ne résout pas (décisions ou lanes tierces)

- **Prix** : `ICOS_PRICE_REGISTRY` est vide par conception (un prix sans provenance est refusé) →
  `budget_eur` n'est pas opposable ; seul le plafond en tokens l'est. Renseigner le registre avec
  provenance/date est une décision propriétaire (tarifs réels des providers OmniRoute).
- **Modèle Claude réel** : derrière OmniRoute, `auto/claude-sonnet` est servi par gemini-3.1-flash-lite ;
  l'exécuteur tourne aujourd'hui sur `codex/gpt-5.5-low`. Choix du modèle d'exécution = propriétaire.
- **Stabilité OmniRoute** : timeouts `/v1/models` et `PROVIDER_UNAVAILABLE` observés sous charge
  (load 13.9 à 20:15, 10 conteneurs PG de labo). Lane OmniRoute ; réduire les conteneurs `p0au-pg-*`
  inactifs est une décision des workers propriétaires.
- **Temporal prod dédié** (R3, cible) et **copie hors-hôte des sauvegardes** (R2) : budget.
