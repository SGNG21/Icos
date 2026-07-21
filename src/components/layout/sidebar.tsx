const navigation = ["Vue d’ensemble", "Conversation", "Agents", "Tâches", "Approbations"];

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
            <li key={item}>
              <a className={index === 0 ? "active" : undefined} href={`#${item.toLowerCase()}`}>
                <span className="nav-glyph" aria-hidden="true" />
                {item}
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
      </div>
    </aside>
  );
}
