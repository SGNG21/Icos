import type { WorkflowProbe } from "@/core/contracts/recovery";
import type { RuntimeControlGuard } from "@/server/control/runtime-control";
import type { Database } from "@/server/database/client";
import { PostgresRecoveryScanner } from "@/server/recovery/postgres-recovery-scanner";
import { PostgresRecoveryUnitRepository } from "@/server/recovery/postgres-recovery-unit-repository";
import { createRecoveryActions, type RecoveryActionDeps } from "@/server/recovery/recovery-actions";
import {
  RuntimeRecoverySweeper,
  type RuntimeRecoveryOptions,
} from "@/server/recovery/runtime-recovery-sweeper";

/** Composition PostgreSQL du sweeper 7C (partagée par `production-services` et les tests de crash/restart). */
export function composeRuntimeRecovery(
  input: RecoveryActionDeps & {
    db: Database;
    probe?: WorkflowProbe;
    options?: Partial<RuntimeRecoveryOptions>;
    control?: Pick<RuntimeControlGuard, "dispatch">;
  },
): RuntimeRecoverySweeper {
  return new RuntimeRecoverySweeper(
    new PostgresRecoveryScanner(input.db),
    new PostgresRecoveryUnitRepository(input.db),
    createRecoveryActions(input),
    input.probe,
    input.options,
    input.control,
  );
}
