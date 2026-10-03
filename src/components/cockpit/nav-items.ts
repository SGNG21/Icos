/** Cockpit information architecture. Pure data so it is testable outside React. */
export const NAV_ITEMS = [
  // The way back to the main ICOS interface. The cockpit is a surface OF the product,
  // not a separate one, so leaving it must not require editing the URL.
  { href: "/", label: "Accueil", icon: "home" },
  { href: "/cockpit", label: "Overview", icon: "overview" },
  { href: "/cockpit/executive", label: "Executive", icon: "executive" },
  { href: "/cockpit/missions", label: "Missions", icon: "missions" },
  { href: "/cockpit/pipeline", label: "Pipeline", icon: "pipeline" },
  { href: "/cockpit/workers", label: "Workers", icon: "workers" },
  { href: "/cockpit/providers", label: "Compute", icon: "providers" },
  { href: "/cockpit/alerts", label: "Alerts", icon: "alerts" },
  { href: "/cockpit/autonomy", label: "Autonomy", icon: "autonomy" },
  { href: "/cockpit/self-development", label: "Self-development", icon: "selfdev" },
  { href: "/cockpit/audit", label: "Audit", icon: "audit" },
  { href: "/cockpit/system", label: "System", icon: "system" },
  { href: "/cockpit/settings", label: "Settings", icon: "settings" },
] as const;

/** Mobile bottom bar: thumb-reachable, Ask ICOS in the centre. */
export const MOBILE_TABS = [
  { href: "/cockpit", label: "Home", icon: "overview" },
  { href: "/cockpit/missions", label: "Missions", icon: "missions" },
  { href: "/cockpit/ask", label: "Ask ICOS", icon: "ask" },
  { href: "/cockpit/alerts", label: "Alerts", icon: "alerts" },
] as const;
// Fifth slot is the "More" sheet (all sections); Workers/Autonomy are home tiles.

export type NavIcon = (typeof NAV_ITEMS)[number]["icon"] | "ask";

export function isActive(pathname: string, href: string): boolean {
  // "/" is a prefix of every route, so it only ever matches exactly — as does "/cockpit",
  // which would otherwise light up for all of its own children.
  if (href === "/") return pathname === "/";
  return href === "/cockpit"
    ? pathname === "/cockpit"
    : pathname === href || pathname.startsWith(`${href}/`);
}
