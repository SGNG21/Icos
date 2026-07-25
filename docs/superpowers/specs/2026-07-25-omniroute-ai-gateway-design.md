# D3 — AI Gateway / OmniRoute Design

> **Lot** : D3 · Phase D
> **Statut** : SPEC — en cours de revue avant implémentation
> **Prérequis** : C1, D1, D2 (merged)
> **Débloque** : D4

---

## 1. Objectif

Fournir **le plus petit contrat** permettant à D4 (Orchestrateur) d'appeler
l'IA proprement via OmniRoute, sans que le domaine ICOS ne connaisse les
providers, modèles, comptes, credentials, routing technique ou santé
infrastructure.

> **Principe fondateur** : ICOS exprime le **quoi/pourquoi/contraintes métier**.
> OmniRoute choisit le **comment/où/provider/modèle/compte**.

---

## 2. Architecture

```
D4 / Use Case / Runtime
│
▼
AiGatewayPort            ← Port ICOS (couche server)
│
▼
OmniRouteAdapter         ← Implémentation du port
│
▼
OmniRoute HTTP API       ← http://127.0.0.1:20128 (externe, déjà actif)
│
▼
Provider                 ← Anthropic, OpenAI, etc. (administré par OmniRoute)
```

**Flux :**

1. L'appelant (D4 ou un use case) construit un `AiRoutingRequest` avec les
   contraintes métier, le tenant, la classification et l'intention.
2. Le port `AiGatewayPort.generate(request)` est appelé.
3. `OmniRouteAdapter` traduit la requête en appel HTTP vers OmniRoute.
4. OmniRoute route vers le provider adapté et retourne le résultat.
5. L'adapter normalise la réponse en `AiGenerationResult`.
6. L'appelant ne voit jamais les détails techniques du provider.

### Diagramme d'interaction

```text
┌──────────────┐     ┌────────────────┐     ┌──────────────────┐
│ D4/Use Case  │────▶│ AiGatewayPort  │────▶│ OmniRouteAdapter │
│ (ICOS core)  │     │ (server/ai)    │     │ (server/ai)      │
└──────────────┘     └────────────────┘     └───────┬──────────┘
                                                     │
                                                     ▼
                                              ┌──────────────────┐
                                              │ OmniRoute HTTP   │
                                              │ 127.0.0.1:20128 │
                                              └───────┬──────────┘
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │ Provider         │
                                              │ Anthropic/OpenAI │
                                              └──────────────────┘
```

---

## 3. Scope / Non-Scope (D3 V1)

### In scope

| # | Élément | Justification |
|---|---------|---------------|
| 1 | `AiGatewayPort` — interface de génération | Port canonique ICOS |
| 2 | `AiRoutingRequest` — enveloppe métier | Tenant, classification, contraintes |
| 3 | `AiGenerationResult` — résultat normalisé | Provider, usage, latence, coût |
| 4 | `OmniRouteAdapter` — implémentation du port | Mapping ICOS → OmniRoute → ICOS |
| 5 | Routing intent (`BEST_REASONING`, `FAST`, etc.) | Abstraction métier, pas technique |
| 6 | Provider metadata (id, model, account) | Retourné dans le résultat |
| 7 | Usage metadata (tokens, cost, latency) | Retourné dans le résultat |
| 8 | Error model normalisé | `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, etc. |
| 9 | Timeout configurable | Par requête, propagé à fetch + OmniRoute |
| 10 | Cancellation via `AbortSignal` | Standard JS, annule la requête HTTP |
| 11 | Fallback metadata | Signalé dans le résultat, pas piloté par ICOS |
| 12 | Compliance propagation | tenantId, dataClassification transmis |
| 13 | Logging/redaction | Pas de secrets, pas de prompts bruts |
| 14 | Observability hooks | Duration, provider, model, tokens, error |
| 15 | Test strategy | Fake adapter, contract tests, unit tests |

### Not in scope (D3 V1)

| # | Élément | Raison | Lot futur |
|---|---------|--------|-----------|
| 1 | Streaming (`generateStream`) | Peut s'ajouter sans casser le port | D3 V2 ou D4 |
| 2 | Embeddings / Images / Audio | Ports séparés non couverts par D3 | Lots futurs |
| 3 | ACP agents / AgentBridge | Orthogonal à la génération texte | Lots futurs |
| 4 | Memory APIs | Port séparé | E1 |
| 5 | Agent Skills / Fetch / Search | Orthogonal, consomme AiGatewayPort | Lots futurs |
| 6 | Table `ai_generations` | Persistance — relève de l'intégration D4 | D4 |
| 7 | Business routing policy | Abonnement/budget métier | R1 |
| 8 | Usage ledger | Corrélation des coûts | R1 |
| 9 | Operational projections | Health/quota/latence OmniRoute | R2 |
| 10 | OmniRoute management | Credentials, comptes, configuration | R2 |
| 11 | Évaluation métier | Quality scoring | Q1/R3 |

---

## 4. Terminology

| Terme | Définition |
|-------|------------|
| **AiGatewayPort** | Interface ICOS pour la génération IA |
| **AiRoutingRequest** | Requête de génération avec contraintes métier |
| **AiGenerationResult** | Résultat normalisé d'une génération |
| **RoutingIntent** | Intention métier abstraite de l'appel IA |
| **AiError** | Erreur normalisée avec code et classification |
| **OmniRouteAdapter** | Implémentation du port vers OmniRoute |
| **Provider** | Fournisseur IA externe (Anthropic, OpenAI, etc.) |
| **Fallback** | Bascule vers un autre provider en cas d'échec |
| **CorrelationId** | Identifiant traçable vers une Mission/Run D2 |

---

## 5. Contracts (Zod schemas — `core/ai/contract.ts`)

### 5.1 AiRoutingIntent

```typescript
// Intention métier abstraite : ICOS exprime ce qu'il veut,
// pas quel provider utiliser.
export const aiRoutingIntentSchema = z.enum([
  "BEST_REASONING",  // Raisonnement profond, Opus/Fable-level
  "BEST_CODING",     // Génération de code, haute qualité
  "FAST",            // Réponse rapide, qualité moindre acceptable
  "CHEAP",           // Coût minimal, qualité dégradée acceptable
  "PRIVATE",         // Provider local/privé exigé (données sensibles)
  "FALLBACK",        // Fallback explicite, dernier recours
]);
```

### 5.2 AiErrorCode

```typescript
export const aiErrorCodeSchema = z.enum([
  "PROVIDER_UNAVAILABLE",   // Provider injoignable ou en erreur
  "RATE_LIMITED",           // Quota dépassé ou rate limit
  "TIMEOUT",                // Délai d'attente dépassé
  "INVALID_RESPONSE",       // Réponse invalide du modèle
  "POLICY_BLOCKED",         // Bloqué par une politique (ICOS ou OmniRoute)
  "UNSUPPORTED_CAPABILITY", // Capacité non supportée par le modèle
  "CANCELLED",              // Requête annulée via AbortSignal
  "INTERNAL_ERROR",         // Erreur interne du port/adapter
]);
```

### 5.3 AiRoutingRequest

```typescript
export const aiRoutingRequestSchema = z.object({
  // Contenu de la requête
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),

  // Intention métier
  intent: aiRoutingIntentSchema.default("BEST_REASONING"),

  // Contexte ICOS (tenant, compliance)
  tenantId: z.string().min(1),
  dataClassification: sensitivityLevelSchema.optional(),

  // Contraintes de génération
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),

  // Budget / qualité
  budgetMaxCostUsd: z.number().positive().optional(),
  qualityThreshold: z.enum(["draft", "standard", "high"]).default("standard"),

  // Routing
  allowedProviderIds: z.array(z.string()).optional(),
  disallowedProviderIds: z.array(z.string()).optional(),
  fallbackAllowed: z.boolean().default(true),

  // Timeout & cancellation
  timeoutMs: z.number().int().positive().default(60000),
  // AbortSignal n'est pas sérialisable — passé hors Zod à l'appel du port

  // Corrélation
  correlationId: z.string().min(1),

  // Modalité supportée
  modality: z.enum(["chat"]).default("chat"),
});
```

### 5.4 AiProviderInfo

```typescript
export const aiProviderInfoSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  account: z.string().optional(),
});
```

### 5.5 AiUsage

```typescript
export const aiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
```

### 5.6 AiGenerationResult

```typescript
export const aiGenerationResultSchema = z.discriminatedUnion("success", [
  // Succès
  z.object({
    success: z.literal(true),
    content: z.string(),
    finishReason: z.enum(["stop", "length", "content_filter"]),
    provider: aiProviderInfoSchema,
    usage: aiUsageSchema,
    latencyMs: z.number().int().nonnegative(),
    routeExplanation: z.string().optional(),
    fallbackUsed: z.boolean().default(false),
  }),
  // Échec
  z.object({
    success: z.literal(false),
    error: z.object({
      code: aiErrorCodeSchema,
      message: z.string().min(1),
      retryable: z.boolean(),
      fallbackPossible: z.boolean(),
      // ProviderError n'est jamais un provider brut — c'est un message
      // normalisé qui ne contient pas de credential, secret ou PII.
      providerError: z.string().optional(),
    }),
    latencyMs: z.number().int().nonnegative(),
    provider: aiProviderInfoSchema.optional(),
    usage: aiUsageSchema.optional(),
    fallbackUsed: z.boolean().default(false),
    routeExplanation: z.string().optional(),
  }),
]);
```

### 5.7 AiRoutingRequest (interface, avec AbortSignal)

```typescript
export interface AiRoutingRequestWithSignal extends z.infer<typeof aiRoutingRequestSchema> {
  /** Signal d'annulation — coupe la requête HTTP en cours. */
  abortSignal?: AbortSignal;
}
```

---

## 6. Ports — `server/ai/ports.ts`

### 6.1 AiGatewayPort

```typescript
export interface AiGatewayPort {
  /**
   * Génère une réponse via le provider optimal déterminé par OmniRoute.
   *
   * INVARIANTS :
   * - N'envoie jamais de credentials/raw tokens dans le prompt
   * - N'enregistre jamais le contenu brut du prompt ou de la réponse dans les logs
   * - Timeout : la requête HTTP est annulée après `request.timeoutMs`
   * - Cancellation : si `request.abortSignal` est déclenché, la requête HTTP
   *   est annulée et le résultat retourne `CANCELLED`
   * - L'appelant reçoit un résultat normalisé, jamais une erreur HTTP brute
   */
  generate(request: AiRoutingRequestWithSignal): Promise<AiGenerationResult>;
}
```

### 6.2 Health (bonus, minimal)

```typescript
export interface AiHealthPort {
  /**
   * Vérifie la disponibilité d'OmniRoute.
   * N'appelle aucun provider — uniquement le healthcheck OmniRoute.
   * Retourne true si OmniRoute répond, false sinon.
   */
  check(): Promise<boolean>;
}
```

---

## 7. OmniRouteAdapter — `server/ai/omniroute-adapter.ts`

### 7.1 Mapping ICOS → OmniRoute

L'adapter construit un appel HTTP POST vers `{baseUrl}/v1/chat/completions`
(ou l'endpoint OmniRoute équivalent pour les messages).

| ICOS Field | OmniRoute Mapping | Notes |
|------------|-------------------|-------|
| `prompt` | `messages[].content` | Dernier message utilisateur |
| `systemPrompt` | `messages[0]` (system) | Premier message système |
| `intent` | Header `X-Routing-Intent` ou paramètre de routage | OmniRoute peut choisir le provider selon l'intention |
| `maxTokens` | `max_tokens` | Passé tel quel |
| `temperature` | `temperature` | Passé tel quel |
| `timeoutMs` | Timeout de la requête fetch | Le signal Abort coupe le fetch |
| `tenantId` | Header `X-Tenant-Id` | Pour routage tenant-scoped OmniRoute |
| `dataClassification` | Header `X-Data-Classification` | Pour sélection provider compliant |
| `correlationId` | Header `X-Correlation-Id` | Tracing |
| `allowedProviderIds` | `allowed_providers[]` | Contrainte de routage |
| `disallowedProviderIds` | `disallowed_providers[]` | Contrainte de routage |
| `fallbackAllowed` | `allow_fallback: boolean` | Si false, pas de fallback OmniRoute |

### 7.2 Mapping OmniRoute → ICOS

| OmniRoute Response | AiGenerationResult |
|--------------------|-------------------|
| `choices[0].message.content` | `content` |
| `model` | `provider.model` |
| `provider` | `provider.id` |
| `usage.prompt_tokens` | `usage.inputTokens` |
| `usage.completion_tokens` | `usage.outputTokens` |
| `usage.total_tokens` | `usage.totalTokens` |
| `cost` (si présent) | `usage.costUsd` |
| `routing_explanation` | `routeExplanation` |
| Temps mesuré côté adapter | `latencyMs` |
| `fallback_used` | `fallbackUsed` |

### 7.3 Error Mapping

| Situation | AiErrorCode | Retryable | Fallback |
|-----------|-------------|-----------|----------|
| HTTP 503 / réseau | `PROVIDER_UNAVAILABLE` | true | true |
| HTTP 429 | `RATE_LIMITED` | true (après backoff) | true |
| Timeout fetch | `TIMEOUT` | true | true |
| HTTP 400 | `INVALID_RESPONSE` | false | true |
| HTTP 403 | `POLICY_BLOCKED` | false | false |
| Annulation AbortSignal | `CANCELLED` | false | false |
| 5xx inattendu | `PROVIDER_UNAVAILABLE` | true | true |

### 7.4 Séquence d'appel

```text
1. Valider AiRoutingRequest (Zod parse)
2. Construire l'objet fetch Request
3. Lancer fetch avec :
   - `signal`: AbortSignal.timeout(request.timeoutMs) OU combiné avec request.abortSignal
   - Headers: Content-Type, Authorization, X-Tenant-Id, X-Correlation-Id, etc.
4. Si fetch jette :
   a. TimeoutError → AiError(TIMEOUT)
   b. AbortError → AiError(CANCELLED)
   c. TypeError → AiError(PROVIDER_UNAVAILABLE)
5. Si réponse HTTP non-OK → mapper status → AiError
6. Parser JSON réponse → AiGenerationResult
7. Si parse échoue → AiError(INVALID_RESPONSE)
```

### 7.5 Configuration

```typescript
export interface OmniRouteConfig {
  /** URL de base d'OmniRoute, ex: http://127.0.0.1:20128 */
  baseUrl: string;
  /** Timeout par défaut (surchargeable par requête) */
  defaultTimeoutMs: number;
  /** Timeout maximum absolu (sécurité) */
  maxTimeoutMs: number;
}
```

---

## 8. Compliance Propagation

### 8.1 Tenant

- `tenantId` est présent dans chaque `AiRoutingRequest`.
- L'adapter transmet `tenantId` via l'entête `X-Tenant-Id` à OmniRoute.
- OmniRoute peut utiliser ce tenant pour le routage tenant-aware.

### 8.2 Classification

- `dataClassification` (optionnel, `SensitivityLevel`) est présent dans la requête.
- L'adapter transmet via l'entête `X-Data-Classification`.
- OmniRoute peut utiliser cette classification pour exclure/inclure des providers :
  - `C3` (données sensibles) → exiger un provider privé/local
  - `C0` (publiques) → aucun provider exclu

### 8.3 Retention

- La politique de rétention n'est pas transmise à OmniRoute (elle s'applique
  à la persistance ICOS post-génération, pas au transport).

### 8.4 Invariant : Pas de credentials provider

- L'adapter ne reçoit et ne transmet jamais les API keys des providers
  sous-jacents.
- L'authentification à OmniRoute utilise un secret de service ICOS dédié
  (pas les clés Anthropic/OpenAI).
- Les credentials providers sont gérés exclusivement par OmniRoute.

---

## 9. Error Model

| Code | HTTP Mapping | Description | Action |
|------|-------------|-------------|--------|
| `PROVIDER_UNAVAILABLE` | 502/503/504 | Provider injoignable, saturation, crash | Retry ou fallback |
| `RATE_LIMITED` | 429 | Quota ou rate limit atteint | Backoff + retry ou fallback |
| `TIMEOUT` | — | Délai dépassé | Retry ou fallback |
| `INVALID_RESPONSE` | 200 malformed | JSON invalide, réponse tronquée | Fallback (ne pas retry same model) |
| `POLICY_BLOCKED` | 403 | Bloqué par politique ICOS ou OmniRoute | Signaler, pas de retry |
| `UNSUPPORTED_CAPABILITY` | 400 | Modèle ne supporte pas la modalité | Changer d'intention |
| `CANCELLED` | — | Annulé via AbortSignal | Arrêt propre |
| `INTERNAL_ERROR` | 500 | Erreur interne de l'adapter | Bug ICOS |

**Règle fail-closed** : toute erreur non reconnue, toute exception non
attendue, tout timeout interne produit `INTERNAL_ERROR` avec `success: false`.
Aucune exception n'est propagée à l'appelant — toutes sont capturées et
normalisées.

---

## 10. Timeout & Cancellation

### Timeout

- Chaque requête a un `timeoutMs` (défaut 60000, max 300000).
- `fetch` utilise `AbortSignal.timeout()` pour couper la requête HTTP.
- Si `timeoutMs > maxTimeoutMs`, l'adapter refuse la requête (erreur de validation).

### Cancellation

- L'appelant peut passer `abortSignal` dans `AiRoutingRequest`.
- L'adapter combine le timeout et le signal d'annulation via `AbortSignal.any()`.
- Si l'un des deux signaux se déclenche, la requête HTTP est coupée.
- Résultat : `AiGenerationResult` avec `success: false`, `error.code: "CANCELLED"`.

---

## 11. Retry & Fallback

### Retry

**V1 : aucun retry dans l'adapter ICOS.** OmniRoute gère ses propres retries.
L'adapter ne duplique pas le mécanisme : un appel unique vers OmniRoute,
OmniRoute retry si nécessaire en interne.

**Justification** : éviter la duplication de retry (ICOS retry + OmniRoute retry
= double effet sans coordination). Si OmniRoute retourne une erreur, c'est que
ses retries internes ont échoué — ICOS ne peut pas faire mieux.

### Fallback

- ICOS exprime `fallbackAllowed: boolean`.
- Si `true` : OmniRoute peut fallback vers un autre provider.
- Si `false` : OmniRoute ne doit pas fallback (le résultat signale l'erreur du
  provider primaire).
- L'adapter signale `fallbackUsed: true/false` dans le résultat.
- **Pas de fallback piloté par ICOS en V1** : OmniRoute décide du fallback
  technique.

**Limitation importante** : `fallbackAllowed: false` est un signal, pas une
garantie absolue — l'adapter n'a pas de contrôle fin sur la politique de
fallback interne d'OmniRoute. La garantie viendra avec R2 (projections
opérationnelles + mapping des routes).

---

## 12. Observability Hooks

L'adapter expose des hooks simples (callbacks ou events) :

```typescript
export interface AiGatewayObservabilityHooks {
  /** Appelée avant l'envoi de la requête HTTP */
  onRequestStarted?: (correlationId: string, intent: string) => void;
  /** Appelée après réception de la réponse HTTP */
  onRequestCompleted?: (correlationId: string, result: {
    success: boolean;
    latencyMs: number;
    providerId?: string;
    modelId?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    errorCode?: string;
  }) => void;
}
```

Ces hooks sont optionnels, passés à la construction de l'adapter.
Ils ne DOIVENT PAS recevoir le contenu du prompt ou de la réponse.

---

## 13. Logging & Redaction

### Ce qui est loggé

- `correlationId` (toujours)
- `intent` (toujours)
- `provider.id`, `provider.model` (si succès)
- `latencyMs` (toujours)
- `usage.inputTokens`, `usage.outputTokens` (si retourné)
- `error.code` (si échec)
- `fallbackUsed` (toujours)

### Ce qui n'est JAMAIS loggé

- `prompt` (contenu brut, même partiel)
- `response.content` (contenu brut)
- `systemPrompt` (contenu brut)
- `error.providerError` (message d'erreur provider brut — peut contenir PII)
- Identifiants / tokens d'authentification
- `allowedProviderIds` / `disallowedProviderIds` (peuvent révéler de la configuration)

### Implémentation

Utiliser `console.warn` et `console.error` structurés (JSON) pour les logs
d'adapter. Les hooks d'observability reçoivent des métriques agrégées,
jamais le contenu.

---

## 14. Configuration

### Env vars (extension de `env.ts`)

```text
# OmniRoute AI Gateway
OMNIROUTE_BASE_URL=http://127.0.0.1:20128
OMNIROUTE_API_KEY=              # Optionnel — pour authentification ICOS vers OmniRoute
OMNIROUTE_DEFAULT_TIMEOUT_MS=60000
OMNIROUTE_MAX_TIMEOUT_MS=300000
```

### Defaults

| Param | Valeur | Source |
|-------|--------|--------|
| `baseUrl` | `http://127.0.0.1:20128` | `OMNIROUTE_BASE_URL` |
| `apiKey` | `undefined` | `OMNIROUTE_API_KEY` |
| `defaultTimeoutMs` | `60000` | `OMNIROUTE_DEFAULT_TIMEOUT_MS` |
| `maxTimeoutMs` | `300000` | `OMNIROUTE_MAX_TIMEOUT_MS` |

### Configuration object (Zod validated)

```typescript
export const omniRouteConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  defaultTimeoutMs: z.number().int().positive().default(60000),
  maxTimeoutMs: z.number().int().positive().default(300000),
});
```

---

## 15. Tests Strategy

### Unit tests (Vitest, pas de Docker)

| # | Test | Fichier |
|---|------|---------|
| 1 | `AiRoutingRequest` Zod parse valide | `core/ai/contract.test.ts` |
| 2 | `AiRoutingRequest` Zod parse rejette prompt vide | `core/ai/contract.test.ts` |
| 3 | `AiGenerationResult` Zod parse succès | `core/ai/contract.test.ts` |
| 4 | `AiGenerationResult` Zod parse échec | `core/ai/contract.test.ts` |
| 5 | `AiErrorCode` toutes les valeurs | `core/ai/contract.test.ts` |
| 6 | OmniRoute adapter — timeout → TIMEOUT error | `server/ai/omniroute-adapter.test.ts` |
| 7 | OmniRoute adapter — AbortSignal → CANCELLED | `server/ai/omniroute-adapter.test.ts` |
| 8 | OmniRoute adapter — HTTP 429 → RATE_LIMITED | `server/ai/omniroute-adapter.test.ts` |
| 9 | OmniRoute adapter — HTTP 503 → PROVIDER_UNAVAILABLE | `server/ai/omniroute-adapter.test.ts` |
| 10 | OmniRoute adapter — HTTP 200 succès → parsed result | `server/ai/omniroute-adapter.test.ts` |
| 11 | OmniRoute adapter — fallback flag propagé | `server/ai/omniroute-adapter.test.ts` |
| 12 | OmniRoute adapter — tenant/classification headers | `server/ai/omniroute-adapter.test.ts` |
| 13 | OmniRoute adapter — pas de prompt dans les logs | `server/ai/omniroute-adapter.test.ts` |
| 14 | OmniRoute adapter — timeout > maxTimeoutMs refusé | `server/ai/omniroute-adapter.test.ts` |
| 15 | Port — génération avec fake adapter | `server/ai/ports.test.ts` |
| 16 | OmniRouteConfig Zod parse validation | `config/env.test.ts` |

### Test technique

- L'adapter utilise un mock/fake `fetch` (via `vi.fn()` ou équivalent).
- La configuration réelle d'OmniRoute n'est jamais testée dans les
  tests unitaires — elle relève des tests d'intégration (hors scope D3 V1).
- Un adapter factice (`FakeAiGateway`) est fourni pour les tests des
  consommateurs (D4).

---

## 16. D2 Integration Boundary

D3 expose `AiGatewayPort` que D4 consomme. La frontière est :

```
D4 Orchestrator
│
├── MissionRepository (D2)
├── D1PolicyPort
└── AiGatewayPort ← D3 fournit ce port
       │
       └── OmniRouteAdapter
```

**D4 ne doit pas** :
- Appeler OmniRouteAdapter directement
- Connaître OmniRoute
- Recevoir les credentials provider
- Gérer la santé du provider

**D3 ne doit pas** :
- Dépendre de D4
- Connaître Mission/Plan/Run
- Définir la persistance des générations

**Ce que D3 fournit** (export) :
- `AiGatewayPort` (interface)
- `OmniRouteAdapter` (implémentation, optionnelle — D4 peut aussi utiliser
  `FakeAiGateway` pour ses tests)
- Les types de contrat (`AiRoutingRequest`, `AiGenerationResult`)

---

## 17. Future Boundaries (Search, Fetch, Audio, ACP)

Ces fonctionnalités sont des ports séparés, non inclus dans D3. Leur
architecture future :

| Capacité | Port | Notes |
|----------|------|-------|
| Search | `SearchPort` | Peut utiliser OmniRoute Search API à terme |
| Fetch | `FetchPort` | Peut utiliser OmniRoute Fetch provider |
| Audio STT | `SpeechToTextPort` | Peut utiliser Whisper via OmniRoute |
| Audio TTS | `TextToSpeechPort` | Peut utiliser ElevenLabs via OmniRoute |
| ACP Agents | `AgentRuntimePort` | OmniRoute ACP, orthogonal à AiGatewayPort |
| Embeddings | `EmbeddingPort` | Peut utiliser OmniRoute embeddings |
| Images | `ImageGenerationPort` | Peut utiliser OmniRoute image models |

Chacun de ces ports a sa propre interface, ses propres types et son propre
adapter OmniRoute. Ils ne partagent que la configuration de base
(`OMNIROUTE_BASE_URL`) et les contrats cross-cutting (tenant, classification).

---

## 18. Security Checklist

### Pass

- [x] `AiGatewayPort` ne reçoit jamais de credentials provider
- [x] OmniRouteAdapter ne stocke que l'URL et l'API key OmniRoute (service ICOS)
- [x] Aucune route directe ICOS → provider (toujours via OmniRoute)
- [x] Pas de credentials dans les logs
- [x] Pas de prompt/response brut dans les logs
- [x] Erreur normalisée : pas de stack trace exposée, pas de provider error brut
- [x] Timeout max absolu (sécurité anti-ressource)
- [x] Fail-closed : toute exception → `INTERNAL_ERROR`
- [x] Les contraintes de compliance (tenant, classification) sont propagées

### Vérifié par la revue

- [ ] Pas de policy bypass : l'adapter ne court-circuite pas D1
- [ ] Pas de tenant leakage : le tenantId est propagé, pas mappé incorrectement
- [ ] Pas de credential provider leakage
- [ ] Pas de couplage direct au provider
- [ ] Pas de hidden retries (adapter délègue à OmniRoute, V1 pas de retry ICOS)
- [ ] Pas de unbounded fallback (fallback autorisé mais signalé)
- [ ] Pas de cost explosion (budget max optionnel, timeout absolu)
- [ ] Pas de domaine provider dans les logs
- [ ] Pas de cancellation bug (AbortSignal combiné correctement)
- [ ] Pas de confused deputy (l'adapter ne peut pas être utilisé pour contourner
      les permissions)
- [ ] Pas de fail-open (toute erreur → résultat avec success: false)

---

## 19. File Structure

```
src/
├── core/
│   └── ai/
│       ├── contract.ts          ← Types Zod + TypeScript
│       └── contract.test.ts     ← Validation tests
│
├── server/
│   └── ai/
│       ├── ports.ts             ← AiGatewayPort interface
│       ├── omniroute-config.ts  ← Configuration Zod + resolver
│       ├── omniroute-adapter.ts ← OmniRouteAdapter implementation
│       ├── omniroute-adapter.test.ts ← Adapter unit tests
│       ├── fake-ai-gateway.ts   ← Fake pour les consommateurs (D4)
│       └── ports.test.ts        ← Port contract tests
│
├── config/
│   └── env.ts                   ← Extension avec OMNIROUTE_* vars
│
└── .env.example                 ← Mise à jour des vars
```

---

## 20. Definition of Done

- [ ] `core/ai/contract.ts` — tous les schémas Zod, discriminé `success`
- [ ] `core/ai/contract.test.ts` — validation des schémas
- [ ] `server/ai/ports.ts` — `AiGatewayPort` interface + `AiHealthPort`
- [ ] `server/ai/omniroute-config.ts` — config Zod + resolver
- [ ] `server/ai/omniroute-adapter.ts` — adapter complet avec fetch
- [ ] `server/ai/omniroute-adapter.test.ts` — tests unitaires (mock fetch)
- [ ] `server/ai/fake-ai-gateway.ts` — fake pour D4
- [ ] `server/ai/ports.test.ts` — tests de contrat du port
- [ ] `config/env.ts` — extension avec `OMNIROUTE_*` vars
- [ ] `.env.example` — mise à jour
- [ ] `pnpm test` — 617 + N nouveaux tests verts
- [ ] `pnpm typecheck` — propre
- [ ] `pnpm lint` — propre
- [ ] `pnpm build` — propre
- [ ] `git diff --check` — pas d'espaces blancs
- [ ] Self-review complète
- [ ] PR créée (pas de merge)

---

## 21. ADRs associés

| ADR | Sujet | Décision D3 |
|-----|-------|-------------|
| ADR-0013 | Séparation génération / effet externe | AiGenerationResult n'est pas un ordre d'exécution |
| ADR-0016 | Classification de confidentialité | `dataClassification` propagé à OmniRoute |
| ADR-0018 | Propriété des credentials IA | ICOS ne stocke aucun credential provider |
| ADR-0019 | OmniRoute comme controlled external runtime | AiGatewayPort seule abstraction ICOS |
