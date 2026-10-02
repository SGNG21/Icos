import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  accumulateWorkerUsage,
  DEFAULT_WORKER_PROXY_BUDGET,
  decideWorkerDispatch,
  emptyWorkerUsage,
  remainingWallClockMs,
  toUsageOutcome,
} from "@/core/budget/worker-budget";

import { readCodexUsage, readHermesUsage, readWorkerUsage } from "./worker-usage";

/**
 * AUCUN WORKER EXTERNE N'ÉCHAPPE À LA COMPTABILITÉ.
 *
 * Un sous-processus facture chez son propre fournisseur et ne traverse aucune couture
 * d'ICOS : aucune réservation ne peut le borner. On lit donc sa consommation RÉELLE quand
 * il la rapporte, et on applique une borne de SUBSTITUTION quand il ne la rapporte pas —
 * sans jamais appeler la seconde une mesure.
 */

/** La forme EXACTE que Hermes écrit, relevée sur une vraie exécution. */
const HERMES_REAL = {
  estimated_cost_usd: 0.0,
  cost_status: "unknown",
  cost_source: "none",
  input_tokens: 23953,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 24003,
  api_calls: 1,
  model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  provider: "custom",
  completed: true,
};

const withUsageFile = async (contents: string) => {
  const dir = await mkdtemp(join(tmpdir(), "icos-usage-"));
  const path = join(dir, "usage.json");
  await writeFile(path, contents);
  return path;
};

describe("lecture de la consommation RÉELLE d'un worker", () => {
  it("Hermes : lit input/output/total et le modèle, depuis une vraie forme", async () => {
    const reading = await readHermesUsage(await withUsageFile(JSON.stringify(HERMES_REAL)));
    expect(reading).toEqual({
      kind: "MEASURED",
      usage: { promptTokens: 23953, completionTokens: 50, totalTokens: 24003 },
      source: "hermes:usage-file",
      model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    });
  });

  it("Hermes : le TOTAL du fournisseur prime, car il porte raisonnement et cache", async () => {
    /*
     * `input + output` ignore les tokens de raisonnement et de cache. Les charger à zéro
     * est exactement le défaut qu'une revue précédente a classé HIGH : on prend donc le
     * total rapporté dès qu'il est au moins la somme.
     */
    const reading = await readHermesUsage(
      await withUsageFile(
        JSON.stringify({ ...HERMES_REAL, input_tokens: 100, output_tokens: 10, total_tokens: 500 }),
      ),
    );
    expect(reading.kind === "MEASURED" && reading.usage.totalTokens).toBe(500);
  });

  it("Hermes : un fichier absent, illisible ou incomplet est UNMEASURED, jamais zéro", async () => {
    expect(await readHermesUsage("/chemin/absent")).toMatchObject({ kind: "UNMEASURED" });
    expect(await readHermesUsage(await withUsageFile("pas du json"))).toMatchObject({
      kind: "UNMEASURED",
    });
    expect(
      await readHermesUsage(await withUsageFile(JSON.stringify({ input_tokens: 5 }))),
    ).toMatchObject({ kind: "UNMEASURED", reason: "HERMES_USAGE_INCOMPLETE" });
  });

  it("Codex : lit le total imprimé, y compris avec une espace insécable de milliers", () => {
    /* La ligne réelle observée : « tokens used 2 118 », séparateur non-ASCII. */
    for (const line of ["tokens used 2 118", "tokens used 2 118", "tokens used: 2,118"]) {
      const reading = readCodexUsage(`codex\nPROBE_OK\n${line}\n`);
      expect(reading.kind, line).toBe("MEASURED");
      if (reading.kind === "MEASURED") expect(reading.usage.totalTokens).toBe(2118);
    }
  });

  it("Codex : la RÉPARTITION est inconnue, et on ne l'invente pas", () => {
    const reading = readCodexUsage("tokens used 2118");
    expect(reading.kind).toBe("MEASURED");
    if (reading.kind !== "MEASURED") return;
    /* Zéros EXPLICITES : seul le total est su, et seul lui sert de base. */
    expect(reading.usage.promptTokens).toBe(0);
    expect(reading.usage.completionTokens).toBe(0);
    expect(reading.usage.totalTokens).toBe(2118);
  });

  it("Codex : sans la ligne, UNMEASURED — jamais un worker gratuit", () => {
    expect(readCodexUsage("PROBE_OK")).toMatchObject({
      kind: "UNMEASURED",
      reason: "CODEX_TOKENS_ABSENT",
    });
  });

  it("un exécuteur SANS lecteur est UNMEASURED, et le dit nommément", async () => {
    expect(await readWorkerUsage({ executor: "inconnu", output: "" })).toMatchObject({
      kind: "UNMEASURED",
      reason: "NO_USAGE_READER_FOR:inconnu",
    });
  });

  it("une consommation non mesurée devient UNMETERED au journal, jamais 0", () => {
    expect(toUsageOutcome({ kind: "UNMEASURED", reason: "x" })).toEqual({
      kind: "UNMETERED",
      reason: "USAGE_ABSENT",
    });
  });
});

describe("budget de SUBSTITUTION — ce qui borne un worker muet", () => {
  it("laisse passer tant que les deux bornes tiennent", () => {
    expect(decideWorkerDispatch(emptyWorkerUsage(), DEFAULT_WORKER_PROXY_BUDGET)).toEqual({
      kind: "ALLOW",
    });
  });

  it("REFUSE au plafond de lancements : une borne qu'ICOS observe lui-même", () => {
    const used = { invocations: DEFAULT_WORKER_PROXY_BUDGET.maxInvocations, wallClockMs: 0 };
    expect(decideWorkerDispatch(used, DEFAULT_WORKER_PROXY_BUDGET)).toMatchObject({
      kind: "DENY",
      reason: "WORKER_INVOCATION_CAP",
    });
  });

  it("REFUSE au plafond d'horloge murale", () => {
    const used = { invocations: 1, wallClockMs: DEFAULT_WORKER_PROXY_BUDGET.maxWallClockMs };
    expect(decideWorkerDispatch(used, DEFAULT_WORKER_PROXY_BUDGET)).toMatchObject({
      kind: "DENY",
      reason: "WORKER_WALL_CLOCK_CAP",
    });
  });

  it("le temps RESTANT est le timeout du lancement : la borne est appliquée, pas affichée", () => {
    const used = { invocations: 1, wallClockMs: 1_000 };
    expect(remainingWallClockMs(used, DEFAULT_WORKER_PROXY_BUDGET)).toBe(
      DEFAULT_WORKER_PROXY_BUDGET.maxWallClockMs - 1_000,
    );
    expect(
      remainingWallClockMs({ invocations: 1, wallClockMs: 10 ** 9 }, DEFAULT_WORKER_PROXY_BUDGET),
    ).toBe(0);
  });

  it("un budget inexploitable REFUSE au lieu de retomber sur un défaut", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        decideWorkerDispatch(emptyWorkerUsage(), {
          ...DEFAULT_WORKER_PROXY_BUDGET,
          maxInvocations: bad,
        }),
      ).toMatchObject({ kind: "DENY", reason: "INVALID_WORKER_BUDGET" });
    }
  });

  it("accumule chaque lancement, mesuré ou non : c'est là tout l'intérêt", () => {
    let used = emptyWorkerUsage();
    used = accumulateWorkerUsage(used, { durationMs: 5_000 });
    used = accumulateWorkerUsage(used, { durationMs: 7_000 });
    expect(used).toEqual({ invocations: 2, wallClockMs: 12_000 });
  });

  it("les défauts sont de VRAIES bornes, pas des infinis déguisés", () => {
    expect(DEFAULT_WORKER_PROXY_BUDGET.maxInvocations).toBeLessThanOrEqual(50);
    expect(DEFAULT_WORKER_PROXY_BUDGET.maxWallClockMs).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
    expect(DEFAULT_WORKER_PROXY_BUDGET.maxOutputTokens).toBeGreaterThan(0);
  });
});
