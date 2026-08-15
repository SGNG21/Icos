# ICOS Cockpit V1 — Design Document

**Date:** 2026-07-26
**Status:** APPROVED
**Branch:** feat/cockpit-v1
**Author:** Geoffrey Nozza + Claude

## 1. Overview

Transform the current ICOS technical dashboard into a premium user cockpit inspired by ChatGPT, Linear, Raycast, and Jarvis. The user should never need to understand D1–D4, AiGatewayPort, ExecutionGrant, OmniRoute, or Provider routing — those belong in an Advanced mode.

**Experience hierarchy:**

1. Conversation (central)
2. Mission (status/progress)
3. Approvals (in-flow)
4. Activity (in-flow)
5. Results / Artifacts (in-flow)
6. History (sidebar + expandable)

## 2. Architecture

### Routes

- **`/`** — Cockpit (default experience, replaces current dashboard)
- **`/admin/**` — Administration (existing, unchanged)

No new routes for V1. The cockpit transforms the existing page.

### Component Tree

```
src/
├── app/
│   └── page.tsx                    ← Rewritten to use CkShell
│
├── components/
│   └── cockpit/                   ← New cockpit-specific components
│       ├── CkShell                 — Layout wrapper (sidebar + chat + footer)
│       ├── CkSidebar               — Project nav + missions + advanced section
│       ├── CkConversation          — Central chat (messages + in-flow cards)
│       │   ├── CkMessageBubble     — Single message (user | ICOS)
│       │   ├── CkThinkingState     — Inline thinking dots
│       │   ├── CkComposer          — Input + send + mic placeholder
│       │   └── CkInFlowCard        — Generic wrapper for in-flow cards
│       ├── CkMissionProgress       — Progress bar (in-flow or footer)
│       ├── CkApprovalCard          — Approval request (in-flow)
│       ├── CkActivityTimeline      — Step-by-step activity (in-flow)
│       ├── CkMissionHistory        — Past missions list
│       ├── CkResultsArtifacts      — Artifacts display (in-flow)
│       ├── CkProjectSelector       — Project dropdown (sidebar)
│       ├── CkSettingsPanel         — Settings modal/overlay
│       └── CkAdvancedSection       — Collapsible advanced nav
│
├── features/
│   └── cockpit/                   ← Mocks, types, mappers
│       ├── types.ts                — UI view models (ArtifactDisplay, ActivityItem…)
│       ├── mappers.ts              — Contract → UI model converters
│       ├── statusConfig.ts         — MissionStatus → label/icon/color mapping
│       ├── format.ts               — Duration, relative time, size formatting
│       ├── mocks/
│       │   ├── mock-missions.ts
│       │   ├── mock-messages.ts
│       │   ├── mock-approvals.ts
│       │   ├── mock-history.ts
│       │   └── mock-projects.ts
│       └── store.ts               — Simple in-memory store (V1 mock)
│
├── styles/
│   └── globals.css               ← Extended, not replaced
│
├── core/
│   └── mission/
│       └── contract.ts            ← Source of truth for MissionStatus
│
└── existing/                      ← Unchanged
    ├── components/features/        — agent-grid, recent-tasks, approvals-panel (kept for admin)
    ├── components/layout/sidebar   — kept for admin view
    ├── components/auth/            — unchanged
    └── components/administration/  — unchanged
```

### Layout Shell

```
┌──────────────────────────────────────────────────────────┐
│ ICOS_                                        👤 Geoff ⚙️ │
├────────────┬─────────────────────────────────────────────┤
│ Sidebar    │  Conversation (scrollable)                   │
│            │  ┌─── User ────────────────────────────┐    │
│            │  │  Message…                           │    │
│            │  └────────────────────────────────────┘    │
│ Projets    │  ┌─── ICOS ────────────────────────────┐    │
│ 🔷 ICOS ◄  │  │  Réponse…  [thinking…]              │    │
│ 🔷 Polivia │  └────────────────────────────────────┘    │
│ 🔷 Clients │  ┌── Mission progress ─────────────────┐    │
│            │  │  📋 Analyse ICOS  ████░░ 3/5 steps   │    │
│ Missions   │  └──────────────────────────────────────┘    │
│ 📋 En cours│  ┌── Approval ──────────────────────────┐    │
│ 📋 Hist.   │  │  🔐 Déploiement production…          │    │
│            │  └──────────────────────────────────────┘    │
│ 🧠 Mémoire │  ┌── Activity ──────────────────────────┐    │
│            │  │  🟢 Plan généré                      │    │
│ ⚙️ Avancé  │  │  🟡 Analyse en cours…               │    │
│  (replié)  │  └──────────────────────────────────────┘    │
│            │  ┌── Results ───────────────────────────┐    │
│            │  │  📄 rapport.md   📊 graph.json       │    │
│            │  └──────────────────────────────────────┘    │
│            │                                             │
│            │  ┌────────────────────────────────────────┐ │
│            │  │  💬 Décris ton objectif…        🎙 ▶  │ │
│            │  └────────────────────────────────────────┘ │
├────────────┴─────────────────────────────────────────────┤
│ 📋 Analyse ICOS  ████░░ 65%  Étape 3/5                   │
└──────────────────────────────────────────────────────────┘
```

## 3. Section Details

### 3.1 Conversation (CkConversation)

Central experience. Message history with user bubbles and ICOS bubbles. Thinking/loading states inline. Streaming placeholder. Scroll-to-bottom. Fixed composer at bottom.

**Message types in flow:**

- `user` — User message bubble
- `icos` — ICOS response bubble (text, lists, code)
- `thinking` — Inline thinking dots (during processing)
- `mission-progress` — In-flow mission progress card
- `approval` — In-flow approval request card
- `activity` — In-flow activity timeline block
- `result` — Artifact/result display block

**Composer:**

- Placeholder: "Décris ton objectif…"
- Send button ▶ (disabled when empty)
- Microphone button 🎙 (placeholder, disabled — no STT/TTS)
- Keyboard: Enter to send

**States:**

- Empty: greeting message + ICOS orbit mark
- Loading: thinking dots in ICOS bubble
- Streaming: text appearing progressively (placeholder for future SSE)
- Error: error bubble with retry button
- Scroll: auto-scroll to bottom, "↓ Dernier message" FAB when scrolled up

**Constraints:**

- No virtualisation in V1 (simple scroll container)
- No technical cards (D1/D2/D3/D4, Agent references visible)
- Agent/skill/tool details only in Advanced mode or execution detail accordion

### 3.2 Mission Status & Progress (CkMissionProgress)

**Footer bar** (48px, hidden when no active mission):

```
📋 Analyse ICOS  ████████░░ 65%  Étape 3/5  En cours
```

- Hidden when status is COMPLETED, FAILED, or CANCELLED
- Mobile: title + bar only (no "Étape 3/5")

**In-flow card** (between messages):

```
┌── Mission progress ────────────────────────────────┐
│  📋 Analyse ICOS                                    │
│  ████████░░  3/5 étapes   Étape 3 : Analyse src     │
│  🟢 Planification  ✅ Plan  🟢 En cours  ⏳ Reste  │
└────────────────────────────────────────────────────┘
```

**Progress rules:**

- Percentage is **never fabricated** by UI
- If D2 provides `completedSteps / totalSteps` → deterministic progress
- If no measurable progress → indeterminate state ("En cours…")
- Uses real `MissionStatus` from `core/mission/contract.ts`

**Mission Status → UI mapping:**

| Status               | Icon | Label                                | Bar        |
| -------------------- | ---- | ------------------------------------ | ---------- |
| CREATED              | ○    | Créée                                | gray 10%   |
| PLANNING             | ◌    | Planification                        | animation  |
| PLANNED              | ○    | Planifiée                            | gray 25%   |
| IN_PROGRESS          | ●    | En cours                             | `--forest` |
| WAITING_FOR_APPROVAL | ◉    | Requiert approbation                 | `--amber`  |
| BLOCKED_BY_POLICY    | ⊘    | Bloquée                              | red-orange |
| PROVIDER_UNAVAILABLE | ⚠    | Suspendue — Fournisseur indisponible | orange     |
| TOOL_FAILED          | ⚠    | Suspendue — Outil indisponible       | orange     |
| SKILL_REVOKED        | ⚠    | Suspendue — Compétence révoquée      | orange     |
| STALE_ATTESTATION    | ⚠    | Suspendue — Attestation expirée      | orange     |
| MISSION_RECOVERABLE  | ⚠    | Suspendue — Récupérable              | orange     |
| COMPLETED            | ✅   | Terminée                             | `--mint`   |
| FAILED               | ❌   | Échouée                              | red        |
| CANCELLED            | —    | Annulée                              | gray       |

- Recovery states (PROVIDER_UNAVAILABLE through MISSION_RECOVERABLE) show a human-readable sub-status immediately visible (not just in tooltip — mobile requirement)
- Main label "Suspendue" with specific sub-status

### 3.3 Approval Card (CkApprovalCard)

Appears **only** in the conversation flow when a mission reaches `WAITING_FOR_APPROVAL` and backend delivers an `AgentAction` with `approvalStatus: "pending"`.

**Card content:**

```
┌── 🔐 Approbation requise ───────────────────────────────┐
│ Action      Déploiement production — v3.2.1             │
│ Raison      Mise en production de nouvelles règles      │
│ Risque      Sensible                                    │
│ Portée      Organisation ICOS · 3 services concernés    │
│ Expiration  15 min                                      │
│                                                          │
│ ⚠ Cette action nécessite votre approbation explicite.   │
│   Votre décision sera tracée dans le journal d'audit.   │
│                                                          │
│ [Refuser]              [✅ Autoriser]                    │
└──────────────────────────────────────────────────────────┘
```

**Fields displayed:**

| Field      | Source                                                                                  | Condition                                               |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Action     | `action.kind`                                                                           | Always                                                  |
| Reason     | `action.reason` / mission context                                                       | If available                                            |
| Risk       | `action.risk` → `riskLabelMap`                                                          | Always (with color chip)                                |
| Scope      | Payload scope / targets (operation, target, resource, scope, duration, expected effect) | If available                                            |
| Expiration | `action.expiresAt` → relative countdown                                                 | If available                                            |
| Agent      | `action.initiatedByAgentId`                                                             | **Hidden by default** (accessible via detail accordion) |

**Risk labeling (extensible):**

| RiskLevel                   | Chip           | Color        |
| --------------------------- | -------------- | ------------ |
| `read_only`                 | Lecture seule  | `--mint` bg  |
| `reversible`                | Réversible     | `--amber` bg |
| `sensitive`                 | Sensible       | Red-light bg |
| _(future level 4/critical)_ | _(ready slot)_ | _(ready)_    |

- `riskLabelMap` and `riskStyleMap` are extensible arrays/records, not a closed enum
- Do NOT define level 4 before Governance backend does

**Card states:**

- `pending` — Actions [Refuser] [Autoriser]
- `approved` — "✅ Autorisation accordée" (NOT "Action exécutée")
- `rejected` — "❌ Refusée · Motif : …"
- `expired` — "⏰ Demande expirée · Cette autorisation n'est plus utilisable." (UI countdown ≠ business cancellation)
- `loading` — "◌ Enregistrement de la décision…" (buttons disabled)
- `error` — "⚠ Erreur" + [Réessayer]

**Reject flow:** Click "Refuser" → inline reason field (optional but recommended) → Confirm / Annuler.

**Lifecycle:**

```
Approval
  → ExecutionGrant (future)
  → D4 execution (future)
  → Result
```

UI never shows "Action executée" after approval — only "Autorisation accordée".

**Integration:**

- Calls `POST /api/actions/{id}/decision` (existing API)
- If API unavailable → stays in pending + shows error
- Agent details in "Détails d'exécution" accordeon (future Advanced mode)
- No local approval simulation
- No artificial approval triggers (e.g., not every "file modification" = approval)

**Mock examples (sensitive real-world actions only):**

- Déploiement production — v3.2.1 (sensitive)
- Merge vers main — 14 commits (sensitive, not "banalement reversible")
- Accès réseau exceptionnel — SSH production (sensitive)

### 3.4 Activity Timeline (CkActivityTimeline)

Appears in the conversation flow, between messages. Shows significant events — not technical logs.

```
┌── Activity ────────────────────────────────────────────┐
│  📋 Planification                                       │
│  ─────────────────────────────────────────────────      │
│  🟢 Plan généré                    il y a 30s          │
│  🟢 Stratégie sélectionnée         il y a 25s          │
│  🟡 Analyse en cours…              en cours            │
│  ⏳ Génération rapport             0/1                 │
└────────────────────────────────────────────────────────┘
```

**Activity item status:**

| Icon | Status      | Meaning               |
| ---- | ----------- | --------------------- |
| ⏳   | pending     | Not started           |
| 🟡   | in_progress | In progress           |
| 🟢   | completed   | Done                  |
| 🔴   | failed      | Failed                |
| ⏭️   | skipped     | Skipped (with reason) |

**Content rules:**

- Shows: planning, execution steps, decision points, intermediate results, incidents
- Does NOT show: raw logs, D1/D2/D3/D4 references, provider routing, gateway calls, orchestration internals
- Agent names hidden by default ("Stratégie sélectionnée" not "Agent CTO sélectionné")
- Recovery options (Réessayer, Ignorer, etc.) come from backend/policy, NOT invented by UI
- `durationMs?: number`, `startedAt?: ISO string`, `completedAt?: ISO string` — frontend formats display
- Skipped steps include `skipReasonCode` / `skipReason` (not always "dependency unsatisfied")

### 3.5 Mission History (CkMissionHistory)

List of past missions accessible from sidebar (📋 Missions → Historique).

**Sidebar labels:**

```
📋 Missions
  ├── En cours
  └── Historique (COMPLETED + FAILED + CANCELLED)
```

**Card content:**

```
┌── Mission card ──────────────────────────────────────┐
│  ✅ Analyse ICOS — architecture et dépendances       │
│  Terminée · 5 étapes · Durée totale 2 min 30         │
│  il y a 1 heure                                      │
└──────────────────────────────────────────────────────┘
```

**Fields:**

| Field          | Source                                                                        | Condition           |
| -------------- | ----------------------------------------------------------------------------- | ------------------- |
| Title          | `mission.userRequest` (EXISTS in contract)                                    | Always              |
| Status icon    | `statusConfig[mission.status].icon`                                           | Always              |
| Status label   | `statusConfig[mission.status].label`                                          | Always              |
| Steps count    | `mission.plan.steps.length` + completed count                                 | If plan exists      |
| Total duration | `completedAt - createdAt` ("durée totale", not active time)                   | If completed        |
| Relative time  | `updatedAt` via `Intl.RelativeTimeFormat`                                     | Always              |
| Error          | `mission.error` (not a separate `cancelReason`)                               | If FAILED/CANCELLED |
| Failure step   | From D2 canonical link if available; else generic "Échec lors de l'exécution" | If FAILED           |

**States:**

- Loaded (≥1): paginated list (10 per page, "Charger plus")
- Empty: "Aucune mission terminée pour le moment."
- Loading: skeleton (3 gray cards)
- Error: "Impossible de charger l'historique." + [Réessayer]
- Filter options (future): Terminées / Échouées / Annulées

**Future "Relancer" button (NOT in V1):**
Must create a **new** mission/run with fresh policy evaluation, fresh approvals, fresh ExecutionGrant — never replay old authorization context.

### 3.6 Results & Artifacts (CkResultsArtifacts)

Displayed in the conversation flow. Artifacts come from `Run` outputs via a mapper.

**Pipeline:**

```
ArtifactRef (backend)
  → mapper UI (features/cockpit/mappers.ts)
  → ArtifactDisplay (view model)
  → rendered in conversation flow
```

**Artifact types:**

| Type     | Icon | Example                     |
| -------- | ---- | --------------------------- |
| document | 📄   | Report, analysis            |
| data     | 📊   | JSON, CSV, graph            |
| code     | 💻   | Patch, diff, snippet        |
| image    | 🖼️   | Chart, screenshot           |
| link     | 🔗   | PR URL, staging, deployment |

**NOT artifact types:**

- ❌ `error` — errors are ResultNotice / RunFailure / MissionError, not artifacts
- ❌ Generic ExternalReference — a GitHub PR or staging URL may co-appear but is not an artifact

**Display properties:**

```typescript
interface ArtifactDisplay {
  id: string;
  type: "document" | "data" | "code" | "image" | "link";
  displayName: string; // "Rapport d'analyse"
  originalName: string; // "output_step3.json" — actual identity preserved
  sizeBytes?: number; // raw bytes, formatted by UI
  description?: string;
}
```

- Frontend formats `sizeBytes → Ko/Mo` (no backend formatting)
- V1: name + type + size only — no preview, no download, no unsafe content rendering
- Execution details behind accordion "Détails d'exécution" (future Advanced mode)

**Future security invariant (prepared):**

```
ArtifactRef
  → authorization
  → classification / retention
  → safe rendering/download policy
  → UI
```

### 3.7 Project Selector (CkProjectSelector)

Simple dropdown in sidebar under "Projets" section.

```
🔷 ICOS ▼
├── 🔷 ICOS ◄ (active)
├── 🔷 Polivia
└── 🔷 Clients
```

- Active project displayed in select/toggle
- Dropdown on click, closes on outside click or selection
- V1: UI-only project switch (no API call)
- Future: `projectId` becomes explicit business context propagated to backend (missions, memory, artifacts, permissions)
- Future: project switch in active conversation → confirmation/new conversation/context indicator
- Mock projects are purely visual — do not infer business model from mock names (Project ≠ Workspace ≠ Client ≠ Tenant)
- Frontend uses stable `projectId`, never display name as identity

### 3.8 Basic Settings (CkSettingsPanel)

Overlay panel triggered by ⚙️ icon in top bar or sidebar footer.

**Sections:**

| Section       | Content                                | V1 behavior                                            |
| ------------- | -------------------------------------- | ------------------------------------------------------ |
| Langue        | Français                               | Select disabled/"Bientôt disponible" — no i18n         |
| Thème         | Sombre/Clair/Système                   | `prefers-color-scheme` + `localStorage`, functional    |
| Notifications | Approbations, Fin mission, Échecs      | Local preferences only — labeled "Préférences locales" |
| Session       | Email, rôle, logout                    | Uses real auth data if available, else labeled mock    |
| Système       | Version, environment, persistence mode | Read-only, real data from container/server             |

**Rules:**

- UI role label ≠ backend authorization — never simulate identity/role authority
- "Exécution : verrouillée" is NOT hardcoded — reads real system state
- If no auth exists → mock labeled as mock
- Logout reuses existing `LogoutButton`
- Close on outside click / Escape

### 3.9 Advanced Section (CkAdvancedSection)

Collapsed by default in sidebar. Navigation placeholders only — no functionality.

```
⚙️ Avancé ›                    ← collapsed by default
  Skills
  Capacités
  Politiques
  Providers
  Runtime
  Audit
```

Each item is a simple link or button that shows "Bientôt disponible" — no routing to non-existent pages. These are **prepared navigation slots** for future implementation.

## 4. Design System & CSS

### Reuse existing tokens

All existing CSS custom properties in `globals.css` reused:

- `--ink`, `--muted`, `--line`, `--paper`, `--panel`
- `--forest`, `--mint`, `--amber`

### Extensions (additive only)

```
/* New cockpit-specific classes — no replacement of existing styles */
.ck-message-bubble { … }
.ck-approval-card { … }
.ck-activity-timeline { … }
```

- No removal or rename of existing CSS
- No new CSS variables unless needed for dark theme (`--ck-bg`, `--ck-text`)
- No gradients, "crypto dashboard" styling, 25 colors, oversized marketing headings
- Clean, typographically consistent: system font stack (Arial/Helvetica), Georgia for headings in moderation

### Responsive

| Breakpoint          | Behavior                                                  |
| ------------------- | --------------------------------------------------------- |
| ≥1024px (desktop)   | Full sidebar + conversation + footer bar                  |
| 768-1023px (tablet) | Sidebar collapsible (hamburger), compact footer           |
| <768px (mobile)     | Sidebar overlay, composer full-width, footer = badge only |

- Chat remains usable on phone
- No horizontal overflow
- No sidebar taking half the screen on mobile

### Theme (dark mode)

Prepared via `prefers-color-scheme` + CSS custom properties in dark variant. Functional in V1. Dark palette extends the existing forest/mint system (no brand break).

## 5. Mock Strategy

### Separation

All mocks live in `src/features/cockpit/mocks/`. Each file is prefixed `mock-` and contains a clear comment:

```typescript
// MOCK — replace with real API data when endpoint exists
```

### Data types

- `ArtifactRef` — backend model (from Run output)
- `MissionWithMessages` — combines Mission + message history for the chat store
- `ProjectInfo` — lightweight project info for selector
- `CockpitStore` — simple in-memory store for V1 (replaces Zustand/state lib — not needed)

### Mocks are replaceable

The store and mappers are the boundary layer:

- `mappers.ts` converts backend contracts → UI view models
- `store.ts` holds current state (can be swapped for React Query / server state later)
- Components receive data via props — they don't call mocks directly

### Mock approval payloads (sensitive only)

```typescript
// MOCK — replace with real API data
const mockApprovals: AgentAction[] = [
  { kind: "Déploiement production — v3.2.1", risk: "sensitive", … },
  { kind: "Merge vers main — 14 commits", risk: "sensitive", … },
  { kind: "Accès réseau exceptionnel — SSH production", risk: "sensitive", … },
];
```

## 6. Backend Dependencies

Required from existing code (all read-only or already present):

| Dependency                        | Source                     | Usage                  |
| --------------------------------- | -------------------------- | ---------------------- |
| `MissionStatus`                   | `core/mission/contract.ts` | Status mapping         |
| `Mission`                         | `core/mission/contract.ts` | History data           |
| `AgentAction`                     | `core/contracts/action.ts` | Approval card          |
| `RiskLevel`                       | `core/contracts/common.ts` | Risk chip              |
| `Task`                            | `core/contracts/task.ts`   | Activity reference     |
| `POST /api/actions/{id}/decision` | Existing route             | Approval decision      |
| `container`                       | `server/container.ts`      | System info (settings) |

**Do NOT touch:** `core/runtime/`, `core/policy/`, `core/ai/`, `server/runtime/`, `server/policy/`, `server/ai/` (belong to D4.1, Governance, G1 agents).

## 7. Testing

### Required tests:

- **CkConversation**: renders empty state, renders messages, composer disabled when empty, keyboard submit
- **CkMissionProgress**: renders all mission statuses, hides on terminal status
- **CkApprovalCard**: pending/approved/rejected/expired states, reject flow with reason, error state, loading state
- **CkActivityTimeline**: renders activities, empty state, error state, skip reason display
- **CkMissionHistory**: renders mission cards, empty state, loading skeleton, error with retry
- **CkResultsArtifacts**: renders artifacts, empty state (no results = no block)
- **CkProjectSelector**: renders project list, selection changes active
- **CkSettingsPanel**: open/close, theme toggle, session display
- **CkShell**: responsive layout, sidebar collapse on mobile
- **statusConfig**: every status has a config entry
- **mappers**: ArtifactRef → ArtifactDisplay conversion
- **Accessibility**: aria-labels on buttons, roles on interactive elements, keyboard navigation on approval card
- **Accessibility contrast**: text meets WCAG AA against backgrounds

### Quality gates:

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

## 8. Deferred to Future

- Virtualisation for large message lists
- Voice STT/TTS (microphone button is placeholder only)
- Real i18n (language selector disabled)
- Real notifications (local preferences only)
- File preview / download
- "Relancer" mission button
- Advanced mode pages (Skills, Capabilities, Policies, Providers, Runtime, Audit)
- Project → backend context propagation
- Execution detail accordion (agent/skill/tool)
- SSE/streaming (placeholder visual only)
- Active duration vs waiting duration metrics

## 9. Risks & Blockers

| Risk                             | Mitigation                                                    |
| -------------------------------- | ------------------------------------------------------------- |
| Breaking existing tests          | Don't modify existing components; add new ones in `cockpit/`  |
| CSS collisions                   | Use `.ck-` prefix for new classes; don't rename existing ones |
| TypeScript strict mode           | All mocks and mappers are fully typed with Zod contracts      |
| Chat performance                 | No virtualisation = capped at ~100 messages; fine for V1      |
| Mission contract not yet aligned | Use only fields confirmed present; optional fields guarded    |

## 10. Final Synthesis — Cockpit V1

**Branch:** `feat/cockpit-v1`
**Base:** `main`
**Status:** READY_FOR_IMPLEMENTATION

### Components Created (11)

| Component          | Purpose                       | Backend dep             |
| ------------------ | ----------------------------- | ----------------------- |
| CkShell            | Layout wrapper                | None (UI only)          |
| CkSidebar          | Navigation sidebar            | None (UI only)          |
| CkConversation     | Chat with message history     | None (mock store)       |
| CkMessageBubble    | Single message display        | None                    |
| CkThinkingState    | Inline thinking animation     | None                    |
| CkComposer         | Input + send + mic            | None                    |
| CkInFlowCard       | Generic in-flow card wrapper  | None                    |
| CkMissionProgress  | Progress bar + status display | MissionStatus enum      |
| CkApprovalCard     | Approval request card         | AgentAction + RiskLevel |
| CkActivityTimeline | Step-by-step activity         | Run/Step contract       |
| CkMissionHistory   | Past missions list            | Mission contract        |
| CkResultsArtifacts | Artifacts display             | ArtifactRef (future)    |
| CkProjectSelector  | Project dropdown              | None (mock V1)          |
| CkSettingsPanel    | Settings overlay              | Container info          |
| CkAdvancedSection  | Collapsible advanced nav      | None (UI only)          |

### Mocks Introduced (5 files)

- `features/cockpit/mocks/mock-missions.ts`
- `features/cockpit/mocks/mock-messages.ts`
- `features/cockpit/mocks/mock-approvals.ts`
- `features/cockpit/mocks/mock-history.ts`
- `features/cockpit/mocks/mock-projects.ts`

### Backend Dependencies (read-only)

- `MissionStatus`, `Mission` from `core/mission/contract.ts`
- `AgentAction`, `RiskLevel` from `core/contracts/`
- `POST /api/actions/{id}/decision` (existing)

### Responsive

- Desktop ≥1024px: full layout
- Tablet 768-1023px: collapsible sidebar
- Mobile <768px: overlay sidebar, compact footer

### Accessibility

- All buttons have aria-labels
- Roles on interactive elements
- Keyboard navigation on approval card (Tab, Enter, Escape)
- Focus management on modal/overlay
- Screen reader friendly status announcements

### Quality

- `pnpm lint` → PASS
- `pnpm typecheck` → PASS
- `pnpm test` → PASS (new + existing)
- `pnpm build` → PASS
- `git diff --check` → PASS

### Known Limitations

- No virtualisation (keep for post-V1)
- Voice is placeholder only (no STT/TTS)
- No real i18n (language selector disabled)
- Mock data for future endpoints clearly labeled
- Project switch is UI-only (no backend context)
- Recovery options from UI display only (backend authority)
- Approval countdown is UI timer (not business expiration)
