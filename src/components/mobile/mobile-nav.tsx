"use client";

import { usePathname } from "next/navigation";
import styles from "./mobile-nav.module.css";

/** The five phone tabs. Exported so the route-coverage test can enumerate them. */
export type NavKey = "home" | "missions" | "voice" | "alerts" | "profile";

/**
 * Where each tab actually goes. It used to be derived as `/${item.key}`, which sent
 * Missions, Alerts and Profile to /missions, /alerts and /profile — three routes
 * that have no page, so a real phone got a 404 (and, on any page that did render, a
 * 401 from its protected API fetch). Nothing was wrong with auth; the destinations
 * did not exist. These cockpit routes do, and they sit behind the same session gate
 * as /voice. `nav-targets.test.ts` fails if any entry stops resolving to a page.
 */
export const NAV_HREF: Record<NavKey, string> = {
  home: "/",
  missions: "/cockpit/missions",
  voice: "/voice",
  alerts: "/cockpit/alerts",
  profile: "/cockpit/settings",
};

export function MobileNav({
  active,
  onChange,
}: {
  active: NavKey;
  onChange: (nav: NavKey) => void;
}) {
  const pathname = usePathname();

  const navItems = [
    {
      key: "home" as const,
      label: "Accueil",
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      ),
    },
    {
      key: "missions" as const,
      label: "Missions",
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
        </svg>
      ),
    },
    {
      key: "voice" as const,
      label: "Voix",
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="8" y1="22" x2="16" y2="22" />
        </svg>
      ),
    },
    {
      key: "alerts" as const,
      label: "Alertes",
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
    },
    {
      key: "profile" as const,
      label: "Profil",
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
    },
  ];

  return (
    <nav className={styles.nav} role="navigation" aria-label="Navigation principale">
      {navItems.map((item) => {
        const isActive = active === item.key;
        const href = NAV_HREF[item.key];
        const isCurrentPage =
          pathname === href || (item.key !== "home" && pathname?.startsWith(href));

        return (
          <a
            key={item.key}
            href={href}
            className={`${styles.navItem} ${isActive || isCurrentPage ? styles.active : ""}`}
            onClick={(e) => {
              e.preventDefault();
              onChange(item.key);
              window.location.href = href;
            }}
            aria-current={isActive || isCurrentPage ? "page" : undefined}
            aria-label={item.label}
          >
            <span className={styles.navIcon} aria-hidden="true">
              {item.icon}
            </span>
            <span className={styles.navLabel}>{item.label}</span>
            {isActive && <span className={styles.activeIndicator} aria-hidden="true" />}
          </a>
        );
      })}
    </nav>
  );
}
