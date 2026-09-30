import {
  checkMemoryAccess,
  effectiveMemoryScope,
  evaluateToolGrant,
  supervisionChain,
  type EffectiveMemoryScope,
  type MemoryAccessQuery,
  type ToolGrantDecision,
  type ToolGrantQuery,
} from "@/core/workforce/authority";
import type { Principal } from "@/core/workforce/governance";

import type { WorkforceStore } from "./ports";
import type { PrincipalAuthority } from "./principals";
import { WorkforceDeniedError } from "./workforce-service";

/**
 * TOOL GRANT and MEMORY SCOPE ports (decision 0057 §integration).
 *
 * The Tool Gateway owns tool execution; the Cognitive Runtime owns memory storage. Each asks
 * the workforce, at the moment of use, what an agent is allowed — read from durable state,
 * narrowed by the whole supervision chain as it is NOW (revocation and policy drift are
 * visible at the next call; `chainVersion` changes with any policy change on the chain).
 * Only a trusted runtime principal may ask. The answer is fail-closed.
 */
export class WorkforceAuthorityPort {
  constructor(
    private readonly deps: {
      store: WorkforceStore;
      principals: Pick<PrincipalAuthority, "isIssued">;
      now: () => string;
    },
  ) {}

  private async chain(system: Principal, agentId: string) {
    if (!this.deps.principals.isIssued(system) || system.kind !== "system") {
      throw new WorkforceDeniedError(["ACTOR_NOT_AUTHORIZED"]);
    }
    return supervisionChain(agentId, await this.deps.store.listAgents(system.tenantId));
  }

  /** "Is agent X currently granted action Y on tool T in scope Z?" */
  async checkToolGrant(
    system: Principal,
    q: ToolGrantQuery & { agentId: string },
  ): Promise<ToolGrantDecision> {
    return evaluateToolGrant(await this.chain(system, q.agentId), q, this.deps.now());
  }

  async resolveMemoryScope(
    system: Principal,
    agentId: string,
  ): Promise<EffectiveMemoryScope | null> {
    return effectiveMemoryScope(await this.chain(system, agentId), this.deps.now());
  }

  async checkMemoryAccess(system: Principal, q: MemoryAccessQuery & { agentId: string }) {
    return checkMemoryAccess(await this.resolveMemoryScope(system, q.agentId), q);
  }
}
