import canonicalSelfState from "../../../docs/coordination/self-state.v1.json";

import {
  selfStateSnapshotSchema,
  type DeepReadonly,
  type SelfStateSnapshot,
} from "@/core/self-state";

export class SelfStateLoadError extends Error {
  readonly code = "INVALID_SELF_STATE";

  constructor() {
    super("Canonical self-state is malformed or unsupported.");
    this.name = "SelfStateLoadError";
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}

/**
 * Loads and validates repository-owned self-state.
 *
 * The source is the versioned repository file imported above. Callers cannot
 * substitute chat, session memory, or another runtime source.
 */
export function loadSelfStateSnapshot(): SelfStateSnapshot {
  const parsed = selfStateSnapshotSchema.safeParse(canonicalSelfState);

  if (!parsed.success) {
    throw new SelfStateLoadError();
  }

  return deepFreeze(parsed.data);
}
