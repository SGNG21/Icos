import { ClientModuleGrid } from "./client-module-grid";
import { MissionList } from "./mission-list";
import { AutomationList } from "./automation-list";
import Conversation from "./conversation";
import { ClientOverview, Client } from "./client-overview";

export function ClientWorkspace({ client }: { client: Client }) {
  return (
    <div className="space-y-8">
      <ClientOverview client={client} />
      <ClientModuleGrid modules={client.modules} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MissionList title="Missions ICOS" missions={client.missions || []} />
        <AutomationList title="Automatisations" automations={client.automations || []} />
      </div>
      <Conversation />
    </div>
  );
}
