import { MissionList } from '@/components/features/mission-list';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function MissionsPage() {
  const missions = [
    { id: 1, name: 'Audit SEO LDS', description: 'Audit référencement pour LDS Rénov', status: 'IN_PROGRESS' },
    { id: 2, name: 'Lancement livre Mécène', description: 'Lancement nouveau titre', status: 'DONE' },
    { id: 3, name: 'Campagne LinkedIn', description: 'Campagne prospection LinkedIn', status: 'TODO' },
  ];

  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">Missions ICOS</h1>
        <MissionList title="Toutes les missions" missions={missions} />
      </div>
    </div>
  );
}