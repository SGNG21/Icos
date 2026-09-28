import { LogoutButton } from "@/components/auth/logout-button";

const navigation = [
  { label: "Vue d’ensemble", anchor: "overview" },
  { label: "Conversation", anchor: "conversation" },
  { label: "Agents", anchor: "agents" },
  { label: "Tâches", anchor: "tasks" },
  { label: "Approbations", anchor: "approvals" },
  { label: "Control Room", href: "/control-room" },
];

export function Sidebar({ showAdministration = false }: { showAdministration?: boolean }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">I</span>
        <div>
          <strong>ICOS</strong>
          <small>Holding IA</small>
        </div>
      </div>

      <nav aria-label="Navigation principale">
        <p className="nav-label">Pilotage</p>
        <ul>
          {navigation.map((item, index) => (
            <li key={item.anchor ?? item.href}>
              {item.href ? (
                <a className={index === 0 ? "active" : undefined} href={item.href}>
                  <span className="nav-glyph" aria-hidden="true" />
                  {item.label}
                </a>
              ) : (
                <a className={index === 0 ? "active" : undefined} href={`#${item.anchor}`}>
                  <span className="nav-glyph" aria-hidden="true" />
                  {item.label}
                </a>
              )}
            </li>
          ))}
          {showAdministration && (
            <li>
              <a href="/admin/users">
                <span className="nav-glyph" aria-hidden="true" />
                Administration
              </a>
            </li>
          )}
        </ul>
      </nav>

      <div className="sidebar-footer">
        {/* No hardcoded state claim here: live system state lives in the Control Center. */}
        <a className="mini-status" href="/cockpit">
          <div>
            <strong>Control Center</strong>
            <small>État système réel →</small>
          </div>
        </a>
        <LogoutButton />
      </div>
    </aside>
  );
}
