import { MissionList } from "./mission-list";
import { AutomationList } from "./automation-list";
import IcosProposalList from "./icos-proposal-list";
import Conversation from "./conversation";

export default function CommandCenter() {
  // Mock data for demonstration
  const mockClient = {
    id: "editions-du-mecene",
    name: "Éditions du Mécène",
    modules: [
      { id: "website", name: "Website", description: "Gestion du site web", status: "AUTOMATED" },
      { id: "seo", name: "SEO", description: "Optimisation pour les moteurs de recherche", status: "ASSISTED" },
      { id: "linkedin", name: "LinkedIn", description: "Présence et contenu sur LinkedIn", status: "ASSISTED" },
      { id: "email", name: "Email", description: "Campagnes email et newsletters", status: "OFF" },
    ],
    autonomyLevel: "ASSISTED",
    missions: [
      { id: 1, name: "Recherche de prospects", description: "Identifier de nouveaux clients B2B", status: "planning" },
      { id: 2, name: "Qualification", description: "Qualifier les prospects identifiés", status: "planning" },
      { id: 3, name: "Génération de messages", description: "Créer des messages personnalisés pour chaque prospect", status: "planning" },
      { id: 4, name: "Review", description: "Revoir et approuver les messages avant envoi", status: "planning" },
      { id: 5, name: "Relances", description: "Envoyer des relances aux prospects sans réponse", status: "planning" },
    ],
    automations: [
      { id: 1, name: "Publication LinkedIn", description: "Publication automatique d'articles sur LinkedIn", status: "AUTOMATED" },
      { id: 2, name: "Email de suivi", description: "Envoi automatique d'emails de suivi après un rendez-vous", status: "ASSISTED" },
    ],
    metrics: {
      revenue: 45000,
      leads: 120,
      conversionRate: 0.035,
    },
  };

  return (
    <div className="space-y-8">
      <div className="bg-white rounded-lg border p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Command Center Global</h2>
        <div className="mb-6">
          <p className="eyebrow">Que veux-tu accomplir ?</p>
          <input type="text" placeholder="Ex: Augmenter mes ventes de 20% ce trimestre" className="w-full border rounded px-3 py-2" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Résumé du jour</h3>
          </div>
          <div className="space-y-4">
            <div className="flex items-center">
              <div className="w-8 h-8 flex items-center justify-center bg-blue-100 rounded">
                📅
              </div>
              <div className="flex-1">
                <p className="text-sm text-gray-500">Date du jour</p>
                <p className="text-base font-medium">Lundi 20 septembre 2026</p>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Alertes</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center">
              <div className="w-8 h-8 flex items-center justify-center bg-red-100 rounded">
                ⚠️
              </div>
              <div className="flex-1">
                <p className="text-sm text-gray-500">Priorité haute</p>
                <p className="text-base font-medium">Réunion importante dans 1 heure</p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Tâches prioritaires</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center p-3 bg-gray-50 rounded">
              <div className="w-8 h-8 flex items-center justify-center bg-blue-500 rounded text-white">
                1
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Préparer la présentation client</p>
                <p className="text-xs text-gray-500">Échéance : Aujourd&apos;hui 16:00</p>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Clients nécessitant attention</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center p-3 bg-gray-50 rounded">
              <div className="w-8 h-8 flex items-center justify-center bg-orange-500 rounded text-white">
                !
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Client Alpha</p>
                <p className="text-xs text-gray-500">Dernière contact : il y a 3 jours</p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Chiffre d&apos;affaires</h3>
          </div>
          <div className="space-y-4">
            <div className="text-right">
              <p className="text-sm text-gray-500">Ce mois</p>
              <p className="text-2xl font-bold">{mockClient.metrics.revenue.toLocaleString()} €</p>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-lg border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Pipeline commercial</h3>
          </div>
          <div className="space-y-4">
            <div className="text-right">
              <p className="text-sm text-gray-500">Valeur totale</p>
              <p className="text-2xl font-bold">120 000 €</p>
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MissionList title="Missions ICOS" missions={mockClient.missions} />
        <AutomationList title="Automatisations" automations={mockClient.automations} />
      </div>

      <div className="bg-white rounded-lg border p-6">
        <IcosProposalList />
      </div>

      <div className="bg-white rounded-lg border p-6">
        <Conversation />
      </div>
    </div>
  );
}
