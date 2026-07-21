import { demoAgents } from "@/features/agents/data";

const statusLabel = {
  available: "Disponible",
  standby: "En attente",
  offline: "Hors ligne",
} as const;

export function AgentGrid() {
  return (
    <section className="agents-section" id="agents">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Organisation virtuelle</p>
          <h2>Agents spécialisés</h2>
        </div>
        <span className="section-count">{demoAgents.length} profils configurés</span>
      </div>
      <div className="agent-grid">
        {demoAgents.map((agent) => (
          <article className="agent-card" key={agent.id}>
            <div className="agent-topline">
              <span className="agent-monogram">{agent.name.slice(0, 2).toUpperCase()}</span>
              <span className={`agent-status ${agent.status}`}>{statusLabel[agent.status]}</span>
            </div>
            <h3>{agent.name}</h3>
            <p className="agent-role">{agent.role}</p>
            <p className="agent-description">{agent.description}</p>
            <div className="agent-footer">
              <span>Autorisation</span>
              <strong>Niveau {agent.authorizationLevel}</strong>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
