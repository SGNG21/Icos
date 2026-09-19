import { InMemoryRecoveryUnitRepository } from "@/server/recovery/in-memory-recovery-unit-repository";
import { describeRecoveryUnitRepositoryContract } from "@/server/recovery/recovery-unit-repository.contract";

describeRecoveryUnitRepositoryContract(
  "in-memory",
  async () => new InMemoryRecoveryUnitRepository(),
);
