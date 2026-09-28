import type { WorkerView } from "./snapshot";
import { isReal, missing, real, type Truth } from "./truth";

/**
 * Provider › Account › Model › Worker tree, built only from what the worker
 * registry declares. A worker that declares no provider/account/model is kept
 * under an explicit UNDECLARED branch — never guessed from its name or kind.
 * Capacity pools are a separate axis (several workers can share one quota), so
 * they are aggregated on their own and never assumed to equal an API key.
 */
export const UNDECLARED = "UNDECLARED";

export interface ModelNode {
  model: string;
  workers: {
    id: string;
    name: string;
    runtime: string;
    tone: WorkerView["tone"];
    used: Truth<number>;
    max: number;
  }[];
}
export interface AccountNode {
  account: string;
  models: ModelNode[];
}
export interface ProviderNode {
  provider: string;
  declared: boolean;
  accounts: AccountNode[];
  workerCount: number;
}
export interface PoolNode {
  pool: string;
  /** Smallest declared limit wins (mirrors routing: a quota resolves downwards). */
  limit: number | null;
  used: Truth<number>;
  workers: string[];
}

const key = (t: Truth<string>) => (isReal(t) ? t.value : UNDECLARED);

export function buildResourceTree(workers: readonly WorkerView[]): {
  providers: ProviderNode[];
  pools: PoolNode[];
} {
  const providers = new Map<string, Map<string, Map<string, ModelNode["workers"]>>>();
  for (const w of workers) {
    const accounts = providers.get(key(w.provider)) ?? new Map();
    const models = accounts.get(key(w.account)) ?? new Map();
    const list = models.get(key(w.model)) ?? [];
    list.push({
      id: w.id,
      name: w.name,
      runtime: w.runtime,
      tone: w.tone,
      used: w.slots.used,
      max: w.slots.max,
    });
    models.set(key(w.model), list);
    accounts.set(key(w.account), models);
    providers.set(key(w.provider), accounts);
  }

  const sortKeys = (a: string, b: string) =>
    Number(a === UNDECLARED) - Number(b === UNDECLARED) || a.localeCompare(b);
  const providerNodes = [...providers.keys()].sort(sortKeys).map((provider) => {
    const accounts = providers.get(provider)!;
    const accountNodes = [...accounts.keys()].sort(sortKeys).map((account) => ({
      account,
      models: [...accounts.get(account)!.keys()]
        .sort(sortKeys)
        .map((model) => ({ model, workers: accounts.get(account)!.get(model)! })),
    }));
    return {
      provider,
      declared: provider !== UNDECLARED,
      accounts: accountNodes,
      workerCount: accountNodes.reduce(
        (n, a) => n + a.models.reduce((m, x) => m + x.workers.length, 0),
        0,
      ),
    };
  });

  const pools = new Map<string, WorkerView[]>();
  for (const w of workers)
    if (w.pool) pools.set(w.pool.name, [...(pools.get(w.pool.name) ?? []), w]);
  const poolNodes = [...pools.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pool, members]) => {
      const limits = members.map((m) => m.pool!.limit).filter((l): l is number => l !== null);
      const unknownLoad = members.find((m) => !isReal(m.slots.used));
      return {
        pool,
        limit: limits.length ? Math.min(...limits) : null,
        used: unknownLoad
          ? unknownLoad.slots.used
          : real(
              members.reduce((n, m) => n + (isReal(m.slots.used) ? m.slots.used.value : 0), 0),
              "sum of member dispatches",
            ),
        workers: members.map((m) => m.name),
      };
    });

  return { providers: providerNodes, pools: poolNodes };
}

export const providerTelemetry = () =>
  missing<number>("not_available", "No provider health/latency/throughput source exists.", "BR-04");
