import type { Metadata } from "next";
import type { ReactNode } from "react";

// Restored (defect D-02): dropped in 5cbb42f, leaving legacy pages unstyled.
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "ICOS — Cockpit opérationnel",
  description: "Cockpit central de pilotage de l'écosystème Holding IA.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
