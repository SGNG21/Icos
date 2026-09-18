"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MissionWithProgression } from "@/app/api/missions/route";

export default function MissionGroups() {
  const [data, setData] = useState<{
    active: MissionWithProgression[];
    blocked: MissionWithProgression[];
    awaitingApproval: MissionWithProgression[];
    succeededRecent: MissionWithProgression[];
    failedRecent: MissionWithProgression[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/missions")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((data) => {
        setData(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch mission groups:", err);
        setLoading(false);
      });
  }, []);

  if (loading) return <p className="text-center py-4">Chargement...</p>;
  if (!data) return <p className="text-center py-4">Erreur de chargement</p>;

  return (
    <section className="mt-6 space-y-4">
      <h2 className="text-left font-semibold text-xs tracking-wider uppercase">Missions</h2>
      {/* Active Missions */}
      {data.active.length > 0 && (
        <>
          <h3 className="text-left font-medium text-sm">Actives</h3>
          <ul className="space-y-2">
            {data.active.map((mission) => (
              <li key={mission.id} className="flex justify-between items-start">
                <Link href={`/missions/${mission.id}`} className="flex-1 min-w-0 break-all">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      {/* Status indicator */}
                      <span
                        className={`h-2 w-2 rounded-full ${mission.status === "running" ? "bg-green-500" : mission.status === "ready" ? "bg-yellow-500" : "bg-gray-500"}`}
                      />
                    </div>
                    <div className="ml-2 flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{mission.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {mission.progression.succeeded}/{mission.progression.total} tâches
                      </p>
                    </div>
                  </div>
                </Link>
                {mission.attention && <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Blocked Missions */}
      {data.blocked.length > 0 && (
        <>
          <h3 className="text-left font-medium text-sm">Bloquées</h3>
          <ul className="space-y-2">
            {data.blocked.map((mission) => (
              <li key={mission.id} className="flex justify-between items-start">
                <Link href={`/missions/${mission.id}`} className="flex-1 min-w-0 break-all">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                    </div>
                    <div className="ml-2 flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{mission.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {mission.progression.succeeded}/{mission.progression.total} tâches
                      </p>
                    </div>
                  </div>
                </Link>
                {mission.attention && <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Awaiting Approval */}
      {data.awaitingApproval.length > 0 && (
        <>
          <h3 className="text-left font-medium text-sm">En attente d&apos;approbation</h3>
          <ul className="space-y-2">
            {data.awaitingApproval.map((mission) => (
              <li key={mission.id} className="flex justify-between items-start">
                <Link href={`/missions/${mission.id}`} className="flex-1 min-w-0 break-all">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <span className="h-2 w-2 rounded-full bg-yellow-500" />
                    </div>
                    <div className="ml-2 flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{mission.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {mission.progression.succeeded}/{mission.progression.total} tâches
                      </p>
                    </div>
                  </div>
                </Link>
                {mission.attention && <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Succeeded Recent */}
      {data.succeededRecent.length > 0 && (
        <>
          <h3 className="text-left font-medium text-sm">Réussies (récentes)</h3>
          <ul className="space-y-2">
            {data.succeededRecent.map((mission) => (
              <li key={mission.id} className="flex justify-between items-start">
                <Link href={`/missions/${mission.id}`} className="flex-1 min-w-0 break-all">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <span className="h-2 w-2 rounded-full bg-green-500" />
                    </div>
                    <div className="ml-2 flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{mission.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {mission.progression.succeeded}/{mission.progression.total} tâches
                      </p>
                    </div>
                  </div>
                </Link>
                {mission.attention && <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Failed Recent */}
      {data.failedRecent.length > 0 && (
        <>
          <h3 className="text-left font-medium text-sm">Échouées (récentes)</h3>
          <ul className="space-y-2">
            {data.failedRecent.map((mission) => (
              <li key={mission.id} className="flex justify-between items-start">
                <Link href={`/missions/${mission.id}`} className="flex-1 min-w-0 break-all">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                    </div>
                    <div className="ml-2 flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{mission.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {mission.progression.succeeded}/{mission.progression.total} tâches
                      </p>
                    </div>
                  </div>
                </Link>
                {mission.attention && <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
