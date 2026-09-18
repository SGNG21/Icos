import { notFound } from "next/navigation";
import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { buildCockpitProjection } from "@/features/cockpit/projection";
import { readFile } from "fs/promises";
import path from "path";

// Types
interface WorkerStatus {
  name: string;
  status: string;
  state: string;
  pid: number | null;
  last_log_activity: string;
  mission_id: string | null;
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readTextFile(filePath);
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";

export default async function ControlRoomPage() {
  // Fetch global status
  let globalData = null;
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request: new Request("http://localhost:3000/api/cockpit"),
      route: "api.cockpit",
      permission: "cockpit.read",
    });
    if (access.ok) {
      const scope = container.operationalAccess
        ? await container.operationalAccess.resolveScope(access.session)
        : { kind: "global" as const };
      const [agents, tasks] = await Promise.all([
        container.agents.listForScope(scope),
        container.tasks.listForScope(scope),
      ]);
      const executions = await container.executionResults.listByTaskIds(tasks.map((t) => t.id));
      const projection = buildCockpitProjection({ tasks, agents, executions });
      globalData = projection;
    }
  } catch (error) {
    console.error("Failed to fetch global status:", error);
  }

  // Fetch workers
  const workerRegistryPath = path.join(process.cwd(), ".icos", "autonomy", "worker-registry.json");
  const workerData = await readJsonFile<{ workers: Record<string, WorkerStatus> }>(
    workerRegistryPath,
  );
  const workers = workerData ? Object.values(workerData.workers) : [];

  // Fetch autonomy board
  const autonomyDir = path.join(process.cwd(), ".icos", "autonomy");
  const autonomyFiles = ["N1_WORKER_AUTONOMY.md", "AUTONOMY_ROADMAP.md", "NEXT_WORK_ORDER.md"];
  const autonomyStates = [];
  for (const file of autonomyFiles) {
    const content = await readTextFile(path.join(autonomyDir, file));
    if (content) {
      autonomyStates.push({ file, preview: content.slice(0, 200) });
    }
  }

  return (
    <main className="p-6 bg-gray-50 min-h-screen">
      <h1 className="text-2xl font-bold mb-6">ICOS Control Room V1</h1>

      {/* A. Global Status */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">A. Global Status</h2>
        {globalData ? (
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded shadow">
              <h3>Active Work</h3>
              <p className="text-2xl">{globalData.activeWork.length}</p>
            </div>
            <div className="bg-white p-4 rounded shadow">
              <h3>Attention Required</h3>
              <p className="text-2xl">{globalData.attentionRequired.length}</p>
            </div>
            <div className="bg-white p-4 rounded shadow">
              <h3>Failed</h3>
              <p className="text-2xl">{globalData.counts.failed}</p>
            </div>
            <div className="bg-white p-4 rounded shadow">
              <h3>Running</h3>
              <p className="text-2xl">{globalData.counts.running}</p>
            </div>
          </div>
        ) : (
          <p className="text-red-500">No data available</p>
        )}
      </section>

      {/* B. Worker Board */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">B. Worker Board</h2>
        {workers.length > 0 ? (
          <table className="min-w-full bg-white rounded shadow overflow-hidden">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-2 text-left">Worker</th>
                <th className="px-4 py-2 text-left">State</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">PID</th>
                <th className="px-4 py-2 text-left">Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w.name} className="border-t">
                  <td className="px-4 py-2">{w.name}</td>
                  <td className="px-4 py-2">{w.state}</td>
                  <td className="px-4 py-2">{w.status}</td>
                  <td className="px-4 py-2">{w.pid ?? "-"}</td>
                  <td className="px-4 py-2">{new Date(w.last_log_activity).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-red-500">No workers found</p>
        )}
      </section>

      {/* C. Autonomy Board */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">C. Autonomy Board N1-N6</h2>
        {autonomyStates.length > 0 ? (
          <div className="space-y-4">
            {autonomyStates.map((s) => (
              <div key={s.file} className="bg-white p-4 rounded shadow">
                <h3 className="font-medium">{s.file}</h3>
                <p className="text-sm text-gray-600 mt-2">{s.preview}...</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-red-500">No autonomy data</p>
        )}
      </section>

      {/* D. System Events Placeholder */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">D. System Events</h2>
        <div className="bg-white p-4 rounded shadow">
          <p className="text-muted-foreground">
            Events from worker logs will appear here. Currently using worker-registry data.
          </p>
          <p className="text-sm mt-2">Workers monitored: {workers.map((w) => w.name).join(", ")}</p>
        </div>
      </section>

      {/* E. Mission View Placeholder */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">E. Mission View</h2>
        <div className="bg-white p-4 rounded shadow">
          <p className="text-muted-foreground">
            Mission data via API /api/missions/{globalData ? "available" : "unavailable"}
          </p>
        </div>
      </section>
    </main>
  );
}
