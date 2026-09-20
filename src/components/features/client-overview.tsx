import type { ReactNode } from "react";

export interface ClientModule {
  id: string;
  name: string;
  description: string;
  status: string;
}

export interface Mission {
  id: string | number;
  name: string;
  description: string;
  status: string;
  icon?: ReactNode;
}

export interface Automation {
  id: string | number;
  name: string;
  description: string;
  status: string;
  icon?: ReactNode;
}

export interface Client {
  id: string;
  name: string;
  autonomyLevel: string;
  modules: ClientModule[];
  missions?: Mission[];
  automations?: Automation[];
  metrics?: {
    revenue: number;
    leads: number;
    conversionRate: number;
  };
}

export function ClientOverview({ client }: { client: Client }) {
  return (
    <div className="bg-white rounded-lg border p-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4">{client.name}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-gray-500">
        <div>
          <span className="font-medium">Autonomie :</span> <span>{client.autonomyLevel}</span>
        </div>
        <div>
          <span className="font-medium">Modules actifs :</span> <span>{client.modules.filter((m) => m.status !== 'OFF').length}/{client.modules.length}</span>
        </div>
        <div>
          <span className="font-medium">Dernière activité :</span> <span>Aujourd&apos;hui</span>
        </div>
      </div>
    </div>
  );
}
