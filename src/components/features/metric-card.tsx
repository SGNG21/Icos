export function MetricCard({ 
  title, 
  value, 
  change, 
  trend 
}: { 
  title: string; 
  value: string; 
  change: string; 
  trend: 'up' | 'down' | 'neutral' 
}) {
  const trendClasses = {
    up: 'text-green-500',
    down: 'text-red-500',
    neutral: 'text-gray-500',
  };

  return (
    <div className="bg-white rounded-lg border p-6">
      <h3 className="text-lg font-medium text-gray-900">{title}</h3>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {change && (
        <p className="mt-2 text-sm flex items-center">
          <span className={`${trendClasses[trend]} mr-2`}>
            {trend === 'up' ? '▲' : trend === 'down' ? '▼' : ''}
          </span>
          {change}
        </p>
      )}
    </div>
  );
}
