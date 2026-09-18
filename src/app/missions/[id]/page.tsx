"use client";

import { notFound } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Mission, MissionTask } from "@/core/mission/contracts";

export default function MissionDetail({ params }: { params: { id: string } }) {
  const [missionData, setMissionData] = useState<{
    mission: {
      id: string;
      title: string;
      objective: string;
      status: Mission["status"];
      createdAt: string;
      updatedAt: string;
    };
    tasks: MissionTask[];
    progression: {
      total: number;
      succeeded: number;
      running: number;
      blocked: number;
      failed: number;
      percentage: number;
    };
    timeline: Array<{
      id: string;
      timestamp: string;
      type: string;
      actor: string;
      taskId?: string;
      actionId?: string;
      details: unknown;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchMission() {
      try {
        const res = await fetch(`/api/missions/${params.id}`);
        if (!res.ok) {
          if (res.status === 404) {
            notFound();
          }
          throw new Error("Failed to fetch mission");
        }
        const data = await res.json();
        setMissionData(data);
        setLoading(false);
      } catch (err) {
        console.error("Failed to fetch mission detail:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    }

    fetchMission();
  }, [params.id]);

  if (loading) return <p className="text-center py-8">Chargement...</p>;
  if (error) return <p className="text-center text-destructive py-8">{error}</p>;
  if (!missionData) return <p className="text-center py-8">Chargement...</p>;

  const { mission, tasks, progression } = missionData;

  return (
    <div className="space-y-6">
      {/* Mission Header */}
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">{mission.title}</h1>
        <p className="text-muted-foreground mt-1">{mission.objective}</p>
        <div className="mt-4 flex flex-wrap gap-4 items-baseline">
          <span className="px-3 py-1 rounded text-xs font-medium">
            {mission.status === "succeeded"
              ? "bg-green-100 text-green-800"
              : mission.status === "failed"
                ? "bg-red-100 text-red-800"
                : mission.status === "blocked"
                  ? "bg-yellow-100 text-yellow-800"
                  : mission.status === "awaiting_approval"
                    ? "bg-blue-100 text-blue-800"
                    : "bg-gray-100 text-gray-800"}
            {mission.status
              .split("_")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ")}
          </span>
          <span className="text-xs text-muted-foreground">
            {progression.succeeded}/{progression.total} tâches terminées
          </span>
          <span className="text-xs text-muted-foreground">{progression.percentage}%</span>
          <span className="ml-auto text-xs text-muted-foreground">
            Créé le {new Date(mission.createdAt).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Progression Bar */}
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className={`bg-green-600 h-2.5 rounded-full transition-all duration-500 w-[${progression.percentage}%]`}
        ></div>
      </div>

      {/* Tasks List */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Tâches</h2>
        {tasks.length === 0 ? (
          <p className="text-muted-foreground">Aucune tâche définie pour cette mission.</p>
        ) : (
          <ul className="divide-y">
            {tasks.map((task) => (
              <li key={task.id} className="py-4 flex items-start space-x-4">
                <div className="flex-shrink-0 h-3 w-3">
                  {task.status === "succeeded" ? (
                    <span className="bg-green-500" />
                  ) : task.status === "running" ? (
                    <span className="bg-blue-500 animate-pulse" />
                  ) : task.status === "failed" ? (
                    <span className="bg-red-500" />
                  ) : task.status === "queued" ? (
                    <span className="bg-yellow-500" />
                  ) : (
                    <span className="bg-gray-400" />
                  )}
                </div>
                <div className="flex-1 space-y-1">
                  <p className="font-medium">{task.title}</p>
                  {task.description && (
                    <p className="text-sm text-muted-foreground">{task.description}</p>
                  )}
                  <div className="flex items-baseline gap-3 text-xs">
                    <span className="px-2 py-0.5 rounded text-xs">
                      {task.status
                        .split("_")
                        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(" ")}
                    </span>
                    {task.workerKind && (
                      <span className="ml-2 text-muted-foreground">{task.workerKind}</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Approval Section */}
      {mission.status === "awaiting_approval" && (
        <section className="pt-4 border-t">
          <h2 className="text-lg font-semibold mb-3">Approbation requise</h2>
          <p className="mb-4">
            Cette mission attend votre approbation pour passer à l&apos;étape suivante.
          </p>
          <div className="flex gap-3">
            <button
              onClick={async () => {
                try {
                  const res = await fetch(`/api/missions/${mission.id}/approval`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "approve" }),
                  });
                  if (!res.ok) throw new Error("Failed to approve");
                  // Refetch mission data to update status
                  const missionRes = await fetch(`/api/missions/${mission.id}`);
                  const missionData = await missionRes.json();
                  setMissionData(missionData);
                } catch (err) {
                  console.error("Failed to approve mission:", err);
                  alert("Erreur lors de l'approbation");
                }
              }}
              className="flex-1 bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:opacity-50"
            >
              Approuver
            </button>
            <button
              onClick={async () => {
                try {
                  const res = await fetch(`/api/missions/${mission.id}/approval`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "reject" }),
                  });
                  if (!res.ok) throw new Error("Failed to reject");
                  // Refetch mission data to update status
                  const missionRes = await fetch(`/api/missions/${mission.id}`);
                  const missionData = await missionRes.json();
                  setMissionData(missionData);
                } catch (err) {
                  console.error("Failed to reject mission:", err);
                  alert("Erreur lors du rejet");
                }
              }}
              className="flex-1 bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 disabled:opacity-50"
            >
              Rejeter
            </button>
          </div>
        </section>
      )}

      {/* Results Section (if succeeded) */}
      {mission.status === "succeeded" && (
        <section className="pt-4 border-t">
          <h2 className="text-lg font-semibold mb-3">Résultat</h2>
          <p className="text-muted-foreground">
            La mission a été réussie avec {progression.succeeded}/{progression.total} tâches
            terminées.
          </p>
          {/* We don't have artefacts in the current model, so we'll leave a placeholder */}
          <p className="mt-4 text-sm text-muted-foreground">
            Aucune artefact disponible pour cette mission.
          </p>
        </section>
      )}

      {/* Conversation Link */}
      <div className="mt-6 pt-4 border-t">
        <Link
          href={`/conversation?missionId=${mission.id}`}
          className="text-sm text-primary hover:underline"
        >
          Parler au CEO de cette mission
        </Link>
      </div>
    </div>
  );
}
