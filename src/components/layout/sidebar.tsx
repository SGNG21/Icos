import { LogoutButton } from "@/components/auth/logout-button";

const navigation = [
  { label: "Vue d’ensemble", anchor: "overview" },
  { label: "Conversation", anchor: "conversation" },
  { label: "Agents", anchor: "agents" },
  { label: "Tâches", anchor: "tasks" },
  { label: "Approbations", anchor: "approvals" },
];

export function Sidebar() {
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
            <li key={item.anchor}>
              <a className={index === 0 ? "active" : undefined} href={`#${item.anchor}`}>
                <span className="nav-glyph" aria-hidden="true" />
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <div className="mini-status">
          <span className="status-dot" />
          <div>
            <strong>Environnement local</strong>
            <small>Exécution verrouillée</small>
          </div>
        </div>
        <LogoutButton />
      </div>
    </aside>
  );
}
