import { describe, expect, it } from "vitest";

import { makeMissionContext } from "../testing/fixtures";
import { runMissionContextRepositoryContract } from "../testing/repository-contract";
import { InMemoryMissionContextRepository } from "./mission-context-repository";

describe("InMemoryMissionContextRepository — contrat partagé", () => {
  runMissionContextRepositoryContract(() => new InMemoryMissionContextRepository());
});

describe("InMemoryMissionContextRepository — spécificités backend", () => {
  it("copie défensive à l'écriture : muter l'objet source n'altère pas le stocké", async () => {
    const repo = new InMemoryMissionContextRepository();
    const context = makeMissionContext({ version: 0, confirmedConstraints: [] });

    await repo.save({ context, expectedVersion: null });
    // Mutation post-save de l'objet appelant.
    context.confirmedConstraints.push({
      id: "claim-x",
      statement: "injecté après coup",
      epistemics: "confirmed_fact",
      provenance: {
        source: "user_message",
        ref: "turn-1",
        observedAt: "2026-07-27T10:00:00.000Z",
      },
    });

    const stored = await repo.findLatest("tenant-alpha", "mission-001");
    expect(stored?.confirmedConstraints).toEqual([]);
  });

  it("copie défensive à la lecture : muter le retour n'altère pas le store", async () => {
    const repo = new InMemoryMissionContextRepository();
    await repo.save({
      context: makeMissionContext({ version: 0 }),
      expectedVersion: null,
    });

    const first = await repo.findLatest("tenant-alpha", "mission-001");
    first?.assumptions.push({
      id: "claim-y",
      statement: "mutation du lecteur",
      epistemics: "assumption",
      provenance: {
        source: "agent_message",
        ref: "turn-2",
        observedAt: "2026-07-27T10:00:00.000Z",
      },
    });

    const second = await repo.findLatest("tenant-alpha", "mission-001");
    expect(second?.assumptions).toEqual([]);
  });

  it("reset() vide le store", async () => {
    const repo = new InMemoryMissionContextRepository();
    await repo.save({
      context: makeMissionContext({ version: 0 }),
      expectedVersion: null,
    });
    repo.reset();
    expect(await repo.findLatest("tenant-alpha", "mission-001")).toBeNull();
  });
});
