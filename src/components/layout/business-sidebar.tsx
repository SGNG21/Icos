import { LogoutButton } from "@/components/auth/logout-button";

const navigation = [
  { label: "Command Center", href: "/business" },
  { label: "Mon entreprise", href: "/business/company" },
  { label: "Clients", href: "/business/clients" },
  { label: "CRM / Sales", href: "/business/crm" },
  { label: "Marketing", href: "/business/marketing" },
  { label: "Projets", href: "/business/projets" },
  { label: "Missions ICOS", href: "/business/missions" },
  { label: "Automatisations", href: "/business/automations" },
  { label: "Documents / Knowledge", href: "/business/documents" },
  { label: "Finances", href: "/business/finances" },
  { label: "Privacy / RGPD", href: "/business/privacy" },
  { label: "AI Studio", href: "/business/ai-studio" },
  { label: "ICOS Core", href: "/business/icos-core" },
];

export function BusinessSidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">I</span>
        <div>
          <strong>ICOS Business OS</strong>
          <small>Holding IA</small>
        </div>
      </div>

      <nav aria-label="Navigation principale">
        <p className="nav-label">Pilotage</p>
        <ul>
          {navigation.map((item, index) => (
            <li key={item.href}>
              <a href={item.href} className={index === 0 ? "active" : undefined}>
                <span className="nav-glyph" aria-hidden="true" />
                {item.label}
              </a>
            </li>
          ))}
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
