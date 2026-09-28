"use client";

import {
  Bell,
  Bot,
  Cpu,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { MOBILE_TABS, NAV_ITEMS, isActive, type NavIcon } from "./nav-items";

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  missions: Workflow,
  workers: Bot,
  providers: Network,
  alerts: Bell,
  autonomy: Cpu,
  selfdev: Sparkles,
  audit: ScrollText,
  system: Server,
  settings: Settings,
  ask: MessageSquare,
};

export function CockpitNav({ p0 }: { p0: number }) {
  const pathname = usePathname();
  const badge = (href: string) =>
    href === "/cockpit/alerts" && p0 > 0 ? (
      <span className="cx-nav__count" aria-label={`${p0} P0 alerts`}>
        {p0}
      </span>
    ) : null;

  return (
    <>
      <nav className="cx-rail__nav" aria-label="Cockpit">
        <ul>
          {NAV_ITEMS.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={active ? "page" : undefined}>
                  <Icon aria-hidden size={17} />
                  <span>{item.label}</span>
                  {badge(item.href)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <nav className="cx-tabbar" aria-label="Cockpit (mobile)">
        {MOBILE_TABS.map((tab) => {
          const Icon = ICONS[tab.icon];
          const active = isActive(pathname, tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={tab.icon === "ask" ? "cx-tabbar__ask" : undefined}
            >
              <Icon aria-hidden size={tab.icon === "ask" ? 24 : 21} />
              <span>{tab.label}</span>
              {badge(tab.href)}
            </Link>
          );
        })}
        <details className="cx-more">
          <summary aria-label="All sections">
            <Menu aria-hidden size={21} />
            <span>More</span>
          </summary>
          <ul>
            {NAV_ITEMS.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  >
                    <Icon aria-hidden size={18} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </details>
      </nav>
    </>
  );
}
