import { describe, expect, it } from "vitest";

import type { Env } from "@/config/env";
import { AUTONOMY_BOUNDS_CEILING } from "@/core/autonomy/bounds";
import { isModelAllowed, MODEL_ALLOWLIST_UNRESTRICTED } from "@/core/autonomy/model-allowlist";
import { buildAutonomyCompositionPolicy, buildMemoryContainer } from "@/server/container";

/*
 * LE CÂBLAGE EST LA LIVRAISON.
 *
 * `bounds.ts` et `model-allowlist.ts` étaient déjà corrects et déjà testés — et
 * n'étaient atteints par RIEN. Ces tests échouent si quelqu'un retire la politique du
 * conteneur : une politique sans appelant n'applique rien du tout.
 */

function env(overrides: Partial<Env> = {}): Env {
  return { NODE_ENV: "production", ...overrides } as Env;
}

describe("politique d'autonomie composée par le conteneur", () => {
  it("rien de configuré = plafond historique et compute NON RESTREINT", () => {
    const policy = buildAutonomyCompositionPolicy(env());

    expect(policy.options).toEqual(AUTONOMY_BOUNDS_CEILING);
    expect(policy.systemModelAllowlist).toEqual(MODEL_ALLOWLIST_UNRESTRICTED);
    expect(policy.plannerCompute).toEqual({ providerId: "omniroute" });
  });

  it("transporte le plafond RESSERRÉ du déploiement", () => {
    const policy = buildAutonomyCompositionPolicy(
      env({ ICOS_AUTONOMY_MAX_CYCLES: 20, ICOS_AUTONOMY_MAX_REPLANS: 2 }),
    );

    expect(policy.options).toMatchObject({ maxCycles: 20, maxReplans: 2 });
  });

  it("transporte le pool système ET le modèle réellement configuré", () => {
    const policy = buildAutonomyCompositionPolicy(
      env({ ICOS_AUTONOMY_ALLOWED_MODELS: "cheap-model", ICOS_PLANNER_MODEL: "cheap-model" }),
    );

    expect(isModelAllowed(policy.systemModelAllowlist!, "cheap-model")).toBe(true);
    expect(isModelAllowed(policy.systemModelAllowlist!, "expensive-model")).toBe(false);
    /* Le modèle annoncé est celui que le planificateur utilisera vraiment. */
    expect(policy.plannerCompute).toEqual({ modelId: "cheap-model", providerId: "omniroute" });
  });

  it("n'annonce AUCUN modèle quand le planificateur est un processus local", () => {
    /* Irrésoluble, donc refusé sous un goal restreint — jamais accordé par défaut. */
    expect(buildAutonomyCompositionPolicy(env()).plannerCompute?.modelId).toBeUndefined();
  });

  it("le conteneur mémoire expose la politique par défaut, jamais une absence", () => {
    expect(buildMemoryContainer().autonomyPolicy).toEqual({});
  });
});
