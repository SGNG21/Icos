// MOCK — replace with real API data when endpoint exists

import type { AgentAction } from "@/core/contracts";

/**
 * Mock approval payloads.
 * Only sensitive real-world actions — no "banal" reversible approvals.
 */
export const mockApprovals: AgentAction[] = [
  {
    id: "action-deploy-001",
    initiatedByAgentId: "agent-cto",
    kind: "Déploiement production — v3.2.1",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    requestedAt: "2026-07-26T10:28:00.000Z",
  },
  {
    id: "action-merge-001",
    initiatedByAgentId: "agent-lead",
    kind: "Merge vers main — 14 commits",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    requestedAt: "2026-07-26T11:15:00.000Z",
  },
  {
    id: "action-ssh-001",
    initiatedByAgentId: "agent-devops",
    kind: "Accès réseau exceptionnel — SSH production",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    requestedAt: "2026-07-26T11:30:00.000Z",
  },
];
