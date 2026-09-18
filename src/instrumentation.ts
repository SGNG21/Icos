import { loadEnv } from "@/config/env";
import type {
  ProductionServices,
  StartProductionServicesOptions,
} from "@/server/system/production-services";

const PRODUCTION_SERVICES_KEY = "__icosProductionServicesPromise__";

type GlobalWithProductionServices = typeof globalThis & {
  [PRODUCTION_SERVICES_KEY]?: Promise<ProductionServices>;
};

export async function register(options?: StartProductionServicesOptions): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { startProductionServices } = await import("@/server/system/production-services");
  const globalRef = globalThis as GlobalWithProductionServices;

  if (!globalRef[PRODUCTION_SERVICES_KEY]) {
    const startPromise = startProductionServices(options ?? { env: loadEnv() }).catch(
      (error: unknown) => {
        if (globalRef[PRODUCTION_SERVICES_KEY] === startPromise) {
          delete globalRef[PRODUCTION_SERVICES_KEY];
        }

        throw error;
      },
    );
    globalRef[PRODUCTION_SERVICES_KEY] = startPromise;
  }

  await globalRef[PRODUCTION_SERVICES_KEY];
}
