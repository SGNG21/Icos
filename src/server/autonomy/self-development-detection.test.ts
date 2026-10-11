import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { updateCandidateStatus } from "@/core/autonomy/improvement-backlog";
import { InMemoryDurableMemory } from "@/core/context/durable-memory";
import { attributionFromKey, attributionKey, type Attribution } from "@/core/budget/contracts";
import { currentAttribution } from "@/server/budget/attribution-context";
import { selfDevelopmentProposalCaps } from "@/server/budget/compose-spend";

import { CanonicalImprovementProposer } from "./canonical-improvement-proposer";
import { DurableImprovementBacklog } from "./durable-improvement-backlog";
import type { QualityFinding, QualityProbeReport } from "./eslint-quality-probe";
import {
  DETECTION_PARTITION,
  DETECTION_RECORD_TYPE,
  PROPOSAL_RECORD_TYPE,
  SelfDevelopmentDetection,
} from "./self-development-detection";

const repo = mkdtempSync(path.join(tmpdir(), "icos-detection-"));
mkdirSync(path.join(repo, "src"), { recursive: true });
writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n");
writeFileSync(path.join(repo, "src/b.ts"), "export const b = 1;\n");

const finding = (file: string, count: number): QualityFinding => ({
  key: `eslint:no-unused-vars:${file}`,
  tool: "eslint",
  file,
  rule: "no-unused-vars",
  severity: "warning",
  count,
  lines: [1, 2],
  message: "'x' is defined but never used.",
});

const report = (findings: QualityFinding[]): QualityProbeReport => ({
  tool: "eslint",
  paths: ["src"],
  filesScanned: 2,
  totalWarnings: findings.reduce((n, f) => n + f.count, 0),
  totalErrors: 0,
  distinctFindings: findings.length,
  findings,
  confinement: "bubblewrap",
  networkEnforced: true,
  durationMs: 3,
});

const proposalFor = (file: string, title = `Remove unused variables in ${file}`) =>
  JSON.stringify({
    title,
    description: `Delete the unused bindings ESLint reports in ${file}.`,
    rationale: "Unused bindings hide real dead code.",
    category: "maintainability",
    targetComponent: file,
    priority: "low",
  });

function harness(options: {
  findings?: QualityFinding[];
  complete?: (input: { user: string }) => Promise<string>;
  maxProposalsPerDay?: number;
  now?: () => Date;
  memory?: InMemoryDurableMemory;
}) {
  const memory = options.memory ?? new InMemoryDurableMemory();
  const backlog = new DurableImprovementBacklog(memory);
  const attributions: Array<Attribution | null> = [];
  const complete = vi.fn(async (input: { user: string }) => {
    attributions.push(currentAttribution());
    return options.complete ? options.complete(input) : proposalFor("src/a.ts");
  });
  const probe = { probe: vi.fn(async () => report(options.findings ?? [finding("src/a.ts", 3)])) };
  const proposer = new CanonicalImprovementProposer({
    provider: { name: "stub", complete },
    backlog,
    repoPath: repo,
    timeoutMs: 1000,
  });
  const detection = new SelfDevelopmentDetection({
    backlog,
    memory,
    probe,
    proposer,
    ...(options.maxProposalsPerDay === undefined ? {} : { maxProposalsPerDay: options.maxProposalsPerDay }),
    now: options.now ?? (() => new Date("2026-10-11T10:00:00Z")),
  });
  return { memory, backlog, complete, probe, detection, attributions };
}

async function reject(backlog: DurableImprovementBacklog, id: string) {
  const c = (await backlog.get(id))!;
  const reviewing = updateCandidateStatus(c, "under_review", "test");
  await backlog.update({ ...reviewing, updatedAt: new Date(Date.parse(c.updatedAt) + 1).toISOString() });
  const r = updateCandidateStatus((await backlog.get(id))!, "rejected", "test", "TASK_FAILED");
  await backlog.update({ ...r, updatedAt: new Date(Date.parse(c.updatedAt) + 2).toISOString() });
}

describe("SelfDevelopmentDetection — DETECT -> PRIORITIZE -> PROPOSE (decision 0076)", () => {
  it("proposes ONE grounded candidate for the top finding, metered under its own attribution", async () => {
    const { detection, backlog, memory, attributions, complete } = harness({});

    const outcome = await detection.maybePropose();

    expect(outcome.status).toBe("PROPOSED");
    const [candidate] = await backlog.list({});
    expect(candidate).toMatchObject({ status: "proposed", targetComponent: "src/a.ts", category: "maintainability" });
    /* The evidence is written by code, cited verbatim: counts, rule, file, lines. */
    expect(candidate!.rationale).toContain("Measured evidence: eslint rule `no-unused-vars` reports 3 warning(s)");
    expect(candidate!.rationale).toContain("Finding key: eslint:no-unused-vars:src/a.ts");
    expect(complete.mock.calls[0]![0].user).toContain('targetComponent MUST be exactly "src/a.ts"');
    expect(attributions).toEqual([{ selfDevelopmentProposalId: "sd-proposal-2026-10-11" }]);

    const trail = await memory.queryContextItems({ missionId: DETECTION_PARTITION, includeHistory: true });
    expect(trail.filter((i) => i.type === DETECTION_RECORD_TYPE)).toHaveLength(1);
    const proposal = JSON.parse(trail.find((i) => i.type === PROPOSAL_RECORD_TYPE)!.summary);
    expect(proposal).toMatchObject({ outcome: "PROPOSED", candidateId: candidate!.id, slot: 1 });
  });

  it("never proposes over a selectable or in-flight candidate, and never probes then", async () => {
    const { detection, backlog, probe } = harness({});
    await detection.maybePropose();
    expect(await detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "CANDIDATE_SELECTABLE" });

    const [c] = await backlog.list({});
    await backlog.update({
      ...updateCandidateStatus(c!, "under_review", "test"),
      updatedAt: new Date(Date.parse(c!.updatedAt) + 1).toISOString(),
    });
    expect(await detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "CANDIDATE_IN_FLIGHT" });
    expect(probe.probe).toHaveBeenCalledTimes(1);
  });

  it("DAILY CAP, durable: a restart the same day proposes nothing; the next day may", async () => {
    let now = new Date("2026-10-11T10:00:00Z");
    const first = harness({ now: () => now });
    const proposed = await first.detection.maybePropose();
    if (proposed.status !== "PROPOSED") throw new Error("expected a proposal");
    await reject(first.backlog, proposed.candidate.id);

    /* A "restart": new services over the same durable memory. */
    const restarted = harness({ memory: first.memory, now: () => now });
    expect(await restarted.detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "DAILY_CAP_REACHED" });
    expect(restarted.probe.probe).not.toHaveBeenCalled();
    expect(restarted.complete).not.toHaveBeenCalled();

    now = new Date("2026-10-12T00:00:01Z");
    const nextDay = harness({
      memory: first.memory,
      now: () => now,
      complete: async () => proposalFor("src/a.ts", "Second attempt on src/a.ts"),
    });
    expect((await nextDay.detection.maybePropose()).status).toBe("PROPOSED");
  });

  it("does not loop on the same failure: two failed missions on one finding move on to the next", async () => {
    let now = new Date("2026-10-11T10:00:00Z");
    const findings = [finding("src/a.ts", 5), finding("src/b.ts", 1)];
    const memory = new InMemoryDurableMemory();
    for (const [day, title] of [
      ["2026-10-11", "first"],
      ["2026-10-12", "second"],
    ] as const) {
      now = new Date(`${day}T10:00:00Z`);
      const h = harness({ memory, findings, now: () => now, complete: async () => proposalFor("src/a.ts", title) });
      const outcome = await h.detection.maybePropose();
      if (outcome.status !== "PROPOSED") throw new Error(`expected a proposal, got ${outcome.status}`);
      await reject(h.backlog, outcome.candidate.id);
    }

    now = new Date("2026-10-13T10:00:00Z");
    const third = harness({ memory, findings, now: () => now, complete: async () => proposalFor("src/b.ts") });
    const outcome = await third.detection.maybePropose();
    expect(outcome.status).toBe("PROPOSED");
    if (outcome.status === "PROPOSED") expect(outcome.finding.file).toBe("src/b.ts");

    /* With b fixed by a settled mission too, nothing is left to propose. */
    if (outcome.status !== "PROPOSED") throw new Error("unreachable");
    await third.backlog.update({ ...outcome.candidate, status: "implemented", updatedAt: "2099-01-01T00:00:00.000Z" });
    now = new Date("2026-10-14T10:00:00Z");
    const fourth = harness({ memory, findings, now: () => now });
    expect(await fourth.detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "ALL_FINDINGS_EXHAUSTED" });
    expect(fourth.complete).not.toHaveBeenCalled();
  });

  it("skips a finding a settled mission already fixed (approved candidate)", async () => {
    let now = new Date("2026-10-11T10:00:00Z");
    const findings = [finding("src/a.ts", 5), finding("src/b.ts", 1)];
    const first = harness({ findings, now: () => now });
    const outcome = await first.detection.maybePropose();
    if (outcome.status !== "PROPOSED") throw new Error("expected a proposal");
    const c = outcome.candidate;
    await first.backlog.update({ ...c, status: "approved", updatedAt: "2099-01-01T00:00:00.000Z" });
    /* `approved` is in flight for the chain; once implemented, it is settled. */
    await first.backlog.update({ ...c, status: "implemented", updatedAt: "2099-01-02T00:00:00.000Z" });

    now = new Date("2026-10-12T10:00:00Z");
    const next = harness({ memory: first.memory, findings, now: () => now, complete: async () => proposalFor("src/b.ts") });
    const again = await next.detection.maybePropose();
    expect(again.status).toBe("PROPOSED");
    if (again.status === "PROPOSED") expect(again.finding.file).toBe("src/b.ts");
  });

  it("an identical proposal is the SAME candidate (content hash): nothing is re-proposed", async () => {
    let now = new Date("2026-10-11T10:00:00Z");
    const first = harness({ now: () => now });
    const outcome = await first.detection.maybePropose();
    if (outcome.status !== "PROPOSED") throw new Error("expected a proposal");
    await reject(first.backlog, outcome.candidate.id);

    now = new Date("2026-10-12T10:00:00Z");
    const again = harness({ memory: first.memory, now: () => now });
    const replay = await again.detection.maybePropose();
    expect(replay.status).toBe("ALREADY_KNOWN");
    if (replay.status === "ALREADY_KNOWN") expect(replay.candidate.id).toBe(outcome.candidate.id);
    expect(await again.backlog.list({ status: "proposed" })).toHaveLength(0);
  });

  it("a proposal off the finding never reaches the backlog, and the failure is recorded", async () => {
    const { detection, backlog, memory, complete } = harness({ complete: async () => proposalFor("src/b.ts") });
    const outcome = await detection.maybePropose();
    expect(outcome).toEqual({ status: "FAILED", stage: "PROPOSE", reason: "AUTONOMY_PROPOSER_INVALID_OUTPUT" });
    expect(complete).toHaveBeenCalledTimes(3); /* the proposer's own shape retries, no more */
    expect(await backlog.list({})).toHaveLength(0);
    const records = (await memory.queryContextItems({ missionId: DETECTION_PARTITION, includeHistory: true })).filter((i) => i.type === PROPOSAL_RECORD_TYPE);
    expect(JSON.parse(records[0]!.summary)).toMatchObject({ outcome: "FAILED" });
  });

  it("a failed probe is recorded and proposes nothing; no finding proposes nothing", async () => {
    const failing = harness({});
    failing.probe.probe.mockRejectedValueOnce(new Error("QUALITY_PROBE_SANDBOX_UNAVAILABLE"));
    expect(await failing.detection.maybePropose()).toEqual({
      status: "FAILED",
      stage: "DETECT",
      reason: "QUALITY_PROBE_SANDBOX_UNAVAILABLE",
    });
    expect(failing.complete).not.toHaveBeenCalled();

    const clean = harness({ findings: [] });
    expect(await clean.detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "NO_FINDING" });
  });

  it("maxProposalsPerDay = 0 disables detection entirely", async () => {
    const { detection, probe } = harness({ maxProposalsPerDay: 0 });
    expect(await detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "DISABLED" });
    expect(probe.probe).not.toHaveBeenCalled();
  });
});

describe("the self-development spend attribution", () => {
  it("has its own key, last in precedence, and round-trips", () => {
    expect(attributionKey({ selfDevelopmentProposalId: "sd-proposal-2026-10-11" })).toBe(
      "self-development=sd-proposal-2026-10-11",
    );
    expect(attributionKey({ goalId: "g1", selfDevelopmentProposalId: "x" })).toBe("goal=g1");
    expect(attributionFromKey("self-development=sd-proposal-2026-10-11")).toEqual({
      selfDevelopmentProposalId: "sd-proposal-2026-10-11",
    });
  });

  it("its cap answers ONLY a pure self-development attribution", async () => {
    const caps = selfDevelopmentProposalCaps(1234);
    expect(await caps({ selfDevelopmentProposalId: "d" })).toEqual({ kind: "CAPPED", maxTotalTokens: 1234 });
    expect(await caps({ goalId: "g", selfDevelopmentProposalId: "d" })).toEqual({ kind: "CAPPED" });
    expect(await caps({ systemReviewMissionId: "m", selfDevelopmentProposalId: "d" })).toEqual({ kind: "CAPPED" });
    expect(await caps(null)).toEqual({ kind: "CAPPED" });
  });
});
