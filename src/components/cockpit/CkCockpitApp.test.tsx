import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CockpitHttpClient,
  CockpitJobProjection,
  CockpitJobStatus,
} from "@/features/cockpit/clients";
import { CockpitHttpError } from "@/features/cockpit/http-clients";

import { CkCockpitApp, CockpitController } from "./CkCockpitApp";
import { CkSupervisorSurface } from "./CkSupervisorSurface";

const JOB_ID = "cockpit-job-123e4567-e89b-42d3-a456-426614174000";

function job(status: CockpitJobStatus, overrides: Partial<CockpitJobProjection> = {}) {
  return {
    jobId: JOB_ID,
    objective: "Objectif réel",
    status,
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    tasks: [],
    workers: [],
    blockers: [],
    evidence: [],
    mergePerformed: false,
    productionDeploymentPerformed: false,
    ...overrides,
  } satisfies CockpitJobProjection;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function client(
  options: {
    submitJob?: CockpitHttpClient["submitJob"];
    getJob?: CockpitHttpClient["getJob"];
  } = {},
): CockpitHttpClient {
  return {
    submitJob: options.submitJob ?? vi.fn(async () => job("QUEUED")),
    getJob: options.getJob ?? vi.fn(async () => job("SUCCEEDED")),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CkCockpitApp active path", () => {
  it("renders idle without the development fixture Mission", () => {
    const html = renderToStaticMarkup(<CkCockpitApp />);

    expect(html).toContain("Aucune mission");
    expect(html).not.toContain("Superviser la préparation locale du Cockpit V1");
    expect(html).not.toContain("Données locales simulées");
  });

  it("visibly disables the composer while submitting and polling", () => {
    for (const uiState of ["submitting", "polling"] as const) {
      const html = renderToStaticMarkup(
        <CkSupervisorSurface
          uiState={uiState}
          onSubmitObjective={() => {}}
          onRetry={() => {}}
        />,
      );
      expect(html).toContain("textarea");
      expect(html).toContain("disabled");
      expect(html).toContain("Le compositeur est désactivé");
    }
  });
});

describe("CockpitController submission", () => {
  it("forwards the exact objective with one UUID generated for the submission", async () => {
    const submitJob = vi.fn(async () => job("QUEUED"));
    const getJob = vi.fn(async () => job("SUCCEEDED"));
    const createIdempotencyKey = vi.fn(() => "uuid-once");
    const controller = new CockpitController(client({ submitJob, getJob }), {
      createIdempotencyKey,
    });
    const objective = "  Objectif exact\nnon réécrit  ";

    await controller.submit(objective);

    expect(submitJob).toHaveBeenCalledOnce();
    expect(submitJob.mock.calls[0]?.slice(0, 2)).toEqual([objective, "uuid-once"]);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
  });

  it("rejects empty input without POST", async () => {
    const submitJob = vi.fn<CockpitHttpClient["submitJob"]>();
    const controller = new CockpitController(client({ submitJob }));

    await controller.submit(" \n ");

    expect(submitJob).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      error: "Un objectif non vide est requis.",
    });
  });

  it("prevents duplicate clicks while submitting", async () => {
    const pending = deferred<CockpitJobProjection>();
    const submitJob = vi.fn(() => pending.promise);
    const controller = new CockpitController(client({ submitJob }));

    const first = controller.submit("Une mission");
    await controller.submit("Une mission");

    expect(controller.getSnapshot().phase).toBe("submitting");
    expect(submitJob).toHaveBeenCalledOnce();
    pending.resolve(job("QUEUED"));
    await first;
  });

  it("starts one GET immediately after accepted POST", async () => {
    const order: string[] = [];
    const controller = new CockpitController(
      client({
        submitJob: vi.fn(async () => {
          order.push("POST");
          return job("QUEUED");
        }),
        getJob: vi.fn(async () => {
          order.push("GET");
          return job("SUCCEEDED");
        }),
      }),
    );

    await controller.submit("Une mission");

    expect(order).toEqual(["POST", "GET"]);
    expect(controller.getSnapshot().jobId).toBe(JOB_ID);
  });

  it("prevents a second POST while the immediate read is in flight", async () => {
    const pending = deferred<CockpitJobProjection>();
    const submitJob = vi.fn(async () => job("QUEUED"));
    const getJob = vi.fn(() => pending.promise);
    const controller = new CockpitController(client({ submitJob, getJob }));

    const first = controller.submit("Première mission");
    await vi.waitFor(() => expect(getJob).toHaveBeenCalledOnce());
    await controller.submit("Deuxième mission");

    expect(submitJob).toHaveBeenCalledOnce();
    pending.resolve(job("SUCCEEDED"));
    await first;
  });

  it("reuses the same idempotency key for an explicit POST retry", async () => {
    const submitJob = vi
      .fn<CockpitHttpClient["submitJob"]>()
      .mockRejectedValueOnce(new CockpitHttpError("Réseau indisponible"))
      .mockResolvedValueOnce(job("QUEUED"));
    const controller = new CockpitController(client({ submitJob }), {
      createIdempotencyKey: () => "stable-key",
    });

    await controller.submit("Même mission");
    await controller.retry();

    expect(submitJob).toHaveBeenCalledTimes(2);
    expect(submitJob.mock.calls.map((call) => call[1])).toEqual([
      "stable-key",
      "stable-key",
    ]);
  });
});

describe("CockpitController polling", () => {
  it("polls every 1000 ms with one timer through QUEUED and RUNNING", async () => {
    vi.useFakeTimers();
    const getJob = vi
      .fn<CockpitHttpClient["getJob"]>()
      .mockResolvedValueOnce(job("QUEUED"))
      .mockResolvedValueOnce(job("RUNNING"))
      .mockResolvedValueOnce(job("SUCCEEDED"));
    const controller = new CockpitController(client({ getJob }));

    await controller.submit("Une mission");
    expect(controller.getSnapshot().snapshot?.status).toBe("QUEUED");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(getJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getSnapshot().snapshot?.status).toBe("RUNNING");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getSnapshot().phase).toBe("succeeded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["SUCCEEDED", "succeeded"],
    ["FAILED", "failed"],
    ["BLOCKED", "blocked"],
  ] as const)("maps RUNNING to %s and stops polling", async (status, phase) => {
    vi.useFakeTimers();
    const getJob = vi
      .fn<CockpitHttpClient["getJob"]>()
      .mockResolvedValueOnce(job("RUNNING"))
      .mockResolvedValueOnce(job(status));
    const controller = new CockpitController(client({ getJob }));

    await controller.submit("Une mission");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.getSnapshot().phase).toBe(phase);
    expect(controller.getSnapshot().snapshot?.status).toBe(status);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only one read in flight and creates no timer until it settles", async () => {
    vi.useFakeTimers();
    const pending = deferred<CockpitJobProjection>();
    const getJob = vi
      .fn<CockpitHttpClient["getJob"]>()
      .mockResolvedValueOnce(job("QUEUED"))
      .mockImplementationOnce(() => pending.promise);
    const controller = new CockpitController(client({ getJob }));

    await controller.submit("Une mission");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getJob).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(job("SUCCEEDED"));
    await Promise.resolve();
  });

  it("clears its timer on unmount cleanup", async () => {
    vi.useFakeTimers();
    const controller = new CockpitController(
      client({ getJob: vi.fn(async () => job("RUNNING")) }),
    );

    await controller.submit("Une mission");
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an outstanding request and ignores its stale response", async () => {
    const pending = deferred<CockpitJobProjection>();
    let signal: AbortSignal | undefined;
    const getJob = vi.fn((_jobId: string, nextSignal?: AbortSignal) => {
      signal = nextSignal;
      return pending.promise;
    });
    const controller = new CockpitController(client({ getJob }));

    const submission = controller.submit("Une mission");
    await vi.waitFor(() => expect(getJob).toHaveBeenCalledOnce());
    expect(controller.getSnapshot().phase).toBe("polling");
    controller.dispose();
    expect(signal?.aborted).toBe(true);

    pending.resolve(job("SUCCEEDED"));
    await submission;
    expect(controller.getSnapshot().phase).toBe("polling");
  });

  it("shows a network/read error and retries the same job without another POST", async () => {
    const submitJob = vi.fn(async () => job("QUEUED"));
    const getJob = vi
      .fn<CockpitHttpClient["getJob"]>()
      .mockRejectedValueOnce(new CockpitHttpError("Lecture réseau impossible"))
      .mockResolvedValueOnce(job("SUCCEEDED"));
    const controller = new CockpitController(client({ submitJob, getJob }));

    await controller.submit("Une mission");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "network-error",
      error: "Lecture réseau impossible",
      jobId: JOB_ID,
    });

    await controller.retry();
    expect(controller.getSnapshot().phase).toBe("succeeded");
    expect(getJob.mock.calls.map((call) => call[0])).toEqual([JOB_ID, JOB_ID]);
    expect(submitJob).toHaveBeenCalledOnce();
  });
});
