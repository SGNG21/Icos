"use client";

import { useCallback, useState } from "react";

import type { Agent } from "@/core/contracts";
import type { AuthenticatedSession, HumanAgentRelation, Role } from "@/core/identity";
import type { AdminHumanUser } from "@/server/repositories/ports";

import {
  listLinks,
  removeLink,
  replaceRole,
  setStatus,
  createLink,
} from "./user-administration-client";

export interface UserAdministrationProps {
  initialUsers: AdminHumanUser[];
  agents: Agent[];
  session: AuthenticatedSession;
}

interface OperationState {
  kind: "idle" | "pending" | "success" | "error";
  message?: string;
}

export function UserAdministration({ initialUsers, agents, session }: UserAdministrationProps) {
  const [users, setUsers] = useState(initialUsers);
  const [operation, setOperation] = useState<OperationState>({ kind: "idle" });
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  const handleRoleChange = useCallback(async (userId: string, role: Role) => {
    if (!confirm(`Changer le rôle de l'utilisateur ${userId} en ${role} ?`)) {
      return;
    }
    setOperation({ kind: "pending" });
    try {
      const { user } = await replaceRole(userId, role);
      setUsers((prev) => prev.map((u) => (u.id === userId ? user : u)));
      setOperation({ kind: "success", message: "Rôle mis à jour" });
    } catch (error) {
      setOperation({
        kind: "error",
        message: error instanceof Error ? error.message : "Erreur inconnue",
      });
    }
  }, []);

  const handleStatusToggle = useCallback(
    async (userId: string, currentStatus: "active" | "disabled") => {
      const nextStatus = currentStatus === "active" ? "disabled" : "active";
      if (
        !confirm(
          `${nextStatus === "disabled" ? "Désactiver" : "Activer"} l'utilisateur ${userId} ?`,
        )
      ) {
        return;
      }
      setOperation({ kind: "pending" });
      try {
        const { user } = await setStatus(userId, nextStatus);
        setUsers((prev) => prev.map((u) => (u.id === userId ? user : u)));
        setOperation({ kind: "success", message: "Statut mis à jour" });
      } catch (error) {
        setOperation({
          kind: "error",
          message: error instanceof Error ? error.message : "Erreur inconnue",
        });
      }
    },
    [],
  );

  const handleLinkRemove = useCallback(
    async (userId: string, agentId: string) => {
      if (!confirm(`Retirer le lien vers ${agentId} ?`)) {
        return;
      }
      setOperation({ kind: "pending" });
      try {
        await removeLink(userId, agentId);
        setOperation({ kind: "success", message: "Lien retiré" });
        if (expandedUser === userId) {
          setExpandedUser(null);
        }
      } catch (error) {
        setOperation({
          kind: "error",
          message: error instanceof Error ? error.message : "Erreur inconnue",
        });
      }
    },
    [expandedUser],
  );

  const handleLinkAdd = useCallback(
    async (userId: string, agentId: string, relation: HumanAgentRelation) => {
      setOperation({ kind: "pending" });
      try {
        await createLink(userId, { agentId, relation });
        setOperation({ kind: "success", message: "Lien ajouté" });
      } catch (error) {
        setOperation({
          kind: "error",
          message: error instanceof Error ? error.message : "Erreur inconnue",
        });
      }
    },
    [],
  );

  return (
    <div className="admin-panel">
      <div className="sr-only" aria-live="polite" role="status">
        {operation.kind === "success"
          ? operation.message
          : operation.kind === "error"
            ? `Erreur : ${operation.message}`
            : ""}
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Nom</th>
            <th>Rôle</th>
            <th>Statut</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td>{user.name ?? "—"}</td>
              <td>{user.role ?? "—"}</td>
              <td>{user.status}</td>
              <td className="admin-actions">
                <select
                  value={user.role ?? ""}
                  disabled={session.user.id === user.id || operation.kind === "pending"}
                  aria-label={`Rôle de ${user.email}`}
                  onChange={(e) => handleRoleChange(user.id, e.target.value as Role)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
                <button
                  type="button"
                  disabled={session.user.id === user.id || operation.kind === "pending"}
                  aria-label={`${user.status === "active" ? "Désactiver" : "Activer"} ${user.email}`}
                  onClick={() => handleStatusToggle(user.id, user.status as "active" | "disabled")}
                >
                  {user.status === "active" ? "Désactiver" : "Activer"}
                </button>
                <button
                  type="button"
                  disabled={session.user.id === user.id || operation.kind === "pending"}
                  aria-expanded={expandedUser === user.id}
                  aria-label={`Liens de ${user.email}`}
                  onClick={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                >
                  Liens
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {expandedUser && (
        <AgentLinksForm
          userId={expandedUser}
          agents={agents}
          disabled={operation.kind === "pending"}
          onRemove={handleLinkRemove}
          onAdd={handleLinkAdd}
        />
      )}
    </div>
  );
}

function AgentLinksForm({
  userId,
  agents,
  disabled,
  onRemove,
  onAdd,
}: {
  userId: string;
  agents: Agent[];
  disabled: boolean;
  onRemove: (userId: string, agentId: string) => void;
  onAdd: (userId: string, agentId: string, relation: HumanAgentRelation) => void;
}) {
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedRelation, setSelectedRelation] = useState<HumanAgentRelation>("operator");

  return (
    <div className="admin-links-panel">
      <h3>Rattachements agents — {userId}</h3>
      <div className="admin-links-form">
        <select
          value={selectedAgent}
          disabled={disabled}
          aria-label="Agent à rattacher"
          onChange={(e) => setSelectedAgent(e.target.value)}
        >
          <option value="">Sélectionner un agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.id}
            </option>
          ))}
        </select>
        <select
          value={selectedRelation}
          disabled={disabled}
          aria-label="Relation"
          onChange={(e) => setSelectedRelation(e.target.value as HumanAgentRelation)}
        >
          <option value="supervisor">Superviseur</option>
          <option value="operator">Opérateur</option>
          <option value="observer">Observateur</option>
        </select>
        <button
          type="button"
          disabled={!selectedAgent || disabled}
          onClick={() => onAdd(userId, selectedAgent, selectedRelation)}
        >
          Ajouter
        </button>
        <button
          type="button"
          disabled={disabled}
          className="btn-ghost"
          onClick={() => window.location.reload()}
        >
          Retour
        </button>
      </div>
      <RemoveLinkSection userId={userId} onRemove={onRemove} />
    </div>
  );
}

function RemoveLinkSection({
  userId,
  onRemove,
}: {
  userId: string;
  onRemove: (userId: string, agentId: string) => void;
}) {
  const [links, setLinks] = useState<{ agentId: string }[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await listLinks(userId);
      setLinks(result.links);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  };

  if (links === null && !loading) {
    return (
      <button type="button" onClick={load}>
        Afficher les liens existants
      </button>
    );
  }

  if (loading) {
    return <p>Chargement…</p>;
  }

  if (links?.length === 0) {
    return <p>Aucun lien existant.</p>;
  }

  return (
    <ul className="admin-links-list">
      {links?.map((link) => (
        <li key={link.agentId}>
          {link.agentId}
          <button type="button" onClick={() => onRemove(userId, link.agentId)}>
            Retirer
          </button>
        </li>
      ))}
    </ul>
  );
}
