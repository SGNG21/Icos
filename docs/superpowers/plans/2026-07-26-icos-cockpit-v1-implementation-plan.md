# ICOS Cockpit V1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the current ICOS technical dashboard into a premium user cockpit (ChatGPT + Linear + Raycast + Jarvis feel) with conversation-first UX, mission tracking, approvals, activity, results, and basic settings.

**Architecture:** Add 15 new components under `src/components/cockpit/` and a `src/features/cockpit/` module with mocks, mappers, and type definitions. The existing `src/app/page.tsx` is rewritten to use the new `CkShell` layout. Existing `src/styles/globals.css` is extended (not replaced). Backend contracts are read-only dependencies — no contract changes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind CSS 4, Zod 4, Vitest 4. No new dependencies.

## Global Constraints

- UI ≠ policy authority, approval authority, execution authority
- MissionProgress ≠ ActivityTimeline — distinct components, distinct data
- ArtifactDisplay = UI view model only; ArtifactRef → mapper → display pipeline
- Artifact ≠ ExternalReference ≠ Error — separate conceptual types
- Project UI mock ≠ real project business context
- Displayed role ≠ backend authorization — never simulate identity authority
- Displayed system state must come from real container when presented as real
- No fake notifications, no fake i18n, no fake artifact opening, no fake project backend switching
- FINISH > NEW FEATURES — existing tests must pass, no regression
- All new CSS classes prefixed `.ck-` to avoid collisions with existing styles
- All mocks clearly labeled `// MOCK — replace with real API data`
- Do NOT touch: `src/core/runtime/`, `src/core/policy/`, `src/core/ai/`, `src/server/runtime/`, `src/server/policy/`, `src/server/ai/`
- Do NOT modify any existing Zod contracts in `src/core/contracts/` or `src/core/mission/`

---

## File Map

### Created files

```
src/features/cockpit/
├── types.ts                     — UI view models (ArtifactDisplay, ActivityItem, ChatMessage, etc.)
├── mappers.ts                   — Contract → UI model converters
├── statusConfig.ts              — MissionStatus → label/icon/color/style mapping (extensible)
├── format.ts                    — Duration, relative time, size formatting utilities
├── store.ts                     — Simple in-memory store (V1 mock — replaceable)
└── mocks/
    ├── mock-missions.ts         — Mock Mission data for active missions
    ├── mock-messages.ts         — Mock ChatMessage history
    ├── mock-approvals.ts        — Mock AgentAction payloads (sensitive only)
    ├── mock-history.ts          — Mock completed/failed/cancelled missions
    └── mock-projects.ts         — Mock project list

src/components/cockpit/
├── CkShell.tsx                  — Layout: sidebar + conversation + footer bar
├── CkSidebar.tsx                — Navigation: projects, missions, memory, advanced
├── CkConversation.tsx           — Central chat: message list + composer + scroll
├── CkMessageBubble.tsx          — Single message: user | ICOS with variants
├── CkThinkingState.tsx          — Inline thinking dots animation
├── CkComposer.tsx               — Input field + send button + mic placeholder
├── CkInFlowCard.tsx             — Generic wrapper for in-flow cards (mission, approval, activity)
├── CkMissionProgress.tsx        — Progress bar: in-flow variant + footer variant
├── CkApprovalCard.tsx           — Approval request: pending/approved/rejected/expired states
├── CkActivityTimeline.tsx       — Step-by-step activity events
├── CkMissionHistory.tsx         — Past missions list (paginated)
├── CkResultsArtifacts.tsx       — Artifacts display block
├── CkProjectSelector.tsx        — Project dropdown (sidebar top)
├── CkSettingsPanel.tsx          — Settings overlay (theme, session, system info)
└── CkAdvancedSection.tsx        — Collapsible nav for advanced mode
```

### Modified files

```
src/app/page.tsx                 — Rewrite to use CkShell + CkConversation + CkSidebar
src/styles/globals.css           — Add `.ck-` prefixed classes (extend, don't replace)
```

### Test files

```
src/components/cockpit/CkShell.test.tsx
src/components/cockpit/CkConversation.test.tsx
src/components/cockpit/CkComposer.test.tsx
src/components/cockpit/CkMissionProgress.test.tsx
src/components/cockpit/CkApprovalCard.test.tsx
src/components/cockpit/CkActivityTimeline.test.tsx
src/components/cockpit/CkMissionHistory.test.tsx
src/components/cockpit/CkResultsArtifacts.test.tsx
src/components/cockpit/CkProjectSelector.test.tsx
src/components/cockpit/CkSettingsPanel.test.tsx
src/features/cockpit/statusConfig.test.ts
src/features/cockpit/mappers.test.ts
src/features/cockpit/format.test.ts
```

---

## CPT-0: Foundation

### Task 0.1: statusConfig — Mission status mapping

**Files:**
- Create: `src/features/cockpit/statusConfig.ts`
- Test: `src/features/cockpit/statusConfig.test.ts`

**Interfaces:**
- Produces: `statusConfig` record with `label`, `icon`, `color`, `cssClass` per `MissionStatus`
- Produces: `getStatusConfig(status: MissionStatus): StatusConfigItem`
- Produces: `riskLabelMap` and `riskStyleMap` as extensible records

```typescript
// src/features/cockpit/statusConfig.ts

import type { MissionStatus } from "@/core/mission";
import type { RiskLevel } from "@/core/contracts";

export interface StatusConfigItem {
  label: string;        // "En cours", "Suspendue — Fournisseur indisponible"
  icon: string;         // "●", "◉", "⚠", "✅", "❌", "—"
  color: string;        // CSS color class suffix
  cssClass: string;     // full class name for the status dot/bar
}

export interface RiskConfigItem {
  label: string;        // "Lecture seule", "Réversible", "Sensible"
  cssClass: string;     // "risk-read_only", "risk-reversible", "risk-sensitive"
}

// Extensible records — add new entries when backend adds new values
export const statusConfig: Record<MissionStatus, StatusConfigItem>;
export const riskLabelMap: Record<RiskLevel, string>;
export const riskStyleMap: Record<string, RiskConfigItem>;

export function getStatusConfig(status: MissionStatus): StatusConfigItem;
export function getRiskConfig(risk: RiskLevel): RiskConfigItem;
```

- [ ] **Step 1:** Create `src/features/cockpit/statusConfig.ts` with the full 14-status mapping from the design spec and 3-risk mapping. Use extensible records (not closed unions). Recovery statuses (PROVIDER_UNAVAILABLE through MISSION_RECOVERABLE) share main label "Suspendue" with distinct sub-status displayed immediately.

- [ ] **Step 2:** Create `src/features/cockpit/statusConfig.test.ts` — test every status has a config entry, every RiskLevel has a map entry, `getStatusConfig()` returns correct values.

- [ ] **Step 3:** Run `pnpm test` — ensure passing. Commit with message `feat(cockpit): add statusConfig — MissionStatus → UI mapping`.

### Task 0.2: Format utilities

**Files:**
- Create: `src/features/cockpit/format.ts`
- Test: `src/features/cockpit/format.test.ts`

**Interfaces:**
- Produces: `formatSizeBytes(bytes: number): string` — "3.2 Ko", "1.1 Mo"
- Produces: `formatDurationMs(ms: number): string` — "2 min 30", "12 s"
- Produces: `formatRelativeTime(isoString: string): string` — "il y a 1 heure", "il y a 30 s"
- Produces: `formatStepCount(completed: number, total: number): string` — "3/5 étapes"

```typescript
// Uses Intl.RelativeTimeFormat for relative time (native, no dependency)
// Uses simple formatting for bytes: 1024 → "1 Ko", 1048576 → "1 Mo"
// Uses Math.floor for duration display
```

- [ ] **Step 1:** Create `src/features/cockpit/format.ts` with all four formatters. `formatRelativeTime` uses `Intl.RelativeTimeFormat` with `{ numeric: "auto" }`.

- [ ] **Step 2:** Create `src/features/cockpit/format.test.ts` — test edge cases (0 bytes, 0 ms, future dates, negative durations).

- [ ] **Step 3:** Run tests. Commit `feat(cockpit): add format utilities`.

### Task 0.3: UI types definition

**Files:**
- Create: `src/features/cockpit/types.ts`

**Interfaces:**
- Produces: `ArtifactDisplay` — view model for artifact display (not an Error, not an ExternalReference)
- Produces: `ActivityItem` — step event for timeline
- Produces: `ChatMessage` — message in conversation (user | icos | thinking | in-flow card)
- Produces: `InFlowCard` — generic in-flow block (mission, approval, activity, result)
- Produces: `MissionHistoryItem` — subset of Mission for history display
- Produces: `ProjectInfo` — lightweight project for selector
- Produces: `CockpitStore` — store shape (in-memory)

```typescript
// KEY TYPES — full contract:

export type ArtifactType = "document" | "data" | "code" | "image" | "link";

export interface ArtifactDisplay {
  id: string;
  type: ArtifactType;
  displayName: string;   // "Rapport d'analyse"
  originalName: string;  // "output_step3.json"
  sizeBytes?: number;
  description?: string;
}

export type ActivityStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface ActivityItem {
  stepIndex: number;
  label: string;
  description?: string;
  status: ActivityStatus;
  skipReasonCode?: string;
  skipReason?: string;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
}

export type MessageRole = "user" | "icos" | "thinking" | "mission-progress" | "approval" | "activity" | "result" | "error";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content?: string;        // Text content (for user/icos/error)
  errorLabel?: string;     // "Réessayer" action label
  payload?: unknown;       // Data for in-flow cards (Mission, AgentAction, ActivityItem[], ArtifactDisplay[])
  timestamp: string;
}

export interface MissionHistoryItem {
  id: string;
  status: MissionStatus;
  userRequest: string;
  totalSteps?: number;
  completedSteps?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectInfo {
  id: string;
  displayName: string;
  active: boolean;
}
```

- [ ] **Step 1:** Create `src/features/cockpit/types.ts` with all types above. Use `import type { MissionStatus } from "@/core/mission"` for status values. No Zod schemas — these are plain TypeScript interfaces (UI view models).

- [ ] **Step 2:** Commit `feat(cockpit): add UI view model types`.

### Task 0.4: Mock data files

**Files:**
- Create: `src/features/cockpit/mocks/mock-missions.ts`
- Create: `src/features/cockpit/mocks/mock-messages.ts`
- Create: `src/features/cockpit/mocks/mock-approvals.ts`
- Create: `src/features/cockpit/mocks/mock-history.ts`
- Create: `src/features/cockpit/mocks/mock-projects.ts`

**Interfaces:** All mock files export `const` arrays of the UI types defined in Task 0.3. Each file has the header `// MOCK — replace with real API data when endpoint exists`.

- [ ] **Step 1:** Create `mock-missions.ts` — 3 mock missions: IN_PROGRESS (Analyse ICOS), WAITING_FOR_APPROVAL (Déploiement), PLANNING (Rapport de sécurité). Each with a plan containing steps.

- [ ] **Step 2:** Create `mock-messages.ts` — 10+ mock ChatMessages including user messages, ICOS responses, thinking states, mission progress, approval, activity, and results.

- [ ] **Step 3:** Create `mock-approvals.ts` — 3 mock approval payloads (all sensitive, no "banal" reversible): "Déploiement production — v3.2.1", "Merge vers main — 14 commits", "Accès réseau exceptionnel — SSH production".

- [ ] **Step 4:** Create `mock-history.ts` — 6 mock missions: 2 COMPLETED, 2 FAILED (one with error), 2 CANCELLED. Include diverse durations and relative times.

- [ ] **Step 5:** Create `mock-projects.ts` — 3 mock projects: ICOS (active), Polivia, Clients. Label as pure visual mock.

- [ ] **Step 6:** Commit `feat(cockpit): add mock data files`.

### Task 0.5: Mappers — Contract → UI model

**Files:**
- Create: `src/features/cockpit/mappers.ts`
- Test: `src/features/cockpit/mappers.test.ts`

**Interfaces:**
- Produces: `missionToHistoryItem(mission: Mission): MissionHistoryItem`
- Produces: `artifactRefToDisplay(ref: ArtifactRef): ArtifactDisplay` (stub for future — returns mock data for V1)
- Produces: `actionToApprovalCard(action: AgentAction): ChatMessage` (converts approval payload to in-flow card)

```typescript
// Uses existing Mission and AgentAction types from core contracts
// Does NOT access mocks directly — pure mapping functions
```

- [ ] **Step 1:** Create `src/features/cockpit/mappers.ts` with mapper functions. Use only fields confirmed existing in the Mission/AgentAction Zod schemas.

- [ ] **Step 2:** Create `src/features/cockpit/mappers.test.ts` — test each mapper with valid input and edge cases (missing optional fields).

- [ ] **Step 3:** Run tests. Commit `feat(cockpit): add contract → UI mappers`.

### Task 0.6: In-memory store

**Files:**
- Create: `src/features/cockpit/store.ts`

**Interfaces:**
- Produces: `createCockpitStore(): CockpitStore`
- Produces: store interface with `messages`, `activeMission`, `history`, `projects`, `approvals`

```typescript
export interface CockpitStore {
  messages: ChatMessage[];
  activeMission: Mission | null;
  history: MissionHistoryItem[];
  approvals: AgentAction[];
  projects: ProjectInfo[];
  activeProjectId: string;
  // Actions
  addMessage(msg: ChatMessage): void;
  setActiveMission(m: Mission | null): void;
  setActiveProject(id: string): void;
  resolveApproval(actionId: string, decision: "approved" | "rejected"): void;
}
```

- [ ] **Step 1:** Create `src/features/cockpit/store.ts` with a simple store factory that wraps a `let` state + getter functions. Initializes with mock data from Task 0.4. No React state library needed.

- [ ] **Step 2:** Commit `feat(cockpit): add in-memory store with mock initialization`.

### Task 0.7: CSS extensions

**Files:**
- Modify: `src/styles/globals.css`

- [ ] **Step 1:** Append new `.ck-` prefixed CSS classes to `globals.css`:
  - `.ck-shell` — main layout grid
  - `.ck-sidebar` — sidebar with project nav
  - `.ck-conversation` — chat container with scroll
  - `.ck-message-bubble`, `.ck-message-user`, `.ck-message-icos` — message styling
  - `.ck-composer` — fixed input bar
  - `.ck-mission-progress` — progress bar variants
  - `.ck-approval-card` — approval card
  - `.ck-activity-timeline` — activity events
  - `.ck-history-card` — history list item
  - `.ck-artifact-display` — artifact block
  - `.ck-settings-overlay` — settings modal
  - `.ck-thinking` — thinking dots animation
  - `.ck-sidebar-overlay` — mobile sidebar overlay
  - `.ck-footer-bar` — mission footer bar
  - `.ck-advanced-section` — collapsible advanced nav

  Use existing custom properties (`--forest`, `--mint`, `--amber`, `--ink`, `--muted`, `--line`, `--paper`, `--panel`). Add responsive breakpoints matching the spec.

- [ ] **Step 2:** Verify no existing class conflicts (grep for `.ck-` in existing codebase). Commit `feat(cockpit): add CSS classes for cockpit components`.

---

## CPT-1: Conversation Core

### Task 1.1: CkShell — Layout wrapper

**Files:**
- Create: `src/components/cockpit/CkShell.tsx`
- Test: `src/components/cockpit/CkShell.test.tsx`

**Interfaces:**
```typescript
interface CkShellProps {
  sidebar: React.ReactNode;
  conversation: React.ReactNode;
  footerBar?: React.ReactNode;
  topBarRight?: React.ReactNode;
}
```

Layout structure:
- `div.ck-shell` (grid: sidebar | main)
- Top bar: ICOS brand left, user/settings right
- Sidebar column: receives CkSidebar
- Main column: conversation (scrollable)
- Footer bar (optional): receives CkMissionProgress footer variant
- Mobile: sidebar hidden (overlay toggle), `ck-sidebar-overlay` when open

- [ ] **Step 1:** Write the test — renders children, renders top bar with brand, renders footer bar when provided, hides footer bar when not provided.

- [ ] **Step 2:** Create `CkShell.tsx` — simple layout component. Use `<header>` for top bar, `<aside>` for sidebar, `<main>` for conversation.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkShell layout`.

### Task 1.2: CkSidebar — Navigation sidebar

**Files:**
- Create: `src/components/cockpit/CkSidebar.tsx`
- Test: `src/components/cockpit/CkSidebar.test.tsx`

**Interfaces:**
```typescript
interface CkSidebarProps {
  projectSelector: React.ReactNode;
  activeMissionCount: number;
  historyCount: number;
  advancedChildren?: React.ReactNode;
  onClose?: () => void;  // mobile overlay close
}
```

Structure:
- Brand: "ICOS" mark + user email/name
- Projets section: receives CkProjectSelector
- Missions section: "En cours (N)", "Historique"
- Mémoire item
- ⚙️ Avancé (collapsible): receives CkAdvancedSection
- Footer: mini status + logout

- [ ] **Step 1:** Write the test — renders brand, renders section labels, shows mission counts, close button calls onClose on mobile.

- [ ] **Step 2:** Create `CkSidebar.tsx`. Mobile: full sidebar with close button, overlay with backdrop.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkSidebar`.

### Task 1.3: CkMessageBubble — Single message

**Files:**
- Create: `src/components/cockpit/CkMessageBubble.tsx`
- Test: `src/components/cockpit/CkMessageBubble.test.tsx`

**Interfaces:**
```typescript
interface CkMessageBubbleProps {
  role: "user" | "icos" | "error";
  content: string;
  timestamp?: string;
  actionLabel?: string;      // "Réessayer" for error messages
  onAction?: () => void;
}
```

Rendering:
- User: right-aligned, `--forest` background, white text
- ICOS: left-aligned, `--panel` background, `--ink` text
- Error: left-aligned, red-tinted background, error icon, action button

- [ ] **Step 1:** Write the test — renders user message correctly, renders ICOS message, renders error with action button, action fires callback.

- [ ] **Step 2:** Create `CkMessageBubble.tsx`. Use CSS classes from Task 0.7.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkMessageBubble`.

### Task 1.4: CkThinkingState — Inline thinking animation

**Files:**
- Create: `src/components/cockpit/CkThinkingState.tsx`

**Interfaces:**
```typescript
interface CkThinkingStateProps {
  label?: string;  // "Réflexion en cours…" — default if omitted
}
```

Rendering: Three dots `▍ ▍ ▍` with CSS animation (opacity pulse). Inline within ICOS bubble — not a separate large block.

- [ ] **Step 1:** Create `CkThinkingState.tsx` with CSS keyframe animation for dot pulsing.

- [ ] **Step 2:** Commit `feat(cockpit): add CkThinkingState`.

### Task 1.5: CkComposer — Input + send + mic placeholder

**Files:**
- Create: `src/components/cockpit/CkComposer.tsx`
- Test: `src/components/cockpit/CkComposer.test.tsx`

**Interfaces:**
```typescript
interface CkComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;  // default: "Décris ton objectif…"
}
```

Rendering:
- Input field (no label — placeholder only)
- Send button ▶ (disabled when empty or disabled prop)
- Microphone button 🎙 (disabled, opacity 0.5, title "Bientôt disponible")
- Enter key submits (if not empty)

- [ ] **Step 1:** Write the test — renders input and buttons, send button disabled when empty, onSend called on submit, Enter key triggers send, mic button rendered disabled.

- [ ] **Step 2:** Create `CkComposer.tsx`. Use uncontrolled input with state, `onSubmit` handler.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkComposer`.

### Task 1.6: CkInFlowCard — Generic in-flow card wrapper

**Files:**
- Create: `src/components/cockpit/CkInFlowCard.tsx`

**Interfaces:**
```typescript
interface CkInFlowCardProps {
  title: string;
  icon?: string;
  children: React.ReactNode;
  variant?: "mission" | "approval" | "activity" | "result";
}
```

Rendering: Styled card with title bar, icon, content area. Subtle border, rounded corners. Each variant gets a subtle color accent on the left border.

- [ ] **Step 1:** Create `CkInFlowCard.tsx`.

- [ ] **Step 2:** Commit `feat(cockpit): add CkInFlowCard generic wrapper`.

### Task 1.7: CkConversation — Central chat

**Files:**
- Create: `src/components/cockpit/CkConversation.tsx`
- Test: `src/components/cockpit/CkConversation.test.tsx`

**Interfaces:**
```typescript
interface CkConversationProps {
  messages: ChatMessage[];
  onSend: (message: string) => void;
  disabled?: boolean;
  // Approval callbacks
  onApprove?: (actionId: string) => void;
  onReject?: (actionId: string, reason?: string) => void;
  // Error recovery
  onRetry?: (messageId: string) => void;
}
```

Structure:
- Scrollable message list (auto-scroll to bottom on new messages)
- Empty state when no messages: orbit mark + "Que veux-tu faire ?" heading + subtitle
- Message rendering: switch on `role` → CkMessageBubble (user/icos/error), CkThinkingState (thinking), CkInFlowCard with appropriate child (mission-progress/approval/activity/result)
- "↓ Dernier message" FAB when scrolled up (detect scroll position)
- Fixed CkComposer at bottom

- [ ] **Step 1:** Write the test — renders empty state, renders messages of all types, auto-scrolls to bottom, shows "↓" FAB when scrolled up, composer sends messages, approval card callbacks fire.

- [ ] **Step 2:** Create `CkConversation.tsx`. Render message list via `.map()`, switch on `msg.role`. In-flow cards rendered via CkInFlowCard with child components (CkMissionProgress, CkApprovalCard, CkActivityTimeline, CkResultsArtifacts).

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkConversation central chat`.

---

## CPT-2: Mission UX

### Task 2.1: CkMissionProgress — Progress bar

**Files:**
- Create: `src/components/cockpit/CkMissionProgress.tsx`
- Test: `src/components/cockpit/CkMissionProgress.test.tsx`

**Interfaces:**
```typescript
interface CkMissionProgressProps {
  mission: Mission;
  variant?: "in-flow" | "footer";
  onStepClick?: (stepIndex: number) => void;
}
```

Two rendering variants via CSS:
- **in-flow**: Full card with steps list, status icons, current step label
- **footer**: Compact bar with title + progress + status label (hidden if terminal status)

Progress rules:
- If `mission.plan` exists: `completedRuns / plan.steps.length`
- If no plan or steps: indeterminate spinner + "En cours…" — NEVER fake a percentage
- Uses `getStatusConfig(mission.status)` for icon/color/label

- [ ] **Step 1:** Write the test — renders in-flow variant with steps, renders footer variant compact, hides footer on terminal status (COMPLETED/FAILED/CANCELLED), shows indeterminate state when no plan, renders all 14 statuses correctly, renders recovery statuses with visible sub-status.

- [ ] **Step 2:** Create `CkMissionProgress.tsx`. Footer variant: hidden when `TERMINAL_STATUSES.includes(mission.status)`.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkMissionProgress`.

### Task 2.2: CkActivityTimeline — Step-by-step activity

**Files:**
- Create: `src/components/cockpit/CkActivityTimeline.tsx`
- Test: `src/components/cockpit/CkActivityTimeline.test.tsx`

**Interfaces:**
```typescript
interface CkActivityTimelineProps {
  activities: ActivityItem[];
  title?: string;  // default: phase label
}
```

Rendering:
- Grouped by phase with separator line
- Each item: status icon + label + description (optional) + time (optional)
- Failed items: red icon, error description
- Skipped items: ⏭️ icon + skip reason (if available)
- Empty items: no block rendered at all (no "no activity" placeholder)
- Agent names: NOT shown by default (use "Stratégie sélectionnée" not "Agent CTO sélectionné")

- [ ] **Step 1:** Write the test — renders activity items with correct status icons, renders all 5 activity statuses, renders failed item with error, renders skip reason when available, shows empty state as no render, does not render agent names.

- [ ] **Step 2:** Create `CkActivityTimeline.tsx`.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkActivityTimeline`.

### Task 2.3: CkApprovalCard — Approval request

**Files:**
- Create: `src/components/cockpit/CkApprovalCard.tsx`
- Test: `src/components/cockpit/CkApprovalCard.test.tsx`

**Interfaces:**
```typescript
interface CkApprovalCardProps {
  action: AgentAction;
  expiresAt?: string;       // ISO timestamp for countdown
  scope?: string;           // "Organisation ICOS · 3 services"
  reason?: string;          // "Mise en production de nouvelles règles"
  onApprove: (actionId: string) => void;
  onReject: (actionId: string, reason?: string) => void;
  decisionState?: "pending" | "approved" | "rejected";
  decisionOutcome?: string; // "Autorisation accordée" / "Refusée"
  decisionReason?: string;  // Refusal reason text
  error?: string;           // Error message
  loading?: boolean;
}
```

States:
- **pending**: Full card with action, reason, risk chip, scope, expiration countdown, [Refuser] [Autoriser] buttons
- **approved**: "✅ Autorisation accordée" message (NOT "Action exécutée")
- **rejected**: "❌ Refusée · Motif: …" with reason
- **expired**: "⏰ Demande expirée · Cette autorisation n'est plus utilisable." (UI timeout ≠ business cancellation — no "annulée automatiquement")
- **loading**: Buttons disabled + "◌ Enregistrement…"
- **error**: Error message + [Réessayer]

Expiration countdown: client-side only. If `expiresAt` provided, show relative countdown updated every second. When reaches 0 → "Demande expirée". Does NOT call any API on expiration.

Reject flow: Click [Refuser] → inline textarea for optional reason → [Annuler] [Confirmer le rejet]

Risk chip uses `getRiskConfig()` from statusConfig (extensible).

- [ ] **Step 1:** Write the test — renders pending card with all fields, approve fires callback, reject shows reason field and confirms, approved state shows "Autorisation accordée", rejected state shows reason, expired state shows correct message, loading state disables buttons, error state shows retry, risk chip renders correctly.

- [ ] **Step 2:** Create `CkApprovalCard.tsx`. Use `CkInFlowCard` with `variant="approval"`. Implement countdown with `useEffect` + `setInterval` (cleaned up on unmount). Never hardcode "Agent CTO" or agent names visible by default.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkApprovalCard`.

---

## CPT-3: History + Results

### Task 3.1: CkMissionHistory — Past missions list

**Files:**
- Create: `src/components/cockpit/CkMissionHistory.tsx`
- Test: `src/components/cockpit/CkMissionHistory.test.tsx`

**Interfaces:**
```typescript
interface CkMissionHistoryProps {
  missions: MissionHistoryItem[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onMissionClick?: (missionId: string) => void;
}
```

Rendering:
- List of mission cards, each with: status icon + label + title + step count + duration + relative time
- Failed missions show error text (from `mission.error`)
- Cancelled missions show generic "Annulée"
- Empty state: "Aucune mission terminée pour le moment."
- Loading: 3 skeleton cards (gray animated bars)
- Error: error message + [Réessayer] button
- "Charger plus" button at bottom if `hasMore`
- Loading more: spinner in "Charger plus"

- [ ] **Step 1:** Write the test — renders mission cards with all fields, renders empty state, renders loading skeleton, renders error with retry, load more fires callback, card click fires onMissionClick, renders failed mission with error text, renders cancelled mission.

- [ ] **Step 2:** Create `CkMissionHistory.tsx`. Use `Intl.RelativeTimeFormat` via `formatRelativeTime()`. Use `formatStepCount()` and `formatDurationMs()`.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkMissionHistory`.

### Task 3.2: CkResultsArtifacts — Artifacts display

**Files:**
- Create: `src/components/cockpit/CkResultsArtifacts.tsx`
- Test: `src/components/cockpit/CkResultsArtifacts.test.tsx`

**Interfaces:**
```typescript
interface CkResultsArtifactsProps {
  artifacts: ArtifactDisplay[];
  title?: string;  // default: "Résultats"
  loading?: boolean;
}
```

Rendering:
- List of artifacts with icon + displayName + size
- displayName shown primarily, originalName as subtitle (small, muted)
- Size formatted via `formatSizeBytes()`
- Loading: skeleton rows
- Empty artifacts array: no block rendered at all
- NOT artifacts: errors, ExternalReferences (displayed separately if needed)

Pipeline note: In V1, artifacts come from mock data (`ArtifactDisplay[]` directly). The mapper (`artifactRefToDisplay`) is defined but receives mock data. The pipeline `ArtifactRef → mapper → ArtifactDisplay → UI` is structurally ready.

- [ ] **Step 1:** Write the test — renders artifact list with icons, renders displayName + originalName, renders size formatted, renders loading skeleton, empty array renders nothing.

- [ ] **Step 2:** Create `CkResultsArtifacts.tsx`. Use `CkInFlowCard` with `variant="result"`.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkResultsArtifacts`.

### Task 3.3: Mission detail view (in-flow)

**Files:**
- Create: `src/components/cockpit/CkMissionDetail.tsx`
- Test: `src/components/cockpit/CkMissionDetail.test.tsx`

**Interfaces:**
```typescript
interface CkMissionDetailProps {
  mission: Mission;
  artifacts: ArtifactDisplay[];
}
```

Rendering: Card shown when clicking on a history mission. Shows:
- Status icon + label
- Duration totale (completedAt - createdAt)
- Step count (completed/total)
- Artifact count
- List of artifacts (reuses CkResultsArtifacts)
- "Nouvelle mission" button (future action — no-op in V1 or clears conversation)

- [ ] **Step 1:** Write the test — renders mission details, shows artifacts list, shows status and duration.

- [ ] **Step 2:** Create component.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkMissionDetail`.

---

## CPT-4: Project + Settings

### Task 4.1: CkProjectSelector — Project dropdown

**Files:**
- Create: `src/components/cockpit/CkProjectSelector.tsx`
- Test: `src/components/cockpit/CkProjectSelector.test.tsx`

**Interfaces:**
```typescript
interface CkProjectSelectorProps {
  projects: ProjectInfo[];
  activeProjectId: string;
  onProjectChange: (projectId: string) => void;
}
```

Rendering:
- Dropdown toggle showing active project icon + name + ▼ arrow
- Click opens dropdown list with all projects
- Active project marked ◄
- Dropdown closes on outside click (useEffect with click listener)
- Dropdown closes on selection
- V1: UI-only switch — calls `onProjectChange`, no API call
- Empty projects array: "Aucun projet"

- [ ] **Step 1:** Write the test — renders active project, opens dropdown, selection fires callback, outside click closes, active project marked, empty state renders.

- [ ] **Step 2:** Create `CkProjectSelector.tsx`.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkProjectSelector`.

### Task 4.2: CkAdvancedSection — Collapsible advanced nav

**Files:**
- Create: `src/components/cockpit/CkAdvancedSection.tsx`

**Interfaces:**
```typescript
interface CkAdvancedSectionProps {
  defaultOpen?: boolean;  // false — collapsed by default
}
```

Rendering:
- "⚙️ Avancé" toggle button (expand/collapse)
- Collapsed by default
- Items: Skills, Capacités, Politiques, Providers, Runtime, Audit
- Each item: disabled link or button showing "Bientôt disponible"
- Smooth expand/collapse animation (max-height transition)

- [ ] **Step 1:** Create `CkAdvancedSection.tsx`.

- [ ] **Step 2:** Commit `feat(cockpit): add CkAdvancedSection`.

### Task 4.3: CkSettingsPanel — Settings overlay

**Files:**
- Create: `src/components/cockpit/CkSettingsPanel.tsx`
- Test: `src/components/cockpit/CkSettingsPanel.test.tsx`

**Interfaces:**
```typescript
interface CkSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  systemInfo?: {
    version: string;
    executionMode?: string;
    persistenceMode?: string;
    environment?: string;
  };
  sessionInfo?: {
    email?: string;
    role?: string;
    authenticated: boolean;
  };
}
```

Rendering: Modal overlay with:
- **Langue**: "Français" — no dropdown, or disabled select "Bientôt disponible"
- **Thème**: three radio/toggle buttons — Sombre / Clair / Système. Functional in V1. Stores to `localStorage.theme`, applies via `document.documentElement.dataset.theme`.
- **Notifications**: "Préférences locales" label above checkboxes (Approvals, Mission end, Planning failures). Checkboxes update localStorage only — no backend calls.
- **Session**: Email + rôle (from real auth if available, else labeled mock). Logout button reuses existing `LogoutButton`. Never simulate "owner" role — use real data or label as mock.
- **Système**: Read-only from `systemInfo` prop. Version, execution mode, persistence mode, environment. Never hardcode "Exécution : verrouillée" — must come from real data.

- [ ] **Step 1:** Write the test — opens/closes correctly, theme toggle updates localStorage, session section shows real vs mock data, system section reads from props, close on Escape key, close on outside click, logout button present.

- [ ] **Step 2:** Create `CkSettingsPanel.tsx`. Use `createPortal` to render in body. Focus trap on open. Close on Escape + backdrop click.

- [ ] **Step 3:** Run test. Commit `feat(cockpit): add CkSettingsPanel`.

---

## CPT-5: Integration / Cleanup

### Task 5.1: Rewrite app/page.tsx — Cockpit integration

**Files:**
- Modify: `src/app/page.tsx` — replace current dashboard with cockpit layout

**Changes:**
- Replace existing `<main className="shell">` with `CkShell`
- Replace existing `<Sidebar>` with `CkSidebar`
- Replace existing conversation section with `CkConversation`
- Replace existing `<CommandComposer>` with `CkComposer` inside `CkConversation`
- Remove existing dashboard grid, agent grid, approvals panel, recent tasks from main page
- Keep auth/access checks (resolveCockpitAccess, forbidden, redirect)
- Keep container resolution
- Initialize cockpit store with mock data
- Pass real data where available (agents list, pending actions from container), fall back to mocks

```typescript
// The page remains a Server Component
// CkConversation, CkSidebar etc. are Client Components
// Store initialization happens in a client-side boundary
```

- [ ] **Step 1:** Rewrite `src/app/page.tsx` to use the new cockpit components. Restructure the JSX from:
  ```tsx
  <main className="shell">
    <Sidebar ... />
    <section className="workspace">
      <header className="topbar">...</header>
      <div className="dashboard-grid">...</div>
      <AgentGrid ... />
    </section>
  </main>
  ```
  To:
  ```tsx
  <CkShell sidebar={sidebar} conversation={conversation} footerBar={footerBar} />
  ```

- [ ] **Step 2:** Ensure all existing imports from `@/components/features/`, `@/components/layout/`, `@/components/auth/` still work (they may be used by admin routes — do not delete component files).

- [ ] **Step 3:** Run `pnpm build` — verify no broken imports or TypeScript errors.

- [ ] **Step 4:** Run `pnpm test` — verify existing tests still pass.

- [ ] **Step 5:** Commit `feat(cockpit): integrate cockpit layout in main page`.

### Task 5.2: Replace technical strings with user-facing labels

- [ ] **Step 1:** Audit all component props and labels. Ensure no technical jargon (D1, D2, D3, D4, AiGatewayPort, OmniRoute, ExecutionGrant, Provider routing) appears in user-facing UI.

- [ ] **Step 2:** Replace any remaining technical labels with user-friendly equivalents per the design spec.

- [ ] **Step 3:** Commit `fix(cockpit): replace technical labels with user-facing strings`.

### Task 5.3: Accessibility audit

**Files:** All cockpit components

**Checklist:**
- [ ] All interactive elements have accessible names (aria-label or visible label)
- [ ] Focus management on modal/overlay (CkSettingsPanel)
- [ ] Focus trap when overlay is open
- [ ] Escape key closes overlays/dropdowns
- [ ] Tab order logical in approval card (Refuser → Autoriser, not hidden elements)
- [ ] Approval card decision state announced to screen readers (aria-live region)
- [ ] Color contrast meets WCAG AA (verify risk chips, status dots against backgrounds)
- [ ] Keyboard navigation on approval card (Enter submits, Escape cancels)
- [ ] Sidebar navigation uses `<nav>` with aria-label
- [ ] Messages have role="log" and aria-live="polite"
- [ ] Empty states have appropriate heading hierarchy

- [ ] **Step 1:** Apply accessibility fixes to all cockpit components.

- [ ] **Step 2:** Commit `fix(cockpit): accessibility audit — labels, focus, keyboard, contrast`.

### Task 5.4: Responsive behavior verification

**Breakpoints to verify:** 1024px, 768px, 640px, 375px

- [ ] **Step 1:** Verify sidebar collapses to overlay at <768px.
- [ ] **Step 2:** Verify footer bar compacts (title + bar only, no step count) at <768px.
- [ ] **Step 3:** Verify composer is full-width on mobile.
- [ ] **Step 4:** Verify no horizontal overflow on any screen width.
- [ ] **Step 5:** Verify conversation messages have readable text on mobile (min font-size 16px).
- [ ] **Step 6:** Commit `fix(cockpit): responsive behavior adjustments`.

### Task 5.5: Final test suite verification

- [ ] **Step 1:** Run full `pnpm test` — all tests pass (existing + new).
- [ ] **Step 2:** Run `pnpm lint` — no new warnings.
- [ ] **Step 3:** Run `pnpm typecheck` — zero errors.
- [ ] **Step 4:** Run `pnpm build` — build succeeds.
- [ ] **Step 5:** Run `git diff --check` — no whitespace errors.
- [ ] **Step 6:** Run `pnpm format:check` — formatting consistent.

### Task 5.6: Self-review checklist

- [ ] **No duplicated components**: Check for overlap with `src/components/features/` components. New cockpit components are separate — old components remain for admin mode.
- [ ] **No backend coupling**: All mocks are in `src/features/cockpit/mocks/`, mappers are pure functions, store is replaceable.
- [ ] **No fake business logic**: Approval card never simulates backend authorization. Progress never fabricates percentages. Recovery options come from props, not UI logic.
- [ ] **No hardcoded technical terminology**: "D1/D2/D3/D4", "AiGatewayPort", "OmniRoute", "ExecutionGrant", "Provider" not visible in user-facing UI.
- [ ] **No inaccessible buttons**: All interactive elements testable via keyboard.
- [ ] **No mobile overflow**: Chat and sidebar tested at 375px width.
- [ ] **No hydration issues**: Client/Server component boundary clear (page is server, components are client).
- [ ] **No unnecessary dependencies**: Uses only React, existing CSS, Intl APIs.
- [ ] **No giant monolithic components**: Each cockpit component is focused (max ~200 lines).
- [ ] **MissionProgress ≠ ActivityTimeline**: Verified — distinct components, distinct data types, distinct rendering.
- [ ] **ArtifactDisplay ≠ Error ≠ ExternalReference**: Verified.

---

## COCKPIT V1 IMPLEMENTATION PLAN REPORT

**Spec:** `docs/superpowers/specs/2026-07-26-icos-cockpit-v1-design.md` (commit `d57ef24`)

**Lots:**

| Lot | Name | Tasks | Files |
|-----|------|-------|-------|
| CPT-0 | Foundation | 7 | 16 created, 1 modified |
| CPT-1 | Conversation Core | 7 | 10 created |
| CPT-2 | Mission UX | 3 | 4 created |
| CPT-3 | History + Results | 3 | 3 created |
| CPT-4 | Project + Settings | 3 | 3 created |
| CPT-5 | Integration / Cleanup | 6 | 1 modified |

**Estimated files:** 37 created (15 components, 5 feature modules, 5 mock files, 12 test files), 2 modified (page.tsx, globals.css)

**Backend dependencies (read-only):**
- `MissionStatus`, `Mission` from `src/core/mission/contract.ts`
- `AgentAction`, `RiskLevel` from `src/core/contracts/`
- `POST /api/actions/{id}/decision` (existing route, for approval submit)
- Container info (for system settings section)

**Mock boundaries:**
- `src/features/cockpit/mocks/*.ts` — all mock data files, labeled `// MOCK — replace with real API data`
- `src/features/cockpit/store.ts` — in-memory store initialized with mocks (replaceable)
- No mock calls API routes — approval decision calls real existing API
- Mocks are purely visual/structural — no fake business logic

**Implementation blockers:** NONE

**STATUS: READY_FOR_COCKPIT_IMPLEMENTATION**
