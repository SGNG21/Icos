import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { SystemAgent } from "@/core/policy";
import type { AuthGateway } from "@/server/auth/ports";
import {
  COCKPIT_MAX_OBJECTIVE_LENGTH,
  CockpitJobRegistry,
  type CockpitJobProjection,
  type CockpitRuntime,
} from "@/server/cockpit/job-registry";
import { buildMemoryContainer, type Container } from "@/server/container";
import {
  createCockpitRuntimeForTests,
  resetCockpitRuntimeForTests,
  type CockpitExecutionInput,
  type CockpitExecutionResult,
} from "@/server/cockpit/runtime";

import { GET as getCockpitJob } from "./[id]/route";
import { POST as postCockpitJob } from "./route";

const CONTAINER_KEY = "__icosContainerPromise__";
const RUNTIME_KEY = "__icosCockpitRuntime__";
const APP_ORIGIN = "http://localhost";
const SESSION_COOKIE = "icos.session_token=opaque-test-value";
const IDEMPOTENCY_KEY = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const JOB_ID = "cockpit-job-123e4567-e89b-42d3-a456-426614174000";
const FOREIGN_JOB_ID = "cockpit-job-123e4567-e89b-42d3-a456-426614174001";

const executor: SystemAgent = {
  id: "server-owned-executor",
  tenantId: "default",
  roles: ["reviewed.local.execute"],
  authorizationLevel: 2,
  justification: "Controlled route test executor.",
};

function session(role: Role): AuthenticatedSession {
  return {
    user: {
      id: "trusted-human",
      email: "human@icos.test",
      name: "Human",
      status: "active",
    },
    roles: [role],
  };
}

function authGateway(value: AuthenticatedSession | null): AuthGateway {
  return {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => value?.user ?? null,
    readHumanUserByEmail: async () => value?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => value),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
}

function installSession(role: Role | null): Container {
  const base = buildMemoryContainer();
  const container: Container = {
    ...base,
    auth: authGateway(role === null ? null : session(role)),
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

function installRuntime(value: CockpitRuntime): void {
  (globalThis as Record<string, unknown>)[RUNTIME_KEY] = value;
}

function realRuntime(
  execute: (input: CockpitExecutionInput) => Promise<CockpitExecutionResult>,
  registry = new CockpitJobRegistry(),
): CockpitRuntime {
  return createCockpitRuntimeForTests({
    registry,
    executorIdentity: executor,
    execute,
  });
}

function postRequest(
  body: unknown,
  options: {
    authenticated?: boolean;
    contentType?: string;
    idempotencyKey?: string | null;
    origin?: string;
    rawBody?: string;
  } = {},
): Request {
  const origin = options.origin ?? APP_ORIGIN;
  const authenticated = options.authenticated ?? true;
  const idempotencyKey =
    options.idempotencyKey === undefined ? IDEMPOTENCY_KEY : options.idempotencyKey;
  return new Request(`${APP_ORIGIN}/api/cockpit/jobs`, {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      origin,
      "sec-fetch-site": origin === APP_ORIGIN ? "same-origin" : "cross-site",
      ...(authenticated ? { cookie: SESSION_COOKIE } : {}),
      ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function getRequest(id: string, authenticated = true): Request {
  return new Request(`${APP_ORIGIN}/api/cockpit/jobs/${id}`, {
    headers: authenticated ? { cookie: SESSION_COOKIE } : undefined,
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

function projection(overrides: Partial<CockpitJobProjection> = {}): CockpitJobProjection {
  return {
    jobId: JOB_ID,
    objective: "Safe objective",
    status: "QUEUED",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    tasks: [],
    workers: [],
    blockers: [],
    evidence: [],
    mergePerformed: false,
    productionDeploymentPerformed: false,
    ...overrides,
  };
}

beforeEach(() => {
  installSession("operator");
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  resetCockpitRuntimeForTests();
});

describe("Cockpit route files", () => {
  it("finds and executes both route modules explicitly", async () => {
    expect(existsSync(resolve(process.cwd(), "src/app/api/cockpit/jobs/route.ts"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "src/app/api/cockpit/jobs/[id]/route.ts"))).toBe(
      true,
    );

    const runtime: CockpitRuntime = {
      submitJob: vi.fn(async () => projection()),
      getJob: vi.fn(() => projection()),
    };
    installRuntime(runtime);

    expect((await postCockpitJob(postRequest({ objective: "Execute POST" }))).status).toBe(
      202,
    );
    expect((await getCockpitJob(getRequest(JOB_ID), params(JOB_ID))).status).toBe(200);
  });

  it("wires POST through the shared runtime and bounded registry to a safe tenant-isolated GET", async () => {
    const ids = [JOB_ID, FOREIGN_JOB_ID];
    const registry = new CockpitJobRegistry({
      createId: () => ids.shift() ?? FOREIGN_JOB_ID,
    });
    let received: CockpitExecutionInput | undefined;
    const execute = vi.fn(async (input: CockpitExecutionInput) => {
      received = input;
      return {
        status: "FAILED" as const,
        failure: {
          code: "execution_failed",
          message: "token=secret /Users/operator/private stack",
        },
        finalResult: "credential=hidden /var/private/result",
      };
    });
    const runtime = realRuntime(execute, registry);
    installRuntime(runtime);

    const first = await postCockpitJob(postRequest({ objective: "Fail honestly" }));
    const replay = await postCockpitJob(postRequest({ objective: "Fail honestly" }));
    const firstBody = (await first.json()) as { job: CockpitJobProjection };
    const replayBody = (await replay.json()) as { job: CockpitJobProjection };

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replayBody.job.jobId).toBe(firstBody.job.jobId);
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
      expect(runtime.getJob("default", firstBody.job.jobId)?.status).toBe("FAILED");
    });
    expect(received?.tenantId).toBe("default");
    expect(received?.requester).toEqual({ kind: "human", id: "trusted-human" });
    expect(received?.executor.id).toBe("server-owned-executor");

    const getResponse = await getCockpitJob(
      getRequest(firstBody.job.jobId),
      params(firstBody.job.jobId),
    );
    const getBody = (await getResponse.json()) as { job: CockpitJobProjection };
    expect(getResponse.status).toBe(200);
    expect(getBody.job.status).toBe("FAILED");
    expect(getBody.job.status).not.toBe("SUCCEEDED");
    const serialized = JSON.stringify(getBody);
    expect(serialized).not.toMatch(
      /"(?:tenantId|requester|actorId|actor|executor|credential|secret|token|command|args|patch|worktreePath|repositoryPath|stack|approval|ExecutionGrant)"\s*:/i,
    );
    expect(serialized).not.toMatch(
      /opaque-test-value|server-owned-executor|trusted-human|token=secret|credential=hidden|\/Users\/|\/var\//i,
    );
    expect(serialized).toContain("[redacted-credential]");
    expect(serialized).toContain("[redacted-path]");

    registry.createOrGet({
      tenantId: "foreign",
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174002",
      objective: "Foreign work",
      requester: { kind: "human", id: "foreign-human" },
    });
    const foreignResponse = await getCockpitJob(
      getRequest(FOREIGN_JOB_ID),
      params(FOREIGN_JOB_ID),
    );
    expect(foreignResponse.status).toBe(404);
  });
});

describe("POST /api/cockpit/jobs", () => {
  it("rejects an unauthenticated request", async () => {
    installSession(null);
    const response = await postCockpitJob(
      postRequest({ objective: "Denied" }, { authenticated: false }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
  });

  it("rejects insufficient authorization", async () => {
    installSession("viewer");
    const response = await postCockpitJob(postRequest({ objective: "Denied" }));
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("rejects cross-origin before submission", async () => {
    const submitJob = vi.fn(async () => projection());
    installRuntime({ submitJob, getJob: vi.fn(() => null) });
    const response = await postCockpitJob(
      postRequest({ objective: "Denied" }, { origin: "https://attacker.test" }),
    );
    expect(response.status).toBe(403);
    expect(submitJob).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await postCockpitJob(
      postRequest(null, { rawBody: "{not-json" }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("accepts JSON only", async () => {
    const response = await postCockpitJob(
      postRequest({ objective: "Text body" }, { contentType: "text/plain" }),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ["unknown body field", { objective: "Valid", extra: true }],
    ["missing objective", {}],
    ["blank objective", { objective: "   " }],
    [
      "oversized objective",
      { objective: "x".repeat(COCKPIT_MAX_OBJECTIVE_LENGTH + 1) },
    ],
  ])("rejects %s", async (_label, body) => {
    const response = await postCockpitJob(postRequest(body));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("rejects a missing Idempotency-Key", async () => {
    const response = await postCockpitJob(
      postRequest({ objective: "Valid" }, { idempotencyKey: null }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a malformed Idempotency-Key", async () => {
    const response = await postCockpitJob(
      postRequest({ objective: "Valid" }, { idempotencyKey: "not-a-uuid" }),
    );
    expect(response.status).toBe(400);
  });

  it("accepts a new job with 202, no-store, and a safe response", async () => {
    installRuntime(realRuntime(async () => ({ status: "SUCCEEDED" })));
    const response = await postCockpitJob(postRequest({ objective: "Safe work" }));
    const body = (await response.json()) as { job: CockpitJobProjection };

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.job.objective).toBe("Safe work");
    expect(JSON.stringify(body)).not.toMatch(
      /tenantId|requester|executor|credential|token|command|shell|args|stack|worktree|repositoryPath/i,
    );
  });

  it("returns the same safe projection for an exact replay without re-execution", async () => {
    const execute = vi.fn(async () => ({ status: "SUCCEEDED" as const }));
    installRuntime(realRuntime(execute));
    const first = await postCockpitJob(postRequest({ objective: "Same work" }));
    const replay = await postCockpitJob(postRequest({ objective: "Same work" }));
    const firstBody = (await first.json()) as { job: CockpitJobProjection };
    const replayBody = (await replay.json()) as { job: CockpitJobProjection };

    expect(replay.status).toBe(202);
    expect(replayBody.job.jobId).toBe(firstBody.job.jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });

  it("maps conflicting idempotency reuse to 409", async () => {
    installRuntime(realRuntime(async () => ({ status: "SUCCEEDED" })));
    await postCockpitJob(postRequest({ objective: "First" }));
    const response = await postCockpitJob(postRequest({ objective: "Different" }));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("idempotency_conflict");
  });

  it("maps bounded registry exhaustion to 503", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const runtime = createCockpitRuntimeForTests({
      registry: new CockpitJobRegistry({ capacity: 1 }),
      executorIdentity: executor,
      execute: async () => {
        await pending;
        return { status: "SUCCEEDED" };
      },
    });
    installRuntime(runtime);
    await postCockpitJob(postRequest({ objective: "First" }));

    const response = await postCockpitJob(
      postRequest(
        { objective: "Second" },
        { idempotencyKey: "123e4567-e89b-42d3-a456-426614174001" },
      ),
    );
    release?.();
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("capacity_exhausted");
  });

  it("uses trusted tenant and requester provenance", async () => {
    let received: CockpitExecutionInput | undefined;
    installRuntime(
      realRuntime(async (input) => {
        received = input;
        return { status: "SUCCEEDED" };
      }),
    );
    await postCockpitJob(postRequest({ objective: "Trusted context" }));
    await vi.waitFor(() => expect(received).toBeDefined());

    expect(received?.tenantId).toBe("default");
    expect(received?.requester).toEqual({ kind: "human", id: "trusted-human" });
    expect(received?.executor.id).toBe("server-owned-executor");
  });

  it.each(["tenantId", "actorId", "executor", "authority", "permissions"])(
    "does not allow body injection through %s",
    async (field) => {
      const submitJob = vi.fn(async () => projection());
      installRuntime({ submitJob, getJob: vi.fn(() => null) });
      const response = await postCockpitJob(
        postRequest({ objective: "Valid", [field]: "attacker-controlled" }),
      );
      expect(response.status).toBe(400);
      expect(submitJob).not.toHaveBeenCalled();
    },
  );

  it("sanitizes unexpected failures", async () => {
    installRuntime({
      submitJob: vi.fn(async () => {
        throw new Error("token=secret /Users/operator/private stack");
      }),
      getJob: vi.fn(() => null),
    });
    const response = await postCockpitJob(postRequest({ objective: "Fail safely" }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/secret|Users|stack/i);
  });
});

describe("GET /api/cockpit/jobs/[id]", () => {
  it("rejects an unauthenticated request", async () => {
    installSession(null);
    const response = await getCockpitJob(getRequest(JOB_ID, false), params(JOB_ID));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed job ID", async () => {
    const getJob = vi.fn(() => projection());
    installRuntime({ submitJob: vi.fn(), getJob });
    const response = await getCockpitJob(getRequest("bad-id"), params("bad-id"));
    expect(response.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("returns a known same-tenant job with no-store", async () => {
    const getJob = vi.fn((tenantId: string) =>
      tenantId === "default" ? projection() : null,
    );
    installRuntime({ submitJob: vi.fn(), getJob });
    const response = await getCockpitJob(getRequest(JOB_ID), params(JOB_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(getJob).toHaveBeenCalledWith("default", JOB_ID);
  });

  it("returns 404 for a missing job", async () => {
    installRuntime({ submitJob: vi.fn(), getJob: vi.fn(() => null) });
    const response = await getCockpitJob(getRequest(JOB_ID), params(JOB_ID));
    expect(response.status).toBe(404);
  });

  it("returns 404 for a foreign-tenant job without disclosing ownership", async () => {
    const foreignJobs = new Map([["foreign", projection()]]);
    const getJob = vi.fn((tenantId: string, id: string) =>
      tenantId === "foreign" ? foreignJobs.get(id) ?? null : null,
    );
    installRuntime({ submitJob: vi.fn(), getJob });
    const response = await getCockpitJob(getRequest(JOB_ID), params(JOB_ID));
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("does not invoke execution or mutate state", async () => {
    const before = projection({ status: "RUNNING" });
    const snapshot = structuredClone(before);
    const submitJob = vi.fn();
    const getJob = vi.fn(() => before);
    installRuntime({ submitJob, getJob });

    await getCockpitJob(getRequest(JOB_ID), params(JOB_ID));

    expect(submitJob).not.toHaveBeenCalled();
    expect(before).toEqual(snapshot);
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it("returns only the safe projection contract", async () => {
    installRuntime({
      submitJob: vi.fn(),
      getJob: vi.fn(() =>
        projection({
          objective: "Visible objective",
          evidence: ["Safe evidence"],
          sanitizedError: { code: "safe_failure", message: "Safe failure" },
        }),
      ),
    });
    const response = await getCockpitJob(getRequest(JOB_ID), params(JOB_ID));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).not.toMatch(
      /credential|password|token|tenantId|requester|executor|command|shell|args|stack|worktree|repositoryPath|\/Users\//i,
    );
  });
});
