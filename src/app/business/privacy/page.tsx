import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">Privacy / RGPD</h1>
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-xl font-bold mb-4">Données personnelles</h2>
          <p className="mb-4">Aucune donnée personnelle collectée pour le moment.</p>
          
          <h2 className="text-xl font-bold mb-4">Finalités</h2>
          <p className="mb-4">Gestion de la relation client, suivi des missions, automatisations.</p>
          
          <h2 className="text-xl font-bold mb-4">Bases légales</h2>
          <p className="mb-4">Consentement, exécution du contrat, intérêt légitime.</p>
          
          <h2 className="text-xl font-bold mb-4">Conservation</h2>
          <p className="mb-4">Les données sont conservées pendant la durée de la relation contractuelle.</p>
          
          <h2 className="text-xl font-bold mb-4">Droits des personnes</h2>
          <p className="mb-4">Droit d&apos;accès, de rectification, d&apos;effacement, de portabilité, d&apos;opposition.</p>
          
          <h2 className="text-xl font-bold mb-4">Export / Suppression</h2>
          <p className="mb-4">Demande via le formulaire de contact ou à privacy@holding-ia.example.</p>
          
          <h2 className="text-xl font-bold mb-4">Sous-traitants</h2>
          <p className="mb-4">Aucun sous-traitant actuellement.</p>
          
          <h2 className="text-xl font-bold mb-4">Journal d&apos;accès</h2>
          <p className="mb-4">Aucun accès enregistré pour le moment.</p>
        </div>
      </div>
    </div>
  );
}