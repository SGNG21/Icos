import { describe, expect, it, vi } from "vitest";

import { createCockpitHttpClient } from "./http-clients";

const JOB_ID = "cockpit-job-123e4567-e89b-42d3-a456-426614174000";

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: JOB_ID,
    objective: "Objectif exact",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createCockpitHttpClient", () => {
  it("POSTs the exact objective, one idempotency key and no identity fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ job: job() }, 202));
    const objective = "  Objectif exact\navec espaces  ";
    const client = createCockpitHttpClient(fetchMock);

    await client.submitJob(objective, "key-unique");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/cockpit/jobs");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": "key-unique",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ objective });
    expect(String(init?.body)).not.toMatch(
      /tenant|actor|requester|executor|credential|token|authority|repository|command/i,
    );
  });

  it("parses accepted and exact replay 202 responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ job: job() }, 202))
      .mockResolvedValueOnce(jsonResponse({ job: job() }, 202));
    const client = createCockpitHttpClient(fetchMock);

    const accepted = await client.submitJob("Objectif exact", "same-key");
    const replay = await client.submitJob("Objectif exact", "same-key");

    expect(accepted.jobId).toBe(JOB_ID);
    expect(replay).toEqual(accepted);
  });

  it("GETs a relative same-origin URL and parses every known status", async () => {
    for (const status of ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"]) {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ job: job({ status }) }));
      const result = await createCockpitHttpClient(fetchMock).getJob(JOB_ID);

      expect(result.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledWith(`/api/cockpit/jobs/${JOB_ID}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: undefined,
      });
    }
  });

  it("parses a bounded conversational terminal projection", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        job: job({
          status: "SUCCEEDED",
          requestKind: "CONVERSATION",
          finalResult: "Réponse sûre",
        }),
      }),
    );

    const result = await createCockpitHttpClient(fetchMock).getJob(JOB_ID);

    expect(result.requestKind).toBe("CONVERSATION");
    expect(result.finalResult).toBe("Réponse sûre");
    expect(result.tasks).toEqual([]);
    expect(result.workers).toEqual([]);
  });

  it("rejects malformed JSON and unknown statuses instead of inferring success", async () => {
    const malformed = vi.fn<typeof fetch>(async () => new Response("{bad-json"));
    const unknown = vi.fn<typeof fetch>(async () =>
      jsonResponse({ job: job({ status: "UNKNOWN" }) }),
    );

    await expect(createCockpitHttpClient(malformed).getJob(JOB_ID)).rejects.toThrow(
      "réponse Cockpit reçue est invalide",
    );
    await expect(createCockpitHttpClient(unknown).getJob(JOB_ID)).rejects.toThrow(
      "réponse Cockpit reçue est invalide",
    );
  });

  it("strictly rejects undeclared identity and authority fields", async () => {
    for (const field of [
      "tenantId",
      "actorId",
      "requester",
      "executor",
      "credentials",
      "authority",
      "command",
      "repositoryPath",
    ]) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ job: job({ [field]: "unsafe" }) }),
      );
      await expect(createCockpitHttpClient(fetchMock).getJob(JOB_ID)).rejects.toThrow(
        "réponse Cockpit reçue est invalide",
      );
    }
  });

  it("rejects an unknown request kind instead of inferring authority", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ job: job({ requestKind: "EXECUTE" }) }),
    );

    await expect(createCockpitHttpClient(fetchMock).getJob(JOB_ID)).rejects.toThrow(
      "réponse Cockpit reçue est invalide",
    );
  });

  it("rejects unbounded projections and impossible authority outcomes", async () => {
    for (const override of [
      { objective: "x".repeat(2_001) },
      { blockers: Array.from({ length: 101 }, () => "bounded") },
      { workers: ["x".repeat(513)] },
      { mergePerformed: true },
      { productionDeploymentPerformed: true },
    ]) {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ job: job(override) }));

      await expect(createCockpitHttpClient(fetchMock).getJob(JOB_ID)).rejects.toThrow(
        "réponse Cockpit reçue est invalide",
      );
    }
  });

  it("returns sanitized HTTP errors without reflecting response content", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: {
            message: "token=secret /Users/operator/private",
            stack: "internal stack",
          },
        },
        500,
      ),
    );

    const promise = createCockpitHttpClient(fetchMock).getJob(JOB_ID);
    await expect(promise).rejects.toThrow("HTTP 500");
    await expect(promise).rejects.not.toThrow(/secret|Users|stack/);
  });

  it("sanitizes rejected fetch errors without reflecting internal details", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("token=secret /Users/operator/private stack");
    });

    const promise = createCockpitHttpClient(fetchMock).getJob(JOB_ID);

    await expect(promise).rejects.toThrow("Impossible de contacter le service Cockpit.");
    await expect(promise).rejects.not.toThrow(/secret|Users|stack/);
  });

  it("propagates AbortSignal for POST and GET", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      jsonResponse({ job: job() }, input === "/api/cockpit/jobs" ? 202 : 200),
    );
    const client = createCockpitHttpClient(fetchMock);
    const postAbort = new AbortController();
    const getAbort = new AbortController();

    await client.submitJob("Objectif", "key", postAbort.signal);
    await client.getJob(JOB_ID, getAbort.signal);

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(postAbort.signal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(getAbort.signal);
  });
});
