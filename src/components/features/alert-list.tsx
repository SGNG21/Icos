export function AlertList() {
  const alerts = [
    { id: 1, type: 'warning', message: 'Le client Éditions du Mécène nécessite une revue de stratégie.' },
    { id: 2, type: 'error', message: 'Échec de la publication LinkedIn du 15 septembre.' },
    { id: 3, type: 'info', message: 'Nouvelle proposition ICOS disponible : Optimisation du funnel de vente.' },
  ];

  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <div key={alert.id} className={`flex items-start space-x-3 p-4 rounded-lg border ${getAlertTypeClass(alert.type)}`}>
          <div className="flex-shrink-0">
            {alert.type === 'warning' && '⚠️'}
            {alert.type === 'error' && '❌'}
            {alert.type === 'info' && 'ℹ️'}
          </div>
          <div>
            <p className="font-medium text-gray-900">{alert.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function getAlertTypeClass(type: string) {
  switch (type) {
    case 'warning': return 'bg-yellow-50 border-yellow-200';
    case 'error': return 'bg-red-50 border-red-200';
    case 'info': return 'bg-blue-50 border-blue-200';
    default: return 'bg-gray-50 border-gray-200';
  }
}
