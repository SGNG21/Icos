import { forbidden } from "next/navigation";
import { headers } from "next/headers";

import { requirePermission } from "@/server/auth/guards";
import { getContainer } from "@/server/container";
import { UserAdministration } from "@/components/administration/user-administration";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const container = await getContainer();

  let session;
  try {
    session = await requirePermission(container, await headers(), "users.read");
  } catch {
    forbidden();
  }

  if (!container.humanAdministration) {
    forbidden();
  }

  const [users, agents] = await Promise.all([
    container.humanAdministration.listUsers(),
    container.agents.list(),
  ]);

  return (
    <main className="shell">
      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">ICOS</p>
            <h1>Administration</h1>
          </div>
        </header>
        <UserAdministration initialUsers={users} agents={agents} session={session} />
      </div>
    </main>
  );
}
