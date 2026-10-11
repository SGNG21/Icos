import { afterAll, beforeAll, vi } from "vitest";

import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { describeScheduledJobRepositoryContract } from "@/server/scheduler/scheduler-job-repository.contract";

// The in-memory clock is `Date`: fake ONLY Date so `elapse` can move it explicitly.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
});
afterAll(() => {
  vi.useRealTimers();
});

describeScheduledJobRepositoryContract(
  "in-memory",
  async () => new InMemoryScheduledJobRepository(),
  async (ms) => {
    vi.setSystemTime(Date.now() + ms);
  },
);
