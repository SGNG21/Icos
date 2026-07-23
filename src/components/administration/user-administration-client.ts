import type { HumanAgentLink, HumanAgentRelation, Role, UserStatus } from "@/core/identity";
import type { AdminHumanUser } from "@/server/repositories/ports";

export interface ApiErrorResponse {
  error?: { code?: string; message?: string };
}

export interface UserCreateInput {
  email: string;
  password: string;
  name?: string;
  role: Role;
}

export interface AgentLinkCreateInput {
  agentId: string;
  relation: HumanAgentRelation;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }
  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function listUsers(): Promise<{ users: AdminHumanUser[] }> {
  return apiFetch("/api/users");
}

export async function createUser(input: UserCreateInput): Promise<{ user: AdminHumanUser }> {
  return apiFetch("/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function replaceRole(userId: string, role: Role): Promise<{ user: AdminHumanUser }> {
  return apiFetch(`/api/users/${userId}/role`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export async function setStatus(
  userId: string,
  status: UserStatus,
): Promise<{ user: AdminHumanUser }> {
  return apiFetch(`/api/users/${userId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export async function listLinks(userId: string): Promise<{ links: HumanAgentLink[] }> {
  return apiFetch(`/api/users/${userId}/agent-links`);
}

export async function createLink(
  userId: string,
  input: AgentLinkCreateInput,
): Promise<{ link: HumanAgentLink }> {
  return apiFetch(`/api/users/${userId}/agent-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function removeLink(userId: string, agentId: string): Promise<void> {
  return apiFetch(`/api/users/${userId}/agent-links/${agentId}`, {
    method: "DELETE",
  });
}
