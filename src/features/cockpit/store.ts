// MOCK — replace with real API data when endpoint exists
// Simple in-memory store factory (no React state library — replaceable in future)

import type { Mission } from "@/core/mission";
import type { AgentAction } from "@/core/contracts";

import type { ChatMessage, CockpitStore, MissionHistoryItem, ProjectInfo } from "@/features/cockpit/types";

import { mockMissions } from "@/features/cockpit/mocks/mock-missions";
import { mockMessages } from "@/features/cockpit/mocks/mock-messages";
import { mockApprovals } from "@/features/cockpit/mocks/mock-approvals";
import { mockHistory } from "@/features/cockpit/mocks/mock-history";
import { mockProjects } from "@/features/cockpit/mocks/mock-projects";

/**
 * Create a cockpit store initialized with mock data.
 *
 * The store is a plain object wrapping mutable state. No React reactivity —
 * components read and subscribe at their own layer. This factory can be
 * replaced with React Query / server state once real endpoints exist.
 */
export function createCockpitStore(): CockpitStore {
  const state: {
    messages: ChatMessage[];
    activeMission: Mission | null;
    history: MissionHistoryItem[];
    approvals: AgentAction[];
    projects: ProjectInfo[];
    activeProjectId: string;
  } = {
    messages: [...mockMessages],
    activeMission: mockMissions[0] ?? null,
    history: [...mockHistory],
    approvals: [...mockApprovals],
    projects: [...mockProjects],
    activeProjectId: mockProjects.find((p) => p.active)?.id ?? mockProjects[0]?.id ?? "",
  };

  return {
    get messages(): ChatMessage[] {
      return state.messages;
    },
    get activeMission(): Mission | null {
      return state.activeMission;
    },
    get history(): MissionHistoryItem[] {
      return state.history;
    },
    get approvals(): AgentAction[] {
      return state.approvals;
    },
    get projects(): ProjectInfo[] {
      return state.projects;
    },
    get activeProjectId(): string {
      return state.activeProjectId;
    },

    addMessage(msg: ChatMessage): void {
      state.messages = [...state.messages, msg];
    },

    setActiveMission(m: Mission | null): void {
      state.activeMission = m;
    },

    setActiveProject(id: string): void {
      if (state.projects.some((p) => p.id === id)) {
        state.activeProjectId = id;
      }
    },

    resolveApproval(actionId: string, decision: "approved" | "rejected"): void {
      state.approvals = state.approvals.map((a) =>
        a.id === actionId
          ? { ...a, approvalStatus: decision === "approved" ? "approved" : "rejected" }
          : a,
      );
    },
  };
}
