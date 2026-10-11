# ICOS — Audit de souveraineté VPS (P0, 2026-10-11)

Hôte : `icos-node-01` (Contabo, Ubuntu, 8 vCPU, 23 GiB RAM, 290 GB disque, 11 % utilisé).
Méthode : mesures directes sur le VPS (systemd, docker, ss, tailscale, Temporal CLI, requêtes
agrégées en lecture sur la base de prod, appels réels à OmniRoute). Aucun service de
production redémarré, aucune configuration de production modifiée, aucun secret affiché.
Re-mesurable à tout moment : `deploy/vps/bin/icos-sovereignty-check.sh` (lecture seule).

## Verdicts

```
MAC_DEPENDENCY_ZERO=FAIL
OMNIROUTE_VPS=PASS
ICOS_SERVICES_PERSISTENT=PASS
ICOS_INTERNAL_ROUTING=PASS
ICOS_REMOTE_ACCESS=PASS
ICOS_WORKERS_VPS=FAIL
AUTONOMY_WITHOUT_MAC=FAIL
```

En une phrase : **tout ce qui tourne aujourd'hui tourne sur le VPS sans le Mac** (cockpit,
voix, cognition, OmniRoute, scheduler, superviseur, PostgreSQL, Temporal) — mais **ICOS n'a
jamais exécuté une seule mission autonome en production** : aucun worker ne consomme la file
`icos-tasks`, aucun exécutant (Hermes/Codex/Claude) n'est configuré, et deux chemins de
code retombent encore sur `/Users/coco`.

## 1. Inventaire mesuré

| Composant                          | Hébergement réel                                                                                          | État mesuré                                                                                         | Démarrage au boot                          | Sans Mac ?                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| ICOS Web + API + cockpit + voix WS | `icos-web.service`, 127.0.0.1:3100, arbre `/srv/icos/worktrees/vps-deploy` @049a7d9                       | actif depuis 2026-10-10 23:56, 0 redémarrage                                                        | `enabled`                                  | Oui                                    |
| Scheduler + Runtime Supervisor     | dans le processus `icos-web` (`instrumentation.ts` → `startProductionServices`)                           | `probe_workers` toutes ~30 s, `supervisor_observe` toutes 15 min, 0 erreur ; dernier passage < 30 s | via icos-web                               | Oui                                    |
| Chief / CORE3 / DOTS / Workforce   | code dans icos-web ; 8 workers « compute » actifs en table `workers`                                      | `missions`, `tasks`, `dispatch_attempts` : **0 ligne**                                              | via icos-web                               | Oui (mais jamais exercé en prod)       |
| Worker d'exécution Temporal        | `pnpm worker:temporal` — **aucune unité, aucun processus**                                                | file `icos-tasks` : **0 poller**, 0 workflow de prod depuis toujours                                | —                                          | **Non : absent**                       |
| OmniRoute 3.8.49                   | `icos-omniroute.service`, 127.0.0.1:20129 (dashboard+API), :20131 (proxy WS embarqué), :20132 (live WS)   | actif depuis 11:34 ; appel réel `nemotron-3-ultra` → `PONG` ; 272 modèles                           | `enabled`                                  | Oui                                    |
| PostgreSQL app                     | conteneur `icos-app-postgres` 127.0.0.1:5433, volume nommé `icos-app-postgres-data`                       | sain                                                                                                | `restart=unless-stopped`, docker `enabled` | Oui                                    |
| Temporal                           | conteneur `icos-test-temporal` 127.0.0.1:7233, persistance dans `icos-test-postgres` (volume **anonyme**) | sain, namespace `default`                                                                           | `unless-stopped`                           | Oui — mais partagé avec les tests (R3) |
| Mémoire                            | tables `memory_records` (58), `mission_memory_entries` dans la base app                                   | OK                                                                                                  | via PG                                     | Oui                                    |
| Claude Code                        | `/usr/bin/claude` 2.1.292, identifiants `~/.claude` présents                                              | installé ; pas d'exécutant ICOS câblé en prod                                                       | —                                          | Oui (poste de dev)                     |
| Hermes                             | **absent du VPS** ; historiquement `~/temporal-poc` sur le Mac (`docs/icos/handoffs/temporal-poc-worker`) | —                                                                                                   | —                                          | **Non : non installé**                 |
| Codex CLI                          | absent                                                                                                    | —                                                                                                   | —                                          | Non                                    |
| Accès distant                      | `tailscaled` + `tailscale serve` 443 → 127.0.0.1:3100, tailnet seulement, pas de Funnel                   | `https://icos-node-01.tail2ea2a5.ts.net/login` → 200                                                | `enabled`                                  | Oui                                    |
| Journaux                           | journald persistant (`/var/log/journal`)                                                                  | 8 MB                                                                                                | —                                          | Oui                                    |
| Sauvegardes                        | **aucune** pour PG app, Temporal ; 2 copies manuelles OmniRoute (root, 11/10)                             | —                                                                                                   | —                                          | Non (R2)                               |
| Credentials / env                  | `/srv/icos/etc/icos.env` (600), `/srv/icos/etc/omniroute.env` (600), `~/.omniroute/server.env`            | aucune URL ni chemin Mac                                                                            | —                                          | Oui                                    |
| Git / worktrees                    | `/srv/icos/repo` (main) + 23 worktrees sous `/srv/icos/worktrees` ; remote GitHub                         | les services ne lisent pas GitHub à l'exécution                                                     | —                                          | Oui                                    |

Processus et SSH : `icos-web` et `icos-omniroute` sont dans `system.slice`, pas dans une
session SSH — fermer SSH ne les touche pas. Les seules connexions venant du Mac sont des
**accès** (tunnel `ssh -L` vers 127.0.0.1:20129 pour le dashboard OmniRoute), pas des
dépendances : le VPS n'ouvre aucune connexion vers le Mac.

## 2. Dépendances au Mac trouvées

| #   | Où                                                                                                                                                                                                             | Effet                                                                          | Correctif préparé                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `src/server/workspace-manager/guards.ts` : `DEFAULT_MASTER_REPO=/Users/coco/icos`, `DEFAULT_WORKTREE_ROOT=/Users/coco/icos-worktrees` ; la prod ne définit ni `ICOS_REPO_PATH` ni `ICOS_WORKER_WORKSPACE_ROOT` | toute création de workspace en prod viserait des chemins Mac                   | variables d'env (`deploy/vps/env/icos.env.sovereignty.example`) — pas de modification de code : ces fichiers sont dans le périmètre de p0-autonomy-unblock |
| M2  | `ICOS_WORKSPACE_ROOT` non défini                                                                                                                                                                               | les tâches « lire le dépôt » sont refusées par le worker                       | idem                                                                                                                                                       |
| M3  | `src/server/execution/digitalos-task-execution-dispatcher.ts:77` : `baseDir: "/Users/coco/digitalos-…"` en dur                                                                                                 | latent : `CompositeTaskExecutionDispatcher` n'est instancié nulle part en prod | à corriger si DigitalOS est réactivé (le projet DigitalOS n'existe pas sur le VPS)                                                                         |
| M4  | Hermes et l'ancien worker PoC vivaient sur le Mac                                                                                                                                                              | aucun exécutant d'agent sur le VPS                                             | décision propriétaire (cf. Blocages)                                                                                                                       |
| M5  | Dashboard OmniRoute consulté via tunnel SSH depuis le Mac (:20130)                                                                                                                                             | dépendance d'**accès** du propriétaire                                         | `deploy/vps/tailscale/omniroute-remote-access.sh`                                                                                                          |

Les fichiers `icos.env.bak-*` contiennent d'anciennes valeurs Mac ; ils ne sont pas lus.

## 3. OmniRoute

- ICOS → `OMNIROUTE_BASE_URL=http://127.0.0.1:20129` : direct, loopback, sans Mac. Ports
  liés à 127.0.0.1 uniquement (20129, 20131, 20132).
- Ports : 20129 = dashboard + API OpenAI-compatible (même port) ; 20131 = proxy WS des
  services embarqués (`EMBED_WS_PROXY_PORT`, doit rester loopback) ; 20132 = WS de
  monitoring live (`LIVE_WS_PORT`, auth par jeton : `Missing token`). 20130 n'existe pas
  sur le VPS : c'était le port local du tunnel côté Mac.
- Appels réels : `nvidia/nvidia/nemotron-3-ultra-550b-a55b` → `PONG` (HTTP 200, 1–11 s).
  OmniRoute **streame par défaut** si `stream` est omis : tout client doit envoyer
  `"stream": false` pour une réponse JSON.
- Authentification : dashboard et `/api/*` exigent une session (401) ; **`/v1/chat/completions`
  répond aux appels sans clé et avec une clé invalide (200)**. Sans conséquence tant que tout
  reste en loopback ; bloquant pour toute exposition Tailscale (cf. R1).
- Supervision : `Restart=on-failure`. Les 12 redémarrages du 11/10 11:15 sont des
  `203/EXEC` pendant une mise à jour du binaire (boucle arrêtée à la main), pas des crashs.

## 4. Risques

| #   | Gravité | Risque                                                                                                                                                                                                                                                                         | Action                                                                                                                                                                                   |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Haute   | OmniRoute `/v1` sans authentification : tout processus local (dont un agent mal confiné) peut consommer les providers hors budget ICOS ; exposé via Tailscale, tout appareil du tailnet le pourrait                                                                            | Propriétaire : activer « Require API key » dans OmniRoute (réglage stocké en SQLite, non modifiable par automate) ; le script Tailscale refuse de s'appliquer tant que ce n'est pas fait |
| R2  | Haute   | Aucune sauvegarde de la base app ni de Temporal                                                                                                                                                                                                                                | `icos-backup.timer` préparé et testé en labo ; copie hors-hôte encore à décider (budget)                                                                                                 |
| R3  | Haute   | Le Temporal de prod est le conteneur `icos-test-temporal`, partagé avec les suites d'intégration (220 workflows de test « Running » dans `default`, centaines de bases `icos_test_*` dans le même Postgres, volume anonyme) : un nettoyage de labo peut effacer l'état de prod | Court terme : namespace `icos-prod`. Cible : Temporal de prod dédié (conteneur + volume nommé) — changement de config prod, décision propriétaire                                        |
| R4  | Moyenne | Prod servie depuis un worktree git (`vps-deploy`) : un `git checkout` dans ce dossier change la prod au prochain redémarrage                                                                                                                                                   | Déployer sur un répertoire de release immuable lors de la prochaine release                                                                                                              |
| R5  | Moyenne | `vps-deploy` (049a7d9) a 48 commits de retard sur `main` et 5 commits voix absents de `main` : le travail P0 autonomie n'est pas en prod                                                                                                                                       | Intégration = décision de release                                                                                                                                                        |
| R6  | Moyenne | Sondes `probe_workers` : ~14 200 appels modèle/24 h, 864 k tokens, `UNATTRIBUTED`/`UNPRICED`                                                                                                                                                                                   | Signalé à p0-autonomy-unblock (domaine workers) ; ne pas corriger ici                                                                                                                    |
| R7  | Moyenne | `ICOS_REVIEWER_COMMAND` = `/usr/bin/printf` : le relecteur renvoie le prompt tel quel                                                                                                                                                                                          | À remplacer par un relecteur réel avant toute mission autonome                                                                                                                           |
| R8  | Basse   | Cookies partagés entre :443 (ICOS) et :8443 (OmniRoute) sur le même hôte                                                                                                                                                                                                       | Accepté ; nom d'hôte séparé via Tailscale Service si besoin (nœud à tagger)                                                                                                              |
| R9  | Basse   | Pas de swap, sauvegardes sur le même disque                                                                                                                                                                                                                                    | Hors périmètre immédiat                                                                                                                                                                  |

## 5. Démonstrations faites (sans toucher la production)

1. **Script de vérification** — exécuté deux fois ; il a d'abord trouvé un défaut dans
   ma propre sonde (réponse streamée), corrigé ; la sortie finale donne les verdicts ci-dessus.
2. **Worker sous systemd (labo)** — l'unité préparée, copiée en unité utilisateur (seuls
   chemin/env/durcissement adaptés, `diff` conservé), lancée contre le Temporal de labo
   `p0au-temporal` sur une file isolée `p0vs-lab-*` : 2 pollers (workflow + activity),
   plafonds cgroup actifs (`MemoryHigh 6G / MemoryMax 8G / TasksMax 1024`). `kill -9` →
   `auto-restart`, nouveau PID et nouveau poller en ~10 s (`NRestarts=1`). Unité retirée.
3. **Sauvegarde (labo)** — Postgres jetable `p0vs-backup-lab` + SQLite de labo : 3 dumps
   - copie SQLite, `SHA256SUMS` OK, restauration → 1000/1000 lignes, `integrity_check` OK ;
     source absente → code 1, dossier marqué `FAILED`, aucun dump vide. Conteneur supprimé.
4. **Tailscale OmniRoute (dry run)** — préconditions : 443 ICOS OK, :8443 libre, API
   dashboard en 401 ; **refus** car `/v1` non authentifié. Rien appliqué.
5. `systemd-analyze verify` sans erreur sur les unités (hors chemin du script de sauvegarde
   non encore installé).

Non démontré, et pourquoi : mission autonome de bout en bout sur la prod (pas de worker, pas
d'exécutant — c'est précisément le verdict FAIL) ; redémarrage du VPS (interdit sans
autorisation) ; accès depuis le téléphone (hors ligne depuis 1 jour — à faire par le
propriétaire : ouvrir `https://icos-node-01.tail2ea2a5.ts.net` depuis le téléphone).

## 6. Blocages et décisions propriétaire (dans l'ordre)

1. **Release** : intégrer `main` (P0 W1–W11) + les 5 commits voix de `vps-deploy`, et déployer.
2. **Exécutant d'agent** : Claude Code (exécutant W10 de p0-autonomy-unblock), ou installer
   Hermes/Codex sur le VPS → renseigner `ICOS_WORKER_EXEC_COMMANDS`.
3. **Appliquer** `deploy/vps/README.md` étapes 1 (env), 2 (worker), 3 (sauvegardes).
4. **OmniRoute** : activer « Require API key », puis étape 4 (Tailscale :8443).
5. **Temporal de prod** dédié ou namespace `icos-prod` (R3).

Après 1–3, relancer le script : `ICOS_WORKERS_VPS` et `MAC_DEPENDENCY_ZERO` doivent passer
PASS ; `AUTONOMY_WITHOUT_MAC` exige en plus l'exécutant (2) et une mission réelle observée
de bout en bout.

## 7. Coordination

Aucun fichier de p0-autonomy-unblock (ni des branches `p0au-*`) modifié : `workspace-manager/*`,
`env.ts`, `container.ts` et l'exécution Temporal sont dans leur périmètre — les correctifs M1/M2
passent donc par la configuration. Les conteneurs `p0au-*` n'ont été lus qu'une fois
(`p0au-temporal`, file isolée) pour le test du worker.
