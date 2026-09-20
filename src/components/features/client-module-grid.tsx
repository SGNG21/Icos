import { ClientModule } from "./client-overview";

export function ClientModuleGrid({ modules }: { modules: ClientModule[] }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Modules activables</h2>
      <div className="gap-3">
        {modules.map((module) => (
          <div key={module.id} className="flex items-center justify-between px-4 py-3 bg-white rounded-lg border">
            <div className="flex items-center">
              <div className="w-8 h-8 flex items-center justify-center bg-gray-100 rounded">
                {module.name.substring(0, 1).toUpperCase()}
              </div>
              <div className="ml-3">
                <p className="font-medium">{module.name}</p>
                <p className="text-sm text-gray-500">{module.description}</p>
              </div>
            </div>
            <div>
              <span className={`px-2 py-1 text-xs rounded-full ${module.status === 'AUTOMATED' ? 'bg-green-100 text-green-800' : module.status === 'ASSISTED' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}`}>
                {module.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
