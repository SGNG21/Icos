import { AgentGrid } from "@/components/features/agent-grid";
import { ApprovalsPanel } from "@/components/features/approvals-panel";
import { CommandComposer } from "@/components/features/command-composer";
import { RecentTasks } from "@/components/features/recent-tasks";
import { Sidebar } from "@/components/layout/sidebar";
import { getContainer } from "@/server/container";

// Le cockpit lit un état mutable en mémoire : rendu dynamique obligatoire, pas
// de pré-rendu statique ni de cache de rendu.
export const dynamic = "force-dynamic";

export default async function Home() {
  const container = await getContainer();
  const [agents, tasks, pendingActions] = await Promise.all([
    container.agents.list(),
    container.tasks.list(),
    container.actions.list({ approvalStatus: "pending" }),
  ]);

  return (
    <main className="shell">
      <Sidebar />
      <section className="workspace" id="overview">
        <header className="topbar">
          <div>
            <p className="eyebrow">Cockpit opérationnel</p>
            <h1>ICOS</h1>
          </div>
          <div className="system-state" aria-label="État du système">
            <span className="status-dot" />
            Système nominal · mode observation
          </div>
        </header>

        <div className="integration-banner" role="status">
          <span>Intégrations désactivées</span>
          GitHub, IA, n8n, Dolibarr et PostgreSQL ne sont pas connectés.
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

            <div className="empty-conversation">
              <div className="orbit-mark" aria-hidden="true">
                <span>i</span>
              </div>
              <h3>Prêt à recevoir une instruction</h3>
              <p>
                Le moteur d’exécution n’est pas encore actif. Vous pouvez préparer une commande,
                mais aucune action externe ne sera lancée.
              </p>
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
