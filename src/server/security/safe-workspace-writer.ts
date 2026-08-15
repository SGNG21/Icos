import { open, lstat, realpath, mkdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import { WorkspaceBoundaryError, resolveInsideWorkspace } from "./workspace-boundary";

/**
 * NF-3 (Phase 2B hardening) — Écritures race-safe dans le workspace.
 *
 * PROBLÈME (PHASE2_SECURITY_REVIEW, NF-3 MAJOR) : la validation
 * `realpath` (F4) et l'écriture `writeFile` ultérieure sont séparables par
 * un swap de symlink (TOCTOU). Un processus local peut, entre les deux,
 * remplacer un répertoire intermédiaire (ou le fichier cible) par un lien
 * symbolique pointant hors du workspace et détourner l'écriture.
 *
 * INVARIANTS (fail-closed, aucune hypothèse « hôte de confiance ») :
 *  1. La validation et l'opération d'écriture ne sont PAS séparables par
 *     un swap de symlink : l'écriture passe par un descripteur (FileHandle)
 *     dont l'identité (dev+ino) est vérifiée APRÈS ouverture.
 *  2. Le composant final est ouvert avec O_NOFOLLOW — jamais de suivi de
 *     symlink sur la cible.
 *  3. Chaque composant intermédiaire est vérifié non-symlink (lstat), et le
 *     parent est re-canonicalisé (realpath) APRÈS ouverture : un swap de
 *     répertoire intermédiaire pendant la fenêtre est détecté et l'écriture
 *     est REFUSÉE (aucun octet de contenu écrit).
 *  4. Les alias hardlink sont refusés (nlink != 1).
 *  5. Toute condition non garantie (plateforme sans O_NOFOLLOW, racine non
 *     canonique, stat incohérent) → WorkspaceBoundaryError, jamais de repli.
 *
 * LIMITE DOCUMENTÉE : si un attaquant swap un répertoire parent AVANT
 * l'ouverture, `open(..., O_CREAT)` peut créer un fichier VIDE hors du
 * workspace avant que la vérification post-open ne refuse l'écriture.
 * Aucun contenu n'est jamais écrit (zéro octet) ; le fichier vide résiduel
 * est un artefact bénin. Le supprimer serait lui-même racé (on pourrait
 * détruire un fichier légitime swappé en place) — on ne le fait pas.
 */

/**
 * Seams de test UNIQUEMENT — permettent aux tests adversariaux de simuler
 * un swap de symlink dans la fenêtre validation→open et open→vérification.
 * Jamais utilisés en production (paramètre absent).
 */
export interface SafeWriteRaceSeams {
  /** Exécuté entre la validation des composants et l'ouverture du fichier. */
  beforeOpen?: () => void | Promise<void>;
  /** Exécuté entre l'ouverture et la vérification post-open. */
  afterOpen?: () => void | Promise<void>;
}

/**
 * Écrit `content` dans `relativePath` STRICTEMENT à l'intérieur du
 * workspace canonique, de façon race-safe (voir invariants ci-dessus).
 *
 * @param canonicalWorkspaceRoot racine du workspace, DÉJÀ canonique
 *   (sortie de resolveAuthorizedWorkspace). Une racine non canonique est
 *   refusée : elle rendrait la comparaison de parents non fiable.
 * @param relativePath chemin relatif à l'intérieur du workspace.
 * @param content contenu UTF-8 à écrire.
 * @param seams seams de test uniquement (simulation de course).
 * @returns le chemin absolu du fichier écrit.
 * @throws WorkspaceBoundaryError — toujours fail-closed.
 */
export async function safeWriteFileInsideWorkspace(
  canonicalWorkspaceRoot: string,
  relativePath: string,
  content: string,
  seams?: SafeWriteRaceSeams,
): Promise<string> {
  // 0. Plateforme : sans O_NOFOLLOW, l'invariant 2 est inapplicable → refus.
  if (!fsConstants.O_NOFOLLOW) {
    throw new WorkspaceBoundaryError(
      "unsupported_platform",
      "O_NOFOLLOW indisponible sur cette plateforme — écriture race-safe impossible (refus fail-closed)",
    );
  }

  // 1. La racine DOIT être canonique et être un répertoire réel.
  let rootReal: string;
  try {
    rootReal = await realpath(canonicalWorkspaceRoot);
  } catch {
    throw new WorkspaceBoundaryError(
      "unresolvable_worktree_path",
      `Racine de workspace non résolvable : ${canonicalWorkspaceRoot}`,
    );
  }
  if (rootReal !== canonicalWorkspaceRoot) {
    throw new WorkspaceBoundaryError(
      "non_canonical_workspace_root",
      `Racine de workspace non canonique : ${canonicalWorkspaceRoot} (réel : ${rootReal}) — ` +
        "passer la sortie de resolveAuthorizedWorkspace",
    );
  }

  // 2. Validation lexicale : cible strictement à l'intérieur du workspace.
  const target = resolveInsideWorkspace(canonicalWorkspaceRoot, relativePath);
  const targetDir = path.dirname(target);

  // 3. Marche composant par composant de la racine jusqu'au parent de la
  //    cible : chaque composant doit être un répertoire NON-symlink.
  //    Les composants manquants sont créés un à un (mkdir non récursif),
  //    puis re-vérifiés par lstat (un mkdir « gagné » par un attaquant via
  //    un symlink pré-créé serait détecté par le lstat suivant).
  const relDir = path.relative(canonicalWorkspaceRoot, targetDir);
  let current = canonicalWorkspaceRoot;
  if (relDir !== "") {
    for (const component of relDir.split(path.sep)) {
      current = path.join(current, component);
      let st = await lstat(current).catch(() => null);
      if (st === null) {
        await mkdir(current).catch(() => undefined);
        st = await lstat(current).catch(() => null);
      }
      if (st === null || st.isSymbolicLink()) {
        throw new WorkspaceBoundaryError(
          "symlink_component",
          `Composant symlink (ou non vérifiable) dans le chemin d'écriture : ${current}`,
        );
      }
      if (!st.isDirectory()) {
        throw new WorkspaceBoundaryError(
          "parent_not_directory",
          `Composant non-répertoire dans le chemin d'écriture : ${current}`,
        );
      }
    }
  }

  await seams?.beforeOpen?.();

  // 4. Ouverture O_NOFOLLOW — le composant final ne peut pas être un
  //    symlink. PAS de O_TRUNC : on ne tronque qu'APRÈS vérification, pour
  //    ne jamais détruire le contenu d'un fichier qui sera refusé.
  let handle: FileHandle;
  try {
    handle = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      // macOS/Linux : O_NOFOLLOW sur un symlink final → ELOOP (EMLINK sur
      // certains BSD). C'est exactement le refus attendu.
      throw new WorkspaceBoundaryError(
        "symlink_component",
        `La cible d'écriture est un symlink (O_NOFOLLOW) : ${target}`,
      );
    }
    throw new WorkspaceBoundaryError(
      "unsafe_write_target",
      `Ouverture sûre impossible : ${target} (${code ?? String(error)})`,
    );
  }

  try {
    await seams?.afterOpen?.();

    // 5. Vérification post-open — l'identité du descripteur est comparée à
    //    ce que le chemin désigne MAINTENANT. Toute divergence = course
    //    détectée = refus (aucun octet écrit).
    const hstat = await handle.stat();
    if (!hstat.isFile()) {
      throw new WorkspaceBoundaryError(
        "unsafe_write_target",
        `La cible ouverte n'est pas un fichier régulier : ${target}`,
      );
    }
    if (hstat.nlink === 0) {
      // Le fichier ouvert a été délié (rm/rename par-dessus) pendant la
      // fenêtre : signature de course.
      throw new WorkspaceBoundaryError(
        "race_detected",
        `Course détectée : le fichier ouvert a été délié pendant la fenêtre : ${target}`,
      );
    }
    if (hstat.nlink !== 1) {
      throw new WorkspaceBoundaryError(
        "unsafe_write_target",
        `La cible a ${hstat.nlink} liens durs — alias hardlink refusé : ${target}`,
      );
    }

    const pstat = await lstat(target).catch(() => null);
    if (
      pstat === null ||
      pstat.isSymbolicLink() ||
      !pstat.isFile() ||
      pstat.dev !== hstat.dev ||
      pstat.ino !== hstat.ino
    ) {
      throw new WorkspaceBoundaryError(
        "race_detected",
        `Course détectée : le chemin ${target} ne désigne plus le fichier ouvert (swap symlink/rename)`,
      );
    }

    // Le parent doit TOUJOURS se re-canonicaliser sur lui-même : un swap de
    // répertoire intermédiaire pendant la fenêtre produirait un realpath
    // différent (hors workspace) → refus.
    const parentReal = await realpath(targetDir).catch(() => null);
    if (parentReal !== targetDir) {
      throw new WorkspaceBoundaryError(
        "race_detected",
        `Course détectée : le parent ${targetDir} ne se canonicalise plus sur lui-même` +
          (parentReal ? ` (réel : ${parentReal})` : " (non résolvable)"),
      );
    }

    // 6. Écriture À TRAVERS LE DESCRIPTEUR vérifié — un rename/swap
    //    postérieur ne peut plus détourner la destination (liée à l'inode).
    await handle.truncate(0);
    await handle.write(content, 0, "utf-8");
    return target;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
