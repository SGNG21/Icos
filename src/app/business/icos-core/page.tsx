import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function IcosCorePage() {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">ICOS Core</h1>
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-xl font-bold mb-4">Santé ICOS</h2>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="text-center">
              <p className="text-gray-500">Workers</p>
              <p className="text-2xl font-bold">3/5 actifs</p>
            </div>
            <div className="text-center">
              <p className="text-gray-500">Modèles</p>
              <p className="text-2xl font-bold">2 chargés</p>
            </div>
            <div className="text-center">
              <p className="text-gray-500">Providers</p>
              <p className="text-2xl font-bold">4 connectés</p>
            </div>
            <div className="text-center">
              <p className="text-gray-500">OmniRoute</p>
              <p className="text-2xl font-bold">Opérationnel</p>
            </div>
          </div>
          
          <h2 className="text-xl font-bold mb-4">Mémoire & Scheduler</h2>
          <p className="mb-4">Mémoire durable : OK</p>
          <p className="mb-4">Scheduler : 2 tâches en file d&apos;attente</p>
          
          <h2 className="text-xl font-bold mb-4">Sécurité & Guardian</h2>
          <p className="mb-4">Aucune alerte de sécurité</p>
          <p className="mb-4">Guardian : actifs</p>
          
          <h2 className="text-xl font-bold mb-4">Performance</h2>
          <p className="mb-4">Latence moyenne : 120ms</p>
          <p className="mb-4">Tokens aujourd&apos;hui : 15 420</p>
          
          <div className="mt-6">
            <h2 className="text-xl font-bold mb-4">Accès au cockpit technique</h2>
            <p className="mb-4">
                        Le cockpit technique complet est disponible à l&apos;adresse suivante :
                      </p>
            <a
              href="/control-room"
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <span className="mr-2">→</span> Ouvrir /control-room
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}