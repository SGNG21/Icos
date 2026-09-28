import { forbidden, redirect } from "next/navigation";
import { headers } from "next/headers";

import { AgentGrid } from "@/components/features/agent-grid";
import { ApprovalsPanel } from "@/components/features/approvals-panel";
import { CommandComposer } from "@/components/features/command-composer";
import { RecentTasks } from "@/components/features/recent-tasks";
import { Sidebar } from "@/components/layout/sidebar";
import { resolveCockpitAccess } from "@/server/auth/cockpit-access";
import { loadSnapshot } from "@/features/cockpit/load";
import { getContainer } from "@/server/container";

// Le cockpit lit un état mutable en mémoire : rendu dynamique obligatoire, pas
// de pré-rendu statique ni de cache de rendu.
export const dynamic = "force-dynamic";

const healthLabel = {
  healthy: "saine",
  degraded: "dégradée",
  critical: "critique",
  unknown: "inconnue",
} as const;

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

  const [agents, tasks, pendingActions] = await Promise.all([
    scope ? container.agents.listForScope(scope) : container.agents.list(),
    scope ? container.tasks.listForScope(scope) : container.tasks.list(),
    scope
      ? container.actions.listForScope(scope, { approvalStatus: "pending" })
      : container.actions.list({ approvalStatus: "pending" }),
  ]);

  const health = (await loadSnapshot())?.health;
  const showAdministration =
    container.humanAdministration !== undefined &&
    access.session.roles.some((r) => r === "admin" || r === "owner");

  return (
    <main className="shell">
      <Sidebar showAdministration={showAdministration} />
      <section className="workspace" id="overview">
        <header className="topbar">
          <div>
            <p className="eyebrow">Cockpit opérationnel</p>
            <h1>ICOS</h1>
          </div>
          {/* Derived from canonical state, never hardcoded (defect D-03). */}
          <a className="system-state" aria-label="État du système" href="/cockpit">
            Santé ICOS : {health ? healthLabel[health.level] : "inconnue"} · Control Center →
          </a>
        </header>

        <div className="integration-banner" role="status">
          <span>Persistance</span>
          {container.db
            ? "PostgreSQL composé."
            : "Backend mémoire de démonstration : les données affichées sont des seeds, pas l’état ICOS."}
        </div>

        <div className="dashboard-grid">
          <section className="conversation-panel panel" id="conversation">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Canal principal</p>
                <h2>Conversation</h2>
              </div>
              <span className="badge">Session locale</span>
            </div>

            <CommandComposer />
          </section>

          <aside className="activity-column">
            <RecentTasks tasks={tasks} agents={agents} />
            <ApprovalsPanel initialActions={pendingActions} agents={agents} />
            <section className="panel guardrail-card">
              <p className="eyebrow">Garde-fous</p>
              <h2>Contrôle humain actif</h2>
              <p>Les actions sensibles devront être approuvées, tracées et réversibles.</p>
              <div className="guardrail-meta">
                <span>Politique</span>
                <strong>Refus par défaut</strong>
              </div>
            </section>
          </aside>
        </div>

        <AgentGrid agents={agents} />
      </section>
    </main>
  );
}
