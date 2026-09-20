import type { ReactNode } from "react";

export interface Mission {
  id: string | number;
  name: string;
  description: string;
  status: string;
  icon?: ReactNode;
}

export function MissionList({ title, missions }: { title: string; missions: Mission[] }) {
  return (
    <section className="bg-white rounded-lg border p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">{title}</h3>
      {missions.length === 0 ? (
        <p className="text-gray-500">Aucune mission pour le moment.</p>
      ) : (
        <ul className="space-y-3">
          {missions.map((mission) => (
            <li key={mission.id} className="flex items-center p-3 bg-gray-50 rounded">
              {mission.icon && (
                <div className="w-8 h-8 flex items-center justify-center bg-blue-100 rounded">
                  {mission.icon}
                </div>
              )}
              <div className="flex-1">
                <p className="text-sm font-medium">{mission.name}</p>
                <p className="text-xs text-gray-500">{mission.description}</p>
                <p className="text-xs text-gray-500">Statut : {mission.status}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
