import type { Agent, AgentAction, Approval, AuditEntry, Task } from "./contracts";

/**
 * Comparateurs d'ordre déterministe, partagés pour garantir la PARITÉ entre les
 * repositories in-memory et PostgreSQL. Les horodatages sont comparés par
 * instant (`Date.getTime`) — et non lexicographiquement — afin de coïncider avec
 * l'ordre `timestamptz` de PostgreSQL quelle que soit la représentation ISO.
 *
 * Ordres :
 * - agents      : authorizationLevel DESC, id ASC
 * - tasks       : createdAt ASC, id ASC
 * - actions     : requestedAt ASC, id ASC
 * - approvals   : decidedAt ASC, id ASC
 * - auditEntries: occurredAt ASC, id ASC
 */

const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const instant = (iso: string): number => new Date(iso).getTime();

export const compareAgents = (a: Agent, b: Agent): number =>
  cmpNum(b.authorizationLevel, a.authorizationLevel) || cmpStr(a.id, b.id);

export const compareTasks = (a: Task, b: Task): number =>
  cmpNum(instant(a.createdAt), instant(b.createdAt)) || cmpStr(a.id, b.id);

export const compareActions = (a: AgentAction, b: AgentAction): number =>
  cmpNum(instant(a.requestedAt), instant(b.requestedAt)) || cmpStr(a.id, b.id);

export const compareApprovals = (a: Approval, b: Approval): number =>
  cmpNum(instant(a.decidedAt), instant(b.decidedAt)) || cmpStr(a.id, b.id);

export const compareAuditEntries = (a: AuditEntry, b: AuditEntry): number =>
  cmpNum(instant(a.occurredAt), instant(b.occurredAt)) || cmpStr(a.id, b.id);
