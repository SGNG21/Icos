# Contrat API cockpit OmniRoute v1

Statut : contrat backend stable pour intégration frontend. Toute modification incompatible exige un nouveau numéro de `schema`.

## Endpoint

`GET /api/cockpit/omniroute`

- lecture seule ; aucun paramètre de requête ;
- runtime serveur ICOS uniquement ; le navigateur n'appelle jamais OmniRoute directement ;
- session ICOS requise ;
- rôle minimal `operator`, puis portée opérationnelle globale obligatoire (`owner` ou `admin`) ;
- même rate limiter que `/api/cockpit/telemetry` ;
- réponse `Cache-Control: no-store, max-age=0` ;
- aucune URL interne, clé API, credential, identifiant de connexion, tenant ledger ou identifiant de modèle dans la réponse.

Codes HTTP :

| Code  | Condition                                                          |
| ----- | ------------------------------------------------------------------ |
| `200` | contrat v1, y compris lorsque certaines sources sont indisponibles |
| `401` | session absente ou invalide                                        |
| `403` | rôle insuffisant ou portée non globale                             |
| `429` | quota de lecture dépassé, avec `Retry-After`                       |
| `500` | erreur ICOS non isolable                                           |

Les indisponibilités OmniRoute, catalogue ou ledger ne deviennent pas des erreurs HTTP : chaque sous-source porte son propre état `available`.

## Réponse 200

```ts
type MissingCode =
  | "NOT_CONNECTED"
  | "FORBIDDEN_SCOPE"
  | "READ_FAILED"
  | "PROBE_MISSING"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNREACHABLE"
  | "UPSTREAM_HTTP"
  | "UPSTREAM_TOO_LARGE"
  | "UPSTREAM_INVALID";

type Available<T> = { available: true; value: T } | { available: false; code: MissingCode };

type OmniRouteCockpitV1 = {
  schema: 1;
  generatedAt: string; // ISO-8601 UTC
  readOnly: true;

  health: Available<{
    state: "operational" | "degraded" | "down" | "not_instrumented" | "not_connected";
    detail: string;
    checkedAt: string | null;
    latencyMs: number | null;
  }>;

  providers: Available<{
    configured: number | null;
    active: number | null;
    openBreakers: number | null;
    degradedBreakers: number | null;
    providers: Array<{
      id: string;
      state: "healthy" | "degraded" | "down" | "unknown";
      failures: number | null;
    }>;
  }>;

  models: Available<{
    listed: number;
    byProvider: Record<string, number>;
  }>;

  usage: Available<{
    window: "24h";
    calls: number;
    meteredCalls: number;
    unmeteredCalls: number;
    tokens: number;
    tokensUnknownCalls: number;
    lastObservedAt: string | null;
  }>;

  cost: Available<{
    window: "24h";
    status: "PRICED" | "FREE_TIER" | "UNPRICED" | "MIXED_CURRENCY" | "NO_TRAFFIC";
    amount: number | null;
    currency: string | null;
    pricedCalls: number;
    freeTierCalls: number;
    unpricedCalls: number;
  }>;

  errors: {
    window: "24h";
    available: false;
    code: "NOT_INSTRUMENTED";
  };

  latency: {
    window: "24h";
    available: false;
    code: "NOT_INSTRUMENTED";
  };
};
```

Le schéma exécutable est `src/server/omniroute/cockpit-contract.ts` et doit rester la source de vérité.

## Sémantique des données

- `health` et `providers` viennent de la sonde monitoring OmniRoute déjà utilisée par ICOS.
- `models` interroge `/v1/models` côté serveur, puis ne conserve que le nombre total et des comptes par préfixe fournisseur. Les identifiants de modèles ne quittent pas le serveur. Cette lecture d'agrégats autorise au maximum 2 000 modèles et 512 Kio, sans relever les limites plus strictes du chemin d'enregistrement de flotte.
- `usage` et `cost` utilisent le ledger de dépenses ICOS sur les dernières 24 heures. Une lecture impossible produit `READ_FAILED`, jamais des zéros inventés.
- `errors` et la distribution de `latency` ne sont pas instrumentés de façon fiable dans le ledger ou l'API autorisée actuelle. Ils restent explicitement `NOT_INSTRUMENTED`.
- Une défaillance d'une sous-source n'efface pas les autres sous-sources disponibles.

## Exemple minimal : OmniRoute non connecté

```json
{
  "schema": 1,
  "generatedAt": "2026-10-21T18:00:00.000Z",
  "readOnly": true,
  "health": { "available": false, "code": "NOT_CONNECTED" },
  "providers": { "available": false, "code": "NOT_CONNECTED" },
  "models": { "available": false, "code": "NOT_CONNECTED" },
  "usage": { "available": false, "code": "NOT_CONNECTED" },
  "cost": { "available": false, "code": "NOT_CONNECTED" },
  "errors": { "window": "24h", "available": false, "code": "NOT_INSTRUMENTED" },
  "latency": { "window": "24h", "available": false, "code": "NOT_INSTRUMENTED" }
}
```

## Constat d'audit ayant borné le contrat

Audit local en lecture seule du 2026-10-21, OmniRoute `3.8.49` sur `127.0.0.1:20129` :

- service actif, aucun redémarrage observé ; ports OmniRoute `20129`, `20131` et `20132` liés à loopback ;
- `/api/health/ping`, `/api/monitoring/health` et `/v1/models` répondent `200` sans authentification réseau locale ;
- `/v1/models` annonçait 719 entrées : raison supplémentaire de ne renvoyer que des agrégats ;
- les surfaces providers, pricing, usage et métriques administratives répondaient `401` anonymement et `403` avec le credential d'inférence disponible ; elles ne sont pas contournées ;
- la santé monitoring expose des données internes plus larges que le besoin UI ; la façade ICOS applique une allow-list stricte ;
- aucune valeur de secret n'a été incluse dans les traces ou ce document.
