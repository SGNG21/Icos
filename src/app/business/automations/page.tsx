import { AutomationList } from '@/components/features/automation-list';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function AutomationsPage() {
  const automations = [
    { id: 1, name: 'Reporting hebdo', description: 'Envoi automatique des rapports hebdomadaires', status: 'ACTIVE' },
    { id: 2, name: 'Sauvegarde BDD', description: 'Sauvegarde quotidienne de la base de données', status: 'ACTIVE' },
    { id: 3, name: 'Sync contacts', description: 'Synchronisation des contacts entre outils', status: 'INACTIVE' },
  ];

  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">Automatisations</h1>
        <AutomationList title="Toutes les automatisations" automations={automations} />
      </div>
    </div>
  );
}