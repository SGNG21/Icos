"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";


export function Navbar() {
  const pathname = usePathname();

  const navItems = [
    { label: "Command Center", href: "/" },
    { label: "Mon entreprise", href: "/entreprise" },
    { label: "Clients", href: "/clients" },
    { label: "CRM / Sales", href: "/crm" },
    { label: "Marketing", href: "/marketing" },
    { label: "Projets", href: "/projets" },
    { label: "Missions ICOS", href: "/missions" },
    { label: "Automatisations", href: "/automatisations" },
    { label: "Documents / Knowledge", href: "/documents" },
    { label: "Finances", href: "/finances" },
    { label: "AI Studio", href: "/ai-studio" },
    { label: "ICOS Core", href: "/core" },
  ];

  return (
    <nav className="border-b bg-white/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex-shrink-0 flex items-center">
            <Menu className="h-6 w-6 text-gray-500" onClick={() => {/* toggle sidebar */}} />
            <span className="ml-3 text-xl font-bold">ICOS Business OS</span>
          </div>
          <div className="hidden md:flex md:items-center md:space-x-8">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  "rounded-md px-3 py-2 text-sm font-medium",
                  pathname === item.href ? "bg-primary text-white" : "text-gray-500 hover:bg-gray-100",
                ].join(" ")}
                aria-current={pathname === item.href ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
