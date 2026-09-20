import Link from 'next/link';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function ClientsPage() {
  const clients = [
    { id: 'lds-renov', name: "LDS Rénov'", slug: 'lds-renov' },
    { id: 'editions-du-mecene', name: 'Éditions du Mécène', slug: 'editions-du-mecene' },
  ];

  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">Clients</h1>
        <div className="space-y-4">
          {clients.map(client => (
            <Link
              key={client.id}
              href={`/business/clients/${client.slug}`}
              className="block bg-white rounded-lg border p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">{client.name}</h2>
                  <p className="text-gray-500">Workspace client</p>
                </div>
                <span className="ml-4 inline-flex items-center px-3 py-1 text-xs font-medium bg-gray-100 text-gray-800 rounded-full">
                  Actif
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}