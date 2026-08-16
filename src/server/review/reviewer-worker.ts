import type { ReviewSpec, ReviewResult, ReviewCheck, ReviewVerdict } from "@/core/review";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "./ports";

/**
 * ReviewerWorker — implémente ReviewerManagerPort.
 *
 * ⚠️ STUB V1 EXPLICITE — FAIL-CLOSED (F5.1, Phase 2 hardening).
 *
 * Ce reviewer n'implémente AUCUNE vérification réelle pour les catégories
 * `tests`, `scope`, `security_boundaries`, `architecture_boundaries`,
 * `regressions` et `code_quality`. Un stub qui répondrait « PASS » sans
 * vérifier serait un tampon en blanc (rubber stamp) : c'est interdit.
 *
 * Comportement V1 : toute catégorie non réellement vérifiée échoue
 * (`passed: false`, détail « STUB »). Conséquence : une revue exigeant ces
 * catégories ne peut JAMAIS rendre PASS avec ce stub — le chemin de mission
 * autonome qui en dépend reste inerte/fail-closed (boucle de correction →
 * escalade humaine) jusqu'à l'implémentation d'une revue réelle (V2 :
 * worker de revue indépendant spawné via WorkerManager, avec évidence).
 *
 * INVARIANT : implémenteur ≠ reviewer.
 * La vérification est faite dans ensureIndependentReview().
 */
export class ReviewerWorker implements ReviewerManagerPort {
  private readonly reviewerWorkerId: string;

  constructor(reviewerWorkerId?: string) {
    this.reviewerWorkerId = reviewerWorkerId ?? "reviewer-default";
  }

  /**
   * Vérifie que le reviewer n'est pas l'implémentateur.
   *
   * Le SupervisorService passe l'ID du worker IMPLÉMENTEUR en premier
   * argument (voir supervisor-service). Fail-closed : identités vides ou
   * identiques → refus.
   */
  async ensureIndependentReview(
    implementerWorkerId: string,
    reviewerWorkerId: string,
  ): Promise<boolean> {
    if (!implementerWorkerId || !reviewerWorkerId) return false;
    return reviewerWorkerId !== implementerWorkerId;
  }

  /**
   * Conduit une revue sur le travail soumis.
   *
   * V1 : évaluation directe basée sur les critères fournis.
   * Dans un système réel, un worker de revue serait spawné.
   */
  async conductReview(spec: ReviewSpec): Promise<ReviewResult> {
    const start = Date.now();

    // NF-2 (Phase 2B) : zéro catégorie requise = configuration INVALIDE.
    // `[].every(...) === true` produirait un PASS par vacuité — interdit.
    // Défense en profondeur : le schéma impose déjà .min(1), mais ce
    // reviewer revérifie car un appelant peut construire l'objet sans
    // passer par le parse zod.
    if (spec.requiredChecks.length === 0) {
      return {
        verdict: "FAILED",
        checks: [],
        summary:
          "INVALID_CONFIGURATION — aucune catégorie de revue requise : " +
          "une revue vide ne peut jamais rendre PASS (refus fail-closed, NF-2)",
        comments:
          "requiredChecks est vide. Un ensemble non vide de catégories est " +
          "obligatoire pour qu'une revue soit valide.",
        confidence: 5,
        durationMs: Date.now() - start,
        reviewerWorkerId: this.reviewerWorkerId,
        completedAt: new Date().toISOString(),
      };
    }

    const checks: ReviewCheck[] = [];
    let allPassed = true;

    // Évaluer chaque catégorie
    for (const category of spec.requiredChecks) {
      const check = this.evaluateCategory(category, spec);
      checks.push(check);
      if (!check.passed) allPassed = false;
    }

    // NF-2 : chaque catégorie requise DOIT avoir produit exactement un
    // résultat de check. Un résultat manquant = revue incomplète = échec.
    if (checks.length !== spec.requiredChecks.length) {
      allPassed = false;
    }

    const verdict: ReviewVerdict = allPassed ? "PASS" : "CHANGES_REQUIRED";

    return {
      verdict,
      checks,
      summary: allPassed
        ? "Tous les critères de revue sont satisfaits"
        : `${checks.filter((c) => !c.passed).length} check(s) échoué(s)`,
      comments: allPassed
        ? undefined
        : checks
            .filter((c) => !c.passed)
            .map((c) => `- [${c.category}] ${c.description}${c.details ? `: ${c.details}` : ""}`)
            .join("\n"),
      confidence: allPassed ? 4 : 2,
      durationMs: Date.now() - start,
      reviewerWorkerId: this.reviewerWorkerId,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Évalue une catégorie de check.
   *
   * V1 (STUB fail-closed) : seules `acceptance_criteria` et `documentation`
   * ont une logique réelle (présence d'AC). Toute catégorie sans
   * vérification réelle ÉCHOUE explicitement — jamais de PASS non vérifié.
   */
  private evaluateCategory(category: ReviewCheck["category"], spec: ReviewSpec): ReviewCheck {
    switch (category) {
      case "acceptance_criteria":
        return {
          category,
          description: "Critères d'acceptation définis et mesurables",
          passed: spec.acceptanceCriteria.length >= 1,
          details:
            spec.acceptanceCriteria.length === 0 ? "Aucun critère d'acceptation défini" : undefined,
        };

      case "documentation":
        return {
          category,
          description: "Documentation mise à jour",
          passed: spec.acceptanceCriteria.length > 0,
          details: spec.acceptanceCriteria.length === 0 ? "Documentation insuffisante" : undefined,
        };

      case "tests":
      case "scope":
      case "security_boundaries":
      case "architecture_boundaries":
      case "regressions":
      case "code_quality":
        // STUB V1 : aucune vérification réelle implémentée pour cette
        // catégorie → échec explicite (fail-closed). Un PASS sans
        // vérification serait un tampon en blanc.
        return {
          category,
          description: `Vérification réelle non implémentée (STUB V1) — ${category}`,
          passed: false,
          details:
            "STUB fail-closed : cette catégorie exige un reviewer réel (V2). " +
            "Escalade humaine requise.",
        };

      default:
        // Catégorie inconnue : fail-closed, jamais de PASS par défaut.
        return {
          category,
          description: "Check non reconnu",
          passed: false,
          details: "Catégorie de revue inconnue — refus fail-closed",
        };
    }
  }
}

/**
 * CorrectionWorker — implémente CorrectionLoopManagerPort.
 *
 * ⚠️ STUB V1 EXPLICITE — FAIL-CLOSED (F5.1, Phase 2 hardening).
 *
 * Ce worker n'applique AUCUNE correction réelle. Prétendre « CORRECTED »
 * sans agir serait un mensonge d'état qui casse la boucle de revue.
 * V1 : toute demande de correction est ESCALADÉE vers un humain.
 * V2+ : spawner un vrai worker de correction via WorkerManager.
 */
export class CorrectionWorker implements CorrectionLoopManagerPort {
  constructor(private readonly maxAttempts: number = 3) {}

  async executeCorrection(
    spec: import("@/core/review").CorrectionSpec,
  ): Promise<import("@/core/review").CorrectionResult> {
    const start = Date.now();

    // STUB V1 fail-closed : aucune capacité de correction autonome —
    // ne JAMAIS déclarer CORRECTED sans avoir agi.
    return {
      outcome: "ESCALATED",
      summary:
        `STUB V1 — aucune correction autonome appliquée (${spec.failedChecks.length} check(s) échoué(s)). ` +
        "Escalade humaine requise.",
      durationMs: Date.now() - start,
    };
  }

  isMaxAttemptsReached(spec: import("@/core/review").CorrectionSpec): boolean {
    return spec.attemptNumber >= spec.maxAttempts;
  }

  async escalate(spec: import("@/core/review").CorrectionSpec): Promise<void> {
    // V1 : log l'escalade
    console.warn(
      `[ESCALADE] Tâche ${spec.originalTaskId} — ${spec.attemptNumber}/${spec.maxAttempts} tentatives épuisées. ` +
        `Dernière revue : ${spec.reviewComments.slice(0, 100)}`,
    );
  }
}
