import { describe, expect, it, vi } from "vitest";

import { createTelemetryClient, TelemetryHttpError } from "./telemetry-client";
import { telemetryFixture } from "./telemetry-fixture";

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

const signal = new AbortController().signal;

describe("createTelemetryClient", () => {
  it("lit et valide un instantané conforme, en same-origin sans cache", async () => {
    const fetchMock = respond(200, { telemetry: telemetryFixture() });
    const snapshot = await createTelemetryClient(fetchMock).fetchSnapshot(signal);
    expect(snapshot.current.cpu.cores).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cockpit/telemetry",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", signal }),
    );
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [500, "http"],
  ] as const)("classe HTTP %i en %s", async (status, kind) => {
    await expect(
      createTelemetryClient(respond(status, {})).fetchSnapshot(signal),
    ).rejects.toMatchObject({
      kind,
    });
  });

  it("rejette une réponse hors contrat (champ inconnu, ratio > 1, valeur inventée)", async () => {
    const extra = { telemetry: { ...telemetryFixture(), leaked: "x" } };
    const fixture = telemetryFixture();
    const badRatio = {
      telemetry: {
        ...fixture,
        current: {
          ...fixture.current,
          cpu: { ...fixture.current.cpu, usage: { available: true, value: 3 } },
        },
      },
    };
    const unavailableWithValue = {
      telemetry: {
        ...fixture,
        extensions: {
          ...fixture.extensions,
          tokensPerSecond: { available: false, reason: "x", value: 42 },
        },
      },
    };
    for (const body of [extra, badRatio, unavailableWithValue]) {
      await expect(
        createTelemetryClient(respond(200, body)).fetchSnapshot(signal),
      ).rejects.toMatchObject({
        kind: "invalid",
      });
    }
  });

  it("traduit une panne réseau et laisse passer l'annulation", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(createTelemetryClient(down).fetchSnapshot(signal)).rejects.toBeInstanceOf(
      TelemetryHttpError,
    );
    const aborted = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(createTelemetryClient(aborted).fetchSnapshot(signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
