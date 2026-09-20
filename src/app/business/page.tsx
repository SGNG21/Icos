import CommandCenter from '@/components/features/command-center';
import { BusinessSidebar } from '@/components/layout/business-sidebar';

export default function BusinessPage() {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <BusinessSidebar />
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-4">Command Center</h1>
        <CommandCenter />
      </div>
    </div>
  );
}