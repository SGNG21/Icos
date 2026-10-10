import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "./git";
import { makeRepoFixture, type RepoFixture } from "./test-fixtures";

/**
 * LE PASSAGE DE RELAIS DU COMMIT — contre du VRAI git.
 *
 * Un writer gouverné est alloué sur un HEAD DÉTACHÉ. Ce n'est pas un détail de confort :
 * avec un HEAD attaché, committer verrouille `refs/heads/<branche>` À L'INTÉRIEUR du dépôt
 * canonique, que le bac à sable du worker refuse — donc aucune écriture gouvernée ne
 * pouvait aboutir sous confinement (mesuré dans `sandbox-escape.test.ts`) — et accorder ce
 * répertoire lui donnerait le pouvoir de déplacer la branche CIBLE, soit le contournement
 * exact de la revue.
 *
 * Le contrat est donc : le worker rend un SHA, et c'est ICOS — code de confiance, hors bac
 * à sable, APRÈS vérification — qui nomme la branche gouvernée. Ces preuves portent sur les
 * deux moitiés de ce contrat, avec un vrai dépôt : ce que `git` fait réellement d'un
 * worktree détaché n'est pas quelque chose qu'un faux puisse établir.
 */
describe("le passage de relais du commit gouverné (vrai git)", () => {
  let fx: RepoFixture;
  let git: Git;

  beforeAll(() => {
    fx = makeRepoFixture();
    git = new Git(fx.master);
  });
  afterAll(() => fx.cleanup());

  /** Ce que fait le worker, et rien de plus : un commit sur un HEAD détaché. */
  /*
   * L'AUTORITÉ DE CONFIANCE commite dans le worktree (ADR 0073) : le worker y laisse des
   * fichiers et n'a aucun droit Git. Le nom dit qui agit, parce que c'est tout l'objet de la
   * décision.
   */
  const icosCommits = (tree: string, file: string) => {
    fx.write(tree, file, "travail\n");
    return fx.commit(tree, `work ${file}`);
  };

  it("ALLOUE ATTACHÉ à sa propre branche, créée à la base (ADR 0073)", async () => {
    const tree = path.join(fx.root, "w1");
    const base = await git.resolveCommit("integration/phase-7");
    await git.addWorktree(tree, "ws/w1", base);

    /* Le worktree EST sur sa branche : une seule commande, un seul état. */
    expect(fx.git(tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ws/w1");
    expect(fx.git(tree, "rev-parse", "HEAD")).toBe(base);
    expect(await git.branchExists("ws/w1")).toBe(true);
    expect(await git.resolveCommit("ws/w1")).toBe(base);
  });

  it("REFUSE une branche déjà prise : deux exécutions ne partagent jamais un nom", async () => {
    const base = await git.resolveCommit("integration/phase-7");
    await git.addWorktree(path.join(fx.root, "w2"), "ws/w2", base);
    await expect(
      git.addWorktree(path.join(fx.root, "w2-bis"), "ws/w2", base),
    ).rejects.toThrow(/GIT_FAILED/);
    /* Et l'échec ne laisse pas un worktree derrière lui. */
    expect(() => fx.git(fx.master, "rev-parse", "--verify", "ws/w2-bis")).toThrow();
  });

  /* ── ICOS_CAN_VERIFY_COMMIT / ICOS_CAN_NAME_BRANCH_AFTER_VERIFICATION ────────────────── */
  it("LA BRANCHE SUIT le commit que l'autorité de confiance a matérialisé", async () => {
    const tree = path.join(fx.root, "w3");
    const base = await git.resolveCommit("integration/phase-7");
    await git.addWorktree(tree, "ws/w3", base);

    const produced = icosCommits(tree, "src/w3/feature.ts");

    /*
     * LA BRANCHE A DÉJÀ SUIVI. Le worktree est attaché, donc le commit de l'autorité avance
     * `ws/w3` lui-même : il n'y a plus d'étape de nommage à rattraper, et donc plus de
     * fenêtre entre un commit et la référence qui le porte.
     */
    expect(await git.resolveCommit("ws/w3")).toBe(produced);
    /* Ce que vérifie ICOS avant d'intégrer : le commit descend de la base déclarée. */
    expect(await git.isAncestor(base, produced)).toBe(true);
    /*
     * ET UNE ÉCRITURE DE RÉFÉRENCE NE PEUT PLUS LA DÉPLACER : la branche est checked-out, ce
     * que le port refuse explicitement. Une branche gouvernée n'avance donc que par un commit
     * dans son propre worktree, jamais par un `update-ref` venu d'ailleurs.
     */
    await expect(git.setBranchToCommit("ws/w3", base, produced)).rejects.toThrow(
      /BRANCH_CHECKED_OUT/,
    );
    expect(await git.resolveCommit("ws/w3")).toBe(produced);
    expect(fx.git(fx.master, "show", "--name-only", "--format=", "ws/w3")).toContain(
      "src/w3/feature.ts",
    );
  });

  /* ── WRONG_ANCESTRY_REJECTED ────────────────────────────────────────────────────────── */
  it("un commit qui NE DESCEND PAS de la base déclarée est détectable, et refusé", async () => {
    const tree = path.join(fx.root, "w4");
    const base = await git.resolveCommit("integration/phase-7");
    await git.addWorktree(tree, "ws/w4", base);

    /*
     * Un commit ORPHELIN : même dépôt, même arbre de travail, aucun ancêtre commun. C'est la
     * forme qu'aurait un travail venu d'ailleurs ou d'un historique réécrit, et le nommer
     * ferait entrer dans la branche gouvernée un contenu que personne n'a basé sur ce que la
     * revue croit relire.
     */
    const orphan = execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${base}^{tree}`, "-m", "orphan"],
      { cwd: fx.master, encoding: "utf8" },
    ).trim();

    expect(await git.isAncestor(base, orphan)).toBe(false);
    /* Donc le relais refuse : la branche reste où elle était. */
    expect(await git.resolveCommit("ws/w4")).toBe(base);
  });

  /* ── le CAS protège contre une avancée concurrente ──────────────────────────────────── */
  /*
   * Le CAS reste la primitive par laquelle ICOS avance une branche qu'AUCUN worktree ne
   * détient — la remise à niveau d'une branche archivée, par exemple. Il est donc éprouvé
   * là : sur une branche sans worktree, puisque le port refuse par ailleurs de toucher une
   * branche checked-out.
   */
  it("le compare-and-swap REFUSE une valeur attendue périmée", async () => {
    const tree = path.join(fx.root, "w5");
    const base = await git.resolveCommit("integration/phase-7");
    await git.addWorktree(tree, "ws/w5", base);
    const first = icosCommits(tree, "src/w5/a.ts");
    const second = icosCommits(tree, "src/w5/b.ts");

    /* Une branche libre, posée à la base, que le CAS doit faire avancer. */
    await git.exec(["branch", "ws/w5-libre", base]);
    await git.setBranchToCommit("ws/w5-libre", first, base);
    expect(await git.resolveCommit("ws/w5-libre")).toBe(first);

    /* Un second nommage qui croit encore la branche à la base échoue, sans rien écraser. */
    await expect(git.setBranchToCommit("ws/w5-libre", second, base)).rejects.toThrow(/GIT_FAILED/);
    expect(await git.resolveCommit("ws/w5-libre")).toBe(first);
    /* Avec la valeur réelle, il aboutit : l'opération est rejouable, pas fragile. */
    await git.setBranchToCommit("ws/w5-libre", second, first);
    expect(await git.resolveCommit("ws/w5-libre")).toBe(second);
  });

  it("`branch -f` reste INTERDIT : le relais passe par un CAS, jamais par une force", async () => {
    await expect(git.exec(["branch", "-f", "ws/w1", "main"])).rejects.toThrow(/GIT_FORBIDDEN/);
  });
});
