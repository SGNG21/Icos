import { forbidden, redirect } from "next/navigation";
import { headers } from "next/headers";

import { CkCockpitApp } from "@/components/cockpit/CkCockpitApp";
import { resolveCockpitAccess } from "@/server/auth/cockpit-access";
import { getContainer } from "@/server/container";

// Le cockpit lit un état mutable en mémoire : rendu dynamique obligatoire, pas
// de pré-rendu statique ni de cache de rendu.
export const dynamic = "force-dynamic";

export default async function Home() {
  const container = await getContainer();
  const access = await resolveCockpitAccess(container, await headers());
  if (access.kind === "redirect") {
    redirect("/login?next=%2F");
  }
  if (access.kind === "forbidden") {
    forbidden();
  }

  return <CkCockpitApp />;
}
