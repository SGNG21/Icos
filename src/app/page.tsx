import { forbidden, redirect } from "next/navigation";
import { headers } from "next/headers";

import { MobileHome } from "@/components/mobile/home";
import { loadMobileHome } from "@/features/mobile/load";
import { getContainer } from "@/server/container";
import { resolveCockpitAccess } from "@/server/auth/cockpit-access";

export const dynamic = "force-dynamic";

/**
 * ICOS Mobile Home. Authorization FIRST (fail closed), then a read-only load of the
 * canonical runtime under the caller's operational scope. Rendering this page starts
 * nothing and mutates nothing.
 */
export default async function Home() {
  const container = await getContainer();
  const access = await resolveCockpitAccess(container, await headers());
  if (access.kind === "redirect") {
    redirect("/login?next=%2F");
  }
  if (access.kind === "forbidden") {
    forbidden();
  }

  const model = await loadMobileHome();
  // The read gate handles the expired/unauthenticated cases itself, so the only condition
  // left here is a FORBIDDEN classification — the same denial as above, which is why it
  // takes the same branch rather than a login redirect that would bounce an already
  // authenticated caller straight back. Unreachable within one request (both checks read
  // the same request-scoped headers through the same cached container); kept so a null
  // model can never be rendered as an empty home.
  if (!model) {
    forbidden();
  }

  return <MobileHome session={access.session} model={model} />;
}
