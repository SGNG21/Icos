export type AgentStatus = "available" | "standby" | "offline";
export type AuthorizationLevel = 0 | 1 | 2 | 3;

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  authorizationLevel: AuthorizationLevel;
  description: string;
}
