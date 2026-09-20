import { ClientWorkspace } from '@/components/features/client-workspace';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function LdsRenovPage() {
  const client = {
    id: 'lds-renov',
    name: "LDS Rénov'",
    autonomyLevel: 'AUTOMATED',
    modules: [
      { id: 'website', name: 'Site Web', description: 'Site vitrine', status: 'ON' },
      { id: 'seo', name: 'SEO', description: 'Optimisation référencement', status: 'ON' },
      { id: 'maintenance', name: 'Maintenance', description: 'Maintenance technique', status: 'ON' },
      { id: 'analytics', name: 'Analytics', description: 'Analyse données', status: 'ON' },
      { id: 'linkedin', name: 'LinkedIn', description: 'Prospection LinkedIn', status: 'OFF' },
      { id: 'email', name: 'Email', description: 'Campagnes email', status: 'OFF' },
      { id: 'facebook', name: 'Facebook', description: 'Publicités Facebook', status: 'OFF' },
      { id: 'ads', name: 'Ads', description: 'Campagnes publicitaires', status: 'OFF' },
      { id: 'prospecting', name: 'Prospection', description: 'Outils de prospection', status: 'OFF' },
      { id: 'crm-advanced', name: 'CRM Avancé', description: 'Gestion client avancée', status: 'OFF' },
    ],
    missions: [
      { id: 1, name: 'Refonte site', description: 'Refonte complète du site web', status: 'DONE' },
      { id: 2, name: 'Audit SEO', description: 'Audit et amélioration SEO', status: 'IN_PROGRESS' },
      { id: 3, name: 'Campagne LinkedIn', description: 'Lancement campagne prospection LinkedIn', status: 'TODO' },
    ],
    automations: [
      { id: 1, name: 'Sauvegarde hebdo', description: 'Sauvegarde hebdomadaire du site', status: 'ACTIVE' },
      { id: 2, name: 'Reporting mensuel', description: 'Rapport mensuel des performances', status: 'ACTIVE' },
    ],
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">{client.name}</h1>
        <ClientWorkspace client={client} />
      </div>
    </div>
  );
}