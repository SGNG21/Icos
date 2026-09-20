import { ClientOverview } from '@/components/features/client-overview';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function CompanyPage() {
  const mockClient = {
    id: 'company',
    name: 'Holding IA',
    autonomyLevel: 'AUTONOMOUS',
    modules: [
      { id: 'website', name: 'Site Web', description: 'Site vitrine', status: 'ON' },
      { id: 'seo', name: 'SEO', description: 'Optimisation référencement', status: 'ON' },
      { id: 'analytics', name: 'Analytics', description: 'Analyse données', status: 'ON' },
      { id: 'maintenance', name: 'Maintenance', description: 'Maintenance technique', status: 'ON' },
    ],
    missions: [
      { id: 1, name: 'Audit SEO', description: 'Audit complet du référencement', status: 'DONE' },
      { id: 2, name: 'Campagne LinkedIn', description: 'Lancement campagne prospection', status: 'IN_PROGRESS' },
    ],
    automations: [
      { id: 1, name: 'Reporting hebdo', description: 'Envoi automatique des rapports', status: 'ACTIVE' },
      { id: 2, name: 'Sauvegarde BDD', description: 'Sauvegarde quotidienne base données', status: 'ACTIVE' },
    ],
    metrics: {
      revenue: 125000,
      leads: 45,
      conversionRate: 0.12,
    },
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">Mon entreprise</h1>
        <ClientOverview client={mockClient} />
      </div>
    </div>
  );
}