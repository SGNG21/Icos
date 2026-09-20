import type { ReactNode } from "react";

export interface Automation {
  id: string | number;
  name: string;
  description: string;
  status: string;
  icon?: ReactNode;
}

export function AutomationList({ title, automations }: { title: string; automations: Automation[] }) {
  return (
    <section className="bg-white rounded-lg border p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">{title}</h3>
      {automations.length === 0 ? (
        <p className="text-gray-500">Aucune automatisation pour le moment.</p>
      ) : (
        <ul className="space-y-3">
          {automations.map((auto) => (
            <li key={auto.id} className="flex items-center p-3 bg-gray-50 rounded">
              {auto.icon && (
                <div className="w-8 h-8 flex items-center justify-center bg-blue-100 rounded">
                  {auto.icon}
                </div>
              )}
              <div className="flex-1">
                <p className="text-sm font-medium">{auto.name}</p>
                <p className="text-xs text-gray-500">{auto.description}</p>
                <p className="text-xs text-gray-500">Statut : {auto.status}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
