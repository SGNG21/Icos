import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { type NextRequest, NextResponse } from "next/server";
import * as missionContracts from "@/core/mission/contracts";

// Helper to compute progression from tasks
function computeProgression(tasks: missionContracts.MissionTask[]) {
  const total = tasks.length;
  if (total === 0) {
    return { total: 0, succeeded: 0, running: 0, failed: 0, percentage: 0 };
  }
  const succeeded = tasks.filter((t) => t.status === "succeeded").length;
  const running = tasks.filter((t) => t.status === "running").length;
  // 'blocked' is a mission-level status, not a task-level status
  const failed = tasks.filter((t) => t.status === "failed").length;
  const percentage = Math.round((succeeded / total) * 100);
  return { total, succeeded, running, failed, percentage };
}

export type MissionProgression = ReturnType<typeof computeProgression>;

export interface MissionWithProgression {
  id: string;
  title: string;
  status: missionContracts.Mission["status"];
  progression: MissionProgression;
  attention: boolean;
}

// Helper to determine if mission needs attention
function needsAttention(
  mission: missionContracts.Mission,
  tasks: missionContracts.MissionTask[],
): boolean {
  // Mission status that requires attention
  const attentionStatuses: missionContracts.Mission["status"][] = [
    "blocked",
    "failed",
    "awaiting_approval",
  ];
  if (attentionStatuses.includes(mission.status)) {
    return true;
  }
  // Any task failed (blocked is mission-level, not task-level)
  if (tasks.some((t) => t.status === "failed")) {
    return true;
  }
  return false;
}

// Helper to determine if mission is recent (updated in last 7 days)
function isRecent(mission: missionContracts.Mission): boolean {
  if (!mission.updatedAt) return false;
  const now = new Date();
  const updated = new Date(mission.updatedAt);
  const diffTime = Math.abs(now.getTime() - updated.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays <= 7;
}

export async function GET(request: NextRequest) {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed); the proxy is never the security barrier.
    const access = await protectRoute({
      container,
      request,
      route: "api.missions.list",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;

    // Fetch all missions
    const missions = await container.mission.list();
    if (!missions) {
      // Fallback: if list method not available, return empty groups
      return NextResponse.json({
        active: [],
        blocked: [],
        awaitingApproval: [],
        succeededRecent: [],
        failedRecent: [],
      });
    }

    // Initialize groups
    const groups = {
      active: [] as MissionWithProgression[],
      blocked: [] as MissionWithProgression[],
      awaitingApproval: [] as MissionWithProgression[],
      succeededRecent: [] as MissionWithProgression[],
      failedRecent: [] as MissionWithProgression[],
    };

    // Process each mission
    for (const mission of missions) {
      // Fetch tasks for this mission
      const tasks = await container.mission.listTasks(mission.id);

      // Compute progression
      const progression = computeProgression(tasks);

      // Determine if needs attention
      const attention = needsAttention(mission, tasks);

      // Build mission object for UI
      const missionWithProgression = {
        id: mission.id,
        title: mission.title,
        status: mission.status,
        progression,
        attention,
      };

      // Group by status and recency
      switch (mission.status) {
        case "running":
        case "ready":
        case "planning":
          groups.active.push(missionWithProgression);
          break;
        case "blocked":
          groups.blocked.push(missionWithProgression);
          break;
        case "awaiting_approval":
          groups.awaitingApproval.push(missionWithProgression);
          break;
        case "succeeded":
          if (isRecent(mission)) {
            groups.succeededRecent.push(missionWithProgression);
          }
          break;
        case "failed":
          if (isRecent(mission)) {
            groups.failedRecent.push(missionWithProgression);
          }
          break;
        default:
          // Ignore other statuses (draft, cancelled, etc.)
          break;
      }
    }

    return NextResponse.json(groups);
  } catch (error) {
    console.error("Failed to fetch missions:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
