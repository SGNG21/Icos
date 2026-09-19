import { hasPermission } from "@/core/identity";
import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { type NextRequest, NextResponse } from "next/server";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { AuditEntry } from "@/core/contracts";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed); the proxy is never the security barrier.
    const access = await protectRoute({
      container,
      request,
      route: "api.missions.read",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;

    const missionService = container.missionService;
    if (!missionService) {
      return NextResponse.json({ error: "Mission service not available" }, { status: 500 });
    }
    const params = await context.params;
    const mission = await missionService.getMission(params.id);

    if (!mission) {
      return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    }

    // Fetch tasks for this mission
    const tasks = await missionService.getTasks(mission.id);

    // Compute progression
    const total = tasks.length;
    const succeeded = tasks.filter((t) => t.status === "succeeded").length;
    const running = tasks.filter((t) => t.status === "running").length;
    // 'blocked' is a mission-level status, not a task-level status
    const failed = tasks.filter((t) => t.status === "failed").length;
    const percentage = total > 0 ? Math.round((succeeded / total) * 100) : 0;

    // Fetch audit entries for tasks in this mission
    const taskIds = tasks.map((t) => t.id);
    // Audit details need audit.read.full (same gate as GET /api/audit); viewers keep the
    // mission view without the audit timeline.
    const auditEntries = hasPermission(access.session.roles, "audit.read.full")
      ? await container.audit.list()
      : [];
    // Filter entries related to mission tasks
    const missionAudit = auditEntries.filter(
      (entry) => entry.taskId && taskIds.includes(entry.taskId),
    );
    // Sort by occurredAt ascending
    missionAudit.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    // Build timeline items
    const timeline = missionAudit.map((entry) => ({
      id: entry.id,
      timestamp: entry.occurredAt,
      type: entry.eventType,
      actor: entry.actor,
      taskId: entry.taskId ?? undefined,
      actionId: entry.actionId ?? undefined,
      details: entry.details,
    }));

    return NextResponse.json({
      mission: {
        id: mission.id,
        title: mission.title,
        objective: mission.objective,
        status: mission.status,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
      },
      tasks,
      progression: { total, succeeded, running, failed, percentage },
      timeline,
    });
  } catch (error) {
    console.error("Failed to fetch mission:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
