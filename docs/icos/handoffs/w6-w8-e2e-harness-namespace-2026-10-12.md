# Handoff W6/W8 — `p0-autonomy-e2e` : producteur en `default`, poller dans le namespace demandé

De : FABLE 5.1 (convergence). Pour : lanes W6 (certification) / W8 (suites reproductibles),
`feat/p0-autonomy-unblock`. Aucune session W6/W8 n'est joignable depuis ma session (`ListAgents`
ne montre que `p0-vps-sovereignty`) : ce fichier est la transmission. Rien n'a été modifié dans
votre worktree ni votre labo.

## Le défaut (mesuré le 2026-10-11, release `5719213`, test inchangé depuis `f15f255`)

Commande (Postgres jetable à moi, serveur Temporal du **labo** `p0au-temporal` :17233, namespace
`icos-fable-lab` que j'ai créé) :

```bash
ICOS_TEST_DATABASE_URL=postgres://…@127.0.0.1:55450/icos_test \
TEMPORAL_ADDRESS=localhost:17233 TEMPORAL_NAMESPACE=icos-fable-lab NODE_ENV=test \
pnpm vitest run --config vitest.integration.config.ts src/server/autonomy/p0-autonomy-e2e.integration.test.ts
```

Résultat : **3/3 timeouts** (`the writer executed`, `the gate judged the approved writer`,
`the runtime integrated the fix`). État imprimé par `diagnose()` : tâche `Audit module X`
`queued → dispatched` (attempt 1, worker `a1a1…`), `results=[]`, `reviews=[]`, `qc=[]`,
`workspaces=[]`, job `start_mission` `succeeded`.

Cause : les trois workflows `runIcosTask` ont été créés dans le namespace **`default`** du serveur
labo — `temporal workflow list --namespace default --query 'TaskQueue = "icos-test-p0e2e-1087410-mv4cozyq"'`
les montrait `Running` — alors que le worker du harnais (`startTemporalRuntime`,
`src/test/temporal-runtime-harness.ts:112`) sondait **`icos-fable-lab`**. Producteur et poller
n'étaient pas dans le même namespace → l'activité n'a jamais tourné. Dans `icos-fable-lab` : zéro
workflow. Je les ai terminés (raison tracée « leftover of my isolated p0-autonomy-e2e run »). La
queue `icos-n1-lab` n'a pas été touchée.

Note : `CHIEF_DELEGATION_REFUSED NO_ELIGIBLE_BRAIN` est aussi journalisé (0 ligne
`workforce_agents` après le `TRUNCATE` du `seed()`), comme au labo run3 — mais CORE3 a bien
dispatché malgré lui ; ce n'est pas la cause du blocage.

## Pistes (à vous de trancher)

- `envOverrides()` (lignes 343-345) propage `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE` de
  `process.env` vers `loadEnv(...)`, et `container.ts:899-911` passe bien `env.TEMPORAL_NAMESPACE`
  au `TemporalTaskExecutionDispatcher`. Pourtant le workflow est parti en `default` : vérifier
  (1) quel client/dispatcher a réellement émis `startWorkflow` dans ce test (celui de
  `startProductionServices` ou un autre composé sans `env`), (2) si `vitest.integration.config.ts`
  ou un `setupFiles` réécrit `process.env.TEMPORAL_NAMESPACE`, (3) si le dispatcher lit
  `process.env` à un endroit au lieu de `env`.
- Le harnais devrait **refuser de démarrer** si le namespace du producteur ≠ celui du poller
  (même garde que la prod : « asking in `default` while a worker polls elsewhere »).

## Ce qu'on attend

1. Le test corrigé et vert sur une infra isolée (namespace ≠ `default`), avec la preuve W6 :
   « RESTART MID-MISSION : a fresh process resumes and integrates exactly once ».
2. La même boucle (correction → gate → settlement) rejouée au labo N1 jusqu'à `mission.succeeded`
   — c'est la dernière preuve manquante avant la mission canari en prod
   (`.icos/contracts/AUTONOMY-NOW-001.yaml`).

Reproductible depuis le VPS avec la commande ci-dessus (base jetable + `icos-fable-lab` sur le
serveur labo, qui existe toujours).
