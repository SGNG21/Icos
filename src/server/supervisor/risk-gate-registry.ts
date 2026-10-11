import type { RiskGateStatus } from "./task-risk-gate";

/**
 * WHICH risk gate the running supervisor ACTUALLY composed, per container — the self-model's
 * only source for `mission.execute = AUTONOMOUS_BY_POLICY` (decision 0075).
 *
 * A neutral module on purpose: the cognitive runtime must read it without importing the
 * production composition (a cycle), and it must read the SUPERVISOR that dispatches, not a
 * flag set beside it. Absent ⇒ no supervisor composed in this process ⇒ never claimed.
 */
const composed = new WeakMap<object, () => RiskGateStatus>();

export function registerComposedRiskGate(container: object, status: () => RiskGateStatus): void {
  composed.set(container, status);
}

export function composedRiskGate(container: object): RiskGateStatus | undefined {
  return composed.get(container)?.();
}
