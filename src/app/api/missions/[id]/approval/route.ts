import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { readJson } from "@/server/http/respond";
import { type NextRequest, NextResponse } from "next/server";
import type { Mission } from "@/core/mission/contracts";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read, parsed or modified before the
    // ICOS session, the `approvals.decide` permission and the same-origin check pass.
    const access = await protectRoute({
      container,
      request,
      route: "api.missions.approval",
      permission: "approvals.decide",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const { id } = await context.params;
    const body = await readJson(request);
    if (!body.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const action = (body.value as { action?: unknown } | null)?.action;

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { error: "Invalid action. Must be 'approve' or 'reject'" },
        { status: 400 },
      );
    }

    // Fetch current mission to validate status
    const mission = await container.mission.findById(id);
    if (!mission) {
      return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    }

    if (mission.status !== "awaiting_approval") {
      return NextResponse.json({ error: "Mission is not awaiting approval" }, { status: 400 });
    }

    let newStatus: Mission["status"];
    if (action === "approve") {
      // Approve: set to running (assuming there are tasks to run)
      newStatus = "running";
    } else {
      // Reject: set to cancelled
      newStatus = "cancelled";
    }

    await container.mission.updateMissionStatus(id, newStatus);

    // Refetch mission to return updated data
    const updatedMission = await container.mission.findById(id);
    if (!updatedMission) {
      // This should not happen
      return NextResponse.json({ error: "Mission not found after update" }, { status: 500 });
    }

    return NextResponse.json({
      mission: {
        id: updatedMission.id,
        title: updatedMission.title,
        objective: updatedMission.objective,
        status: updatedMission.status,
        createdAt: updatedMission.createdAt,
        updatedAt: updatedMission.updatedAt,
      },
    });
  } catch (error) {
    console.error("Failed to update mission approval:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
