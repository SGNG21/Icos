import { ClientWorkspace } from '@/components/features/client-workspace';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function MecenePage() {
  const client = {
    id: 'editions-du-mecene',
    name: 'Éditions du Mécène',
    autonomyLevel: 'AUTONOMOUS',
    modules: [
      { id: 'website', name: 'Site Web', description: 'Site vitrine', status: 'ON' },
      { id: 'seo', name: 'SEO', description: 'Optimisation référencement', status: 'ON' },
      { id: 'linkedin', name: 'LinkedIn', description: 'Prospection LinkedIn', status: 'ON' },
      { id: 'prospecting', name: 'Prospection', description: 'Outils de prospection', status: 'ON' },
      { id: 'email', name: 'Email', description: 'Campagnes email (Brevo)', status: 'ON' },
      { id: 'facebook', name: 'Facebook', description: 'Publicités Facebook', status: 'ON' },
      { id: 'crm', name: 'CRM', description: 'Gestion relation client', status: 'ON' },
      { id: 'analytics', name: 'Analytics', description: 'Analyse données', status: 'ON' },
      { id: 'funnel', name: 'Funnel', description: 'Entonnoir de conversion', status: 'ON' },
      { id: 'missions', name: 'Missions ICOS', description: 'Missions ICOS', status: 'ON' },
      { id: 'automatisations', name: 'Automatisations', description: 'Automatisations ICOS', status: 'ON' },
    ],
    missions: [
      { id: 1, name: 'Lancement livre', description: 'Lancement nouveau titre', status: 'DONE' },
      { id: 2, name: 'Campagne LinkedIn', description: 'Campagne prospection auteurs', status: 'IN_PROGRESS' },
      { id: 3, name: 'Newsletter mensuelle', description: 'Envoi newsletter abonnés', status: 'TODO' },
    ],
    automations: [
      { id: 1, name: 'Sync Brevo', description: 'Synchronisation contacts Brevo', status: 'ACTIVE' },
      { id: 2, name: 'Reporting ventes', description: 'Rapport mensuel ventes', status: 'ACTIVE' },
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