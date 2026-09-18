import type { SystemStatus } from "@/server/system/system-status";

const stateLabel: Record<string, string> = {
  connected: "connecté",
  available: "disponible",
  not_configured: "non configuré",
  unavailable: "indisponible",
};

/**
 * Bandeau d'état système fondé sur des faits observables.
 *
 * Une intégration OPTIONNELLE non configurée n'est jamais présentée comme une
 * alerte : elle apparaît en second plan. Seule l'indisponibilité d'un composant
 * essentiel dégrade l'état général.
 */
export function SystemStatusBar({ status }: { status: SystemStatus }) {
  const degraded = status.overall === "degraded";

  return (
    <div className={`ck-sysbar ${degraded ? "ck-sysbar--degraded" : ""}`.trim()} role="status">
      <div className="ck-sysbar__headline">
        <span className={`ck-dot ${degraded ? "ck-dot--warn" : "ck-dot--ok"}`} />
        <strong>{degraded ? "Système dégradé" : "Système opérationnel"}</strong>
      </div>

      <ul className="ck-sysbar__items">
        {status.essential.map((item) => (
          <li key={item.key} className={item.state === "connected" ? "" : "is-down"}>
            {item.label} : {stateLabel[item.state] ?? item.state}
          </li>
        ))}
      </ul>

      <details className="ck-sysbar__optional">
        <summary>Intégrations optionnelles</summary>
        <ul>
          {status.optional.map((item) => (
            <li key={item.key}>
              {item.label} : {stateLabel[item.state] ?? item.state}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
