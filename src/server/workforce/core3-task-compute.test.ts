import { beforeEach, describe, expect, it } from "vitest";

import type { WorkforceRuntime } from "./composition";
import { workforceTaskCompute } from "./core3-task-compute";
import type { WorkforceStore } from "./ports";
import { as, buildOrg, head, makeService, req, specialist, system } from "./test-support";
import type { WorkforceService } from "./workforce-service";

/**
 * The CORE3 ↔ workforce compute seam. `requestFor` had no caller at all; these are the proofs
 * of what the caller may and may not learn from a brain assignment — difficulty and worker
 * capabilities, plus the approval hold, and NEVER a model.
 */

let service: WorkforceService;
let runtime: WorkforceRuntime;
let store: WorkforceStore;

beforeEach(async () => {
  ({ service, runtime, store } = makeService());
  await buildOrg(service, ["CYBER_SECURITY_LEAD", "APPSEC_SPECIALIST"]);
  await head(
    service,
    "security-lead",
    "CYBER_SECURITY_LEAD",
    "security",
    ["repo_read", "scanners", "logs"],
    ["icos"],
  );
  await specialist(
    service,
    "security-lead",
    "appsec-1",
    "APPSEC_SPECIALIST",
    ["repo_read", "scanners"],
    ["icos"],
  );
});

const source = () => workforceTaskCompute({ compute: runtime.compute, store, system });

/** One assignment on `mission-sec` / `appsec`, optionally gated by an action class. */
async function assign(actionClass?: string) {
  const top = await service.delegate(as("icos-central"), {
    requests: [req("mission-sec", "audit", ["threat_modeling"], "icos")],
    parentAssignmentId: null,
  });
  await service.start(as("security-lead"), top.assignments[0].assignmentId);
  const sub = await service.delegate(as("security-lead"), {
    requests: [req("mission-sec", "appsec", ["appsec"], "icos", actionClass)],
    parentAssignmentId: top.assignments[0].assignmentId,
  });
  expect(sub.gaps).toEqual([]);
  return sub.assignments[0];
}

describe("workforceTaskCompute", () => {
  it("turns a brain assignment into capabilities + difficulty, and never names a model", async () => {
    const a = await assign();
    const need = await source().forTask("mission-sec", "appsec");
    expect(need).toEqual({
      assignmentId: a.assignmentId,
      agentId: "appsec-1",
      // The bootstrap skills declare no worker capabilities: the brain ADDS none here, and
      // saying so is the point — an empty list must never be mistaken for a wildcard.
      workerCapabilities: [],
      complexity: "high",
      approvalPending: false,
    });
    expect(JSON.stringify(need)).not.toMatch(/model|opus|sonnet|haiku|gpt|nemotron|claude/i);
  });

  it("reports a missing human approval as pending, so CORE3 holds the dispatch", async () => {
    await assign("destructive_remediation");
    expect(await source().forTask("mission-sec", "appsec")).toMatchObject({
      approvalPending: true,
    });
  });

  it("answers null for a task no brain is assigned to, and once the assignment is running", async () => {
    const a = await assign();
    expect(await source().forTask("mission-sec", "autre-tache")).toBeNull();
    expect(await source().forTask("autre-mission", "appsec")).toBeNull();
    await service.start(as("appsec-1"), a.assignmentId);
    expect(await source().forTask("mission-sec", "appsec")).toBeNull();
  });

  it("refuses to answer a caller that is not the trusted runtime", async () => {
    await assign();
    const forged = { ...system };
    await expect(
      workforceTaskCompute({ compute: runtime.compute, store, system: forged }).forTask(
        "mission-sec",
        "appsec",
      ),
    ).rejects.toThrow();
  });
});
