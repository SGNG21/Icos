import { describe, expect, it, vi } from "vitest";

import { InMemoryImprovementBacklog } from "@/core/autonomy/improvement-backlog";
import type { PlannerCompletionProvider } from "./canonical-mission-planner";
import { CanonicalImprovementProposer } from "./canonical-improvement-proposer";

const PROPOSAL = {
  title: "Document the worker branch lifecycle",
  description: "Add a docs/ note describing when a worker branch is created, kept and reaped.",
  rationale: "The reaping rule is non-obvious and caused a real defect.",
  category: "maintainability",
  targetComponent: "docs",
  priority: "medium",
};

const provider = (complete: PlannerCompletionProvider["complete"]): PlannerCompletionProvider => ({
  name: "stub",
  complete,
});

const proposer = (complete: PlannerCompletionProvider["complete"], backlog = new InMemoryImprovementBacklog()) => ({
  backlog,
  instance: new CanonicalImprovementProposer({
    provider: provider(complete),
    backlog,
    timeoutMs: 1000,
  }),
});

describe("CanonicalImprovementProposer — ICOS deciding WHAT to improve", () => {
  it("TURNS AN INSTRUCTION INTO A DURABLE CANDIDATE, in the canonical vocabulary", async () => {
    const { backlog, instance } = proposer(async () => JSON.stringify(PROPOSAL));

    const candidate = await instance.propose("Improve ICOS autonomously.");

    /* An ordinary candidate: `proposed`, content-addressed, selectable by the existing chain. */
    expect(candidate.status).toBe("proposed");
    expect(candidate.id).toMatch(/^imp-[0-9a-f]+$/);
    expect(candidate.category).toBe("maintainability");
    expect(await backlog.get(candidate.id)).toMatchObject({ title: PROPOSAL.title });
  });

  it("IS IDEMPOTENT: the same improvement proposed twice is ONE candidate", async () => {
    const { backlog, instance } = proposer(async () => JSON.stringify(PROPOSAL));

    const first = await instance.propose("Improve ICOS autonomously.");
    const second = await instance.propose("Improve ICOS autonomously.");

    expect(second.id).toBe(first.id);
    expect(await backlog.list({})).toHaveLength(1);
  });

  it("does not overwrite a candidate the backlog has already MOVED ON from", async () => {
    const { backlog, instance } = proposer(async () => JSON.stringify(PROPOSAL));
    const first = await instance.propose("Improve ICOS autonomously.");
    await backlog.update({ ...first, status: "under_review" });

    const again = await instance.propose("Improve ICOS autonomously.");

    /* Re-proposing must never reset work already in flight back to `proposed`. */
    expect(again.status).toBe("under_review");
  });

  it("FAILS CLOSED on a proposal that is not the canonical vocabulary, after a bounded retry", async () => {
    /* `improvement` is not an ImprovementCategory. A third vocabulary is defect 30 again. */
    const complete = vi.fn(async () => JSON.stringify({ ...PROPOSAL, category: "improvement" }));
    const { backlog, instance } = proposer(complete);

    await expect(instance.propose("Improve ICOS autonomously.")).rejects.toThrow(
      "AUTONOMY_PROPOSER_INVALID_OUTPUT",
    );
    expect(complete).toHaveBeenCalledTimes(3);
    expect(await backlog.list({})).toHaveLength(0);
  });

  it("RETRIES a proposal the CANONICAL factory refuses, and never leaks its message", async () => {
    /* An agent running inside the repository reports absolute paths unless told not to. */
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ ...PROPOSAL, targetComponent: "/Users/x/icos/docs" }))
      .mockResolvedValueOnce(JSON.stringify(PROPOSAL));
    const { instance } = proposer(complete as never);

    await expect(instance.propose("Improve ICOS autonomously.")).resolves.toMatchObject({
      targetComponent: "docs",
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("RETRIES narration around the JSON, which a CLI agent produces whatever it is told", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce("Sure! Let me think about that.")
      .mockResolvedValueOnce(`Here you go:\n\`\`\`json\n${JSON.stringify(PROPOSAL)}\n\`\`\``);

    const { instance } = proposer(complete as never);

    await expect(instance.propose("Improve ICOS autonomously.")).resolves.toMatchObject({
      title: PROPOSAL.title,
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("REFUSES a proposal whose target is not in the repository", async () => {
    /*
     * An agent inspecting a checkout reports a plausible path as readily as a real one. One
     * run proposed `icos/src/core/context/context-engine.ts` for a file that lives at
     * `src/core/context/context-engine.ts`; the plan then fenced the writer out of the file
     * it was asked to change, and the gate rejected the whole run.
     */
    const backlog = new InMemoryImprovementBacklog();
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ ...PROPOSAL, targetComponent: "nope/missing.ts" }))
      .mockResolvedValueOnce(JSON.stringify({ ...PROPOSAL, targetComponent: "package.json" }));
    const instance = new CanonicalImprovementProposer({
      provider: provider(complete as never),
      backlog,
      repoPath: process.cwd(),
      timeoutMs: 1000,
    });

    await expect(instance.propose("Improve ICOS autonomously.")).resolves.toMatchObject({
      targetComponent: "package.json",
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("REFUSES a target that escapes the repository", async () => {
    const backlog = new InMemoryImprovementBacklog();
    const complete = vi.fn(async () =>
      JSON.stringify({ ...PROPOSAL, targetComponent: "../../etc/passwd" }),
    );
    const instance = new CanonicalImprovementProposer({
      provider: provider(complete as never),
      backlog,
      repoPath: process.cwd(),
      timeoutMs: 1000,
    });

    await expect(instance.propose("Improve ICOS autonomously.")).rejects.toThrow(
      "AUTONOMY_PROPOSER_INVALID_OUTPUT",
    );
  });

  it("refuses an empty instruction rather than inventing a reason to change itself", async () => {
    const complete = vi.fn();
    const { instance } = proposer(complete as never);

    await expect(instance.propose("   ")).rejects.toThrow("AUTONOMY_PROPOSER_EMPTY_INSTRUCTION");
    expect(complete).not.toHaveBeenCalled();
  });

  it("tells the proposer which changes are REFUSED, so a cycle is not wasted on one", async () => {
    let policy = "";
    const { instance } = proposer(async ({ system }) => {
      policy = system;
      return JSON.stringify(PROPOSAL);
    });
    await instance.propose("Improve ICOS autonomously.");

    expect(policy).toContain("authorization");
    expect(policy).toContain("credentials");
    /* The canonical enums, not a restatement of them. */
    expect(policy).toContain("maintainability");
    expect(policy).toContain("critical");
    /*
     * And ONLY the categories the self-modification policy allows. ICOS proposed a good
     * change under `reliability` and its own policy refused it — correctly. The policy is
     * not relaxed; the proposer is told what it may propose.
     */
    const categoryLine = policy.split("\n").find((l) => l.startsWith("category:"))!;
    expect(categoryLine).toContain("maintainability");
    expect(categoryLine).not.toContain("reliability");
    expect(categoryLine).not.toContain("security");
    expect(categoryLine).not.toContain("other");
  });
});
