# Revue indépendante — sécurité (COCKPIT-LIVE D1 + D2)

- **Reviewer :** agent séparé `security-reviewer` (contexte vierge, modèle Claude Opus — même éditeur que l'auteur, famille différente de Fable 5.1 ; limite documentée).
- **SHA examiné :** `a252d9d` (base `b4d0968` ; D1 `0c02453`, D2 `aef657c`).
- **Verdict :** **REQUEST_CHANGES (mineur)** — aucun P0/P1 ; trois P2, quatre P3.
- **Tests exécutés par le reviewer :** `src/app/api/cockpit/live/route.test.ts`, `src/app/api/cockpit/telemetry/route.test.ts`, `src/server/telemetry`, `src/features/cockpit/observed.test.ts`, `src/server/database/health.test.ts` → 9 fichiers, 70 tests PASS.

## Constats

| Sév. | Emplacement | Constat | Correction recommandée |
| --- | --- | --- | --- |
| P2 | `src/app/api/cockpit/telemetry/route.ts` | **Incohérence de portée** : la route télémétrie sert hôte, sondes et faits de flotte à tout `operator` (portée liée), alors que `/api/cockpit/live` et `loadSources` réservent ces sources à owner/admin (portée globale). | Conditionner la route à `resolveOperationalScope(...).kind === "global"` (ou blanchir flotte/hostname hors portée globale), et rendre `/live` cohérent. |
| P2 | `src/features/cockpit/live-overview.ts` (`attempts`) | **Zéro fabriqué** : si la lecture des dispatches échoue, core3 publie `{ nonTerminal: 0 }` dans une source `ok` ; l'UI affiche « 0 dispatch(es) » et éteint l'indicateur d'activité. | `attempts` nullable + `attemptsErrorCode`, source core3 dégradée. |
| P2 | `src/app/api/cockpit/live/route.ts`, `live-sources.ts`, `load.ts` | **Coût par requête sans limite** : `/live` ouvert à tout `cockpit.read` sans rate limit ; N+1 missions ; ~7 agrégats non indexés (`spend_ledger.observed_at` sans index, ~199 k lignes) ; `loadLiveOverview` refait les scans de `loadTruthProjection` à chaque `router.refresh()` (15 s/onglet). | Appliquer `FixedWindowRateLimiter` à `/live` ; réutiliser `loadTruthProjection` ; envisager un index `spend_ledger(observed_at)`. |
| P3 | `src/server/telemetry/omniroute-monitoring.ts` | `fetch` suit les redirections (base URL uniquement depuis l'env, non exploitable). | `redirect: "error"`. |
| P3 | `src/features/cockpit/live-sources.ts` | `tenantId` étiqueté mais aucun prédicat `tenant_id` sur `spend_ledger`, mémoire, `scheduled_jobs` (exact en mono-tenant). | Prédicat ou assertion liée au shim mono-tenant. |
| P3 | `src/features/cockpit/live-sources.ts` | Pas de `statement_timeout` sur les agrégats (même motif que `load.ts`). | Délai borné. |
| P3 | `scripts/cockpit-live-verify.ts` | Le catch-all imprime `error.message` (hôte/port/utilisateur possibles, jamais le mot de passe). | Message fixe + `error.code`. |
| P3 | `live-overview.ts` | Les `source` nomment des tables et chemins `/proc` (statique, sans secret). | Acceptable, noté. |

## Points vérifiés sains

Authentification via `protectRoute` (refus audités) et `getCockpitContext` ; aucun paramètre/en-tête/cookie n'influence tenant, portée, fichiers ou hôtes ; chemins `/proc` en union fermée, `/sys/class/net` et cgroup filtrés ; erreurs driver masquées ; champs OmniRoute en liste blanche (`lastFailure`, sessions, quotas jamais lus) ; React échappe tout ; lecture seule (SELECT, `select 1`, GET sans clé), corps borné 64 KiB, délais, cache 15 s avec vol unique ; modes d'échec typés ; limite 60/min sur la télémétrie ; script de vérification en session `default_transaction_read_only`.

## Risques résiduels signalés

Typecheck non exécuté par le reviewer ; comportement `default_transaction_read_only` de postgres.js non vérifié ; coût réel du scan `observed_at` non mesuré ; `telemetry-client.ts` non importé (code mort côté client) ; `LiveRefresh` est l'amplificateur du P2 coût.
