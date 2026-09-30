import { forbidden, redirect } from "next/navigation";
import { headers } from "next/headers";

import { MobileHome } from "@/components/mobile/home";
import { getContainer } from "@/server/container";
import { resolveCockpitAccess } from "@/server/auth/cockpit-access";

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

  const scope = container.operationalAccess
    ? await container.operationalAccess.resolveScope(access.session)
    : null;

  return <MobileHome session={access.session} scope={scope} />;
}