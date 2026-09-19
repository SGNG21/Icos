import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { describeScheduledJobRepositoryContract } from "@/server/scheduler/scheduler-job-repository.contract";

describeScheduledJobRepositoryContract("in-memory", async () => new InMemoryScheduledJobRepository());
