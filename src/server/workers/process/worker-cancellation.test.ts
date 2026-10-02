import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runNonInteractive } from "./run-process";

/**
 * ANNULATION ET ORPHELINS — un worker tué doit VRAIMENT mourir, avec ses enfants.
 *
 * ── LE DÉFAUT, REPRODUIT AVANT D'ÊTRE CORRIGÉ ───────────────────────────────────────────
 * `child.kill()` ne visait que l'enfant DIRECT. Un worker qui ignore SIGTERM et lance son
 * propre sous-processus laissait donc celui-ci vivant ; et comme le petit-enfant hérite des
 * tuyaux stdout/stderr, l'évènement `close` n'arrivait jamais et la promesse ne se
 * résolvait PLUS DU TOUT.
 *
 * Mesuré avant correction : le runner n'a jamais rendu la main, et deux `sleep` ont survécu.
 * C'est exactement le « hang » que l'en-tête de `run-process.ts` déclarait empêcher — « a
 * hang is worse than a failure: it holds a capacity slot and never yields a verdict » — et
 * il ne l'empêchait pas. Un worker non annulable rend toute récupération de tâche illusoire.
 */

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "icos-cancel-"));
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

/** `pid 0` = le fichier n'existe pas ; un pid mort lève, un pid vivant ne lève pas. */
const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("annulation d'un worker — l'arbre entier, pas seulement le processus", () => {
  it("un dépassement de délai REND LA MAIN, même sur un worker qui ignore SIGTERM", async () => {
    const started = Date.now();
    const result = await runNonInteractive({
      command: "/bin/sh",
      /* `trap '' TERM` : le worker refuse de coopérer. C'est le cas qui bloquait. */
      args: ["-c", "trap '' TERM; sleep 60"],
      cwd: workspace,
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    /* Rendu bien avant les 60 s : la promesse se résout, elle ne s'éternise pas. */
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("ne laisse AUCUN ORPHELIN : le petit-enfant meurt avec le worker", async () => {
    const pidFile = join(workspace, "enfant.pid");
    const result = await runNonInteractive({
      command: "/bin/sh",
      args: ["-c", `trap '' TERM; (sleep 60 & echo $! > ${pidFile}); sleep 60`],
      cwd: workspace,
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);

    /* Petite attente : la mort du groupe n'est pas instantanée pour l'observateur. */
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "0")).trim());
    expect(pid).toBeGreaterThan(0); // le petit-enfant a bien existé
    /* LA propriété : il n'a pas survécu à son parent. Avant le correctif : il survivait. */
    expect(isAlive(pid)).toBe(false);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }, 30_000);

  it("un worker qui termine NORMALEMENT garde toute sa sortie", async () => {
    /*
     * La sur-correction à éviter : conclure sur `exit` sans fenêtre de drainage couperait
     * la fin de la sortie d'un worker sain. Ce test est le garde-fou de l'autre.
     */
    const result = await runNonInteractive({
      command: "/bin/sh",
      args: ["-c", "for i in 1 2 3 4 5; do echo ligne-$i; done"],
      cwd: workspace,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim().split("\n")).toEqual([
      "ligne-1",
      "ligne-2",
      "ligne-3",
      "ligne-4",
      "ligne-5",
    ]);
  }, 20_000);

  it("un exécutable introuvable est un RÉSULTAT, pas une promesse rejetée", async () => {
    /* Une seule forme à interpréter : un appelant n'a pas deux chemins d'échec. */
    const result = await runNonInteractive({
      command: "/bin/binaire-qui-nexiste-pas",
      args: [],
      cwd: workspace,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 15_000);
});
