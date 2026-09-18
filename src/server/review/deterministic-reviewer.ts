import type {
  ReviewInput,
  DeterministicReviewResult,
  ReviewDecisionRecord,
  ReviewDecision,
  RequestedChange,
} from "@/server/review/ports";
import type {
  TaskExecutionResult,
  ExecutionOutcome,
  ExecutionErrorCode,
  Finding,
  Evidence,
} from "@/core/contracts";
import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";
import { reviewDecisionRecordSchema, ReviewSeverity, ReviewerKind } from "@/core/contracts/review";
import type { MissionTask } from "@/core/mission/contracts";

/**
 * Moteur de revue déterministe (règles dures).
 * Ces règles sont AUTORITATIVES - le LLM reviewer ne peut JAMAIS les déclasser.
 */
export class DeterministicReviewer {
  /**
   * Applique les règles dures avant toute revue LLM.
   * Retourne une décision bloquante si applicable, sinon null pour continuer vers LLM.
   */
  apply(input: ReviewInput): DeterministicReviewResult {
    console.log("DeterministicReviewer.apply input:", {
      outcome: input.executionResult.outcome,
      findings: this.getAllFindings(input),
      evidence: this.getAllEvidence(input),
      missionTask: input.missionTask,
      capability: input.missionTask?.capability,
      executionResultType: typeof input.executionResult,
      executionResult: input.executionResult,
    });
    const { executionResult, missionTask } = input;
    const findings = this.getAllFindings(input);
    const evidence = this.getAllEvidence(input);
    const hardReasons: string[] = [];

    // RÈGLE 1: outcome = failure → ne peut JAMAIS être APPROVE.
    // Infrastructure/worker availability failures are retryable under the
    // deterministic execution-retry budget enforced by QualityControlService.
    if (executionResult.outcome === "failure") {
      hardReasons.push("Execution outcome is failure");
      const retryable =
        executionResult.error?.code === "WORKER_TIMEOUT" ||
        executionResult.error?.code === "WORKER_UNAVAILABLE" ||
        executionResult.error?.code === "UNKNOWN_EFFECT";
      console.log(`Returning ${retryable ? "RETRY" : "BLOCK"} due to failure`);
      return this.createBlockingDecision(
        input,
        retryable ? "RETRY" : "BLOCK",
        hardReasons,
        retryable ? "warning" : "critical",
      );
    }

    // RÈGLE 2: QA_BLOCKED → ne peut JAMAIS être APPROVE
    const hasQaBlocked = findings.some(
      (f) => f.severity === "BLOCK" && f.check.toLowerCase().includes("qa"),
    );
    if (hasQaBlocked) {
      hardReasons.push("QA gate blocked");
      console.log("Returning BLOCK due to QA blocked");
      return this.createBlockingDecision(input, "BLOCK", hardReasons, "critical");
    }


    // RÈGLE 4: High-risk ambiguous action → ESCALATE_TO_HUMAN
    if (this.isHighRiskAmbiguousAction(missionTask)) {
      hardReasons.push("High-risk ambiguous action requires human review");
      console.log("Returning ESCALATE_TO_HUMAN due to high-risk ambiguous action");
      return this.createBlockingDecision(input, "ESCALATE_TO_HUMAN", hardReasons, "critical");
    }

    // RÈGLE 9: Preuves avec contenu suspect (prompt injection) → ESCALATE_TO_HUMAN
    const hasSuspiciousContent = this.detectPromptInjection(evidence, executionResult.result);
    if (hasSuspiciousContent) {
      hardReasons.push("Potential prompt injection detected in evidence/result");
      console.log("Returning ESCALATE_TO_HUMAN due to prompt injection");
      return this.createBlockingDecision(input, "ESCALATE_TO_HUMAN", hardReasons, "critical");
    }

    // RÈGLE 9.5: Auto-approve check (based on evidence) -> if we have sufficient evidence for auto-approve then APPROVE
    const autoApproveDecision = this.checkForAutoApprove(input);
    if (autoApproveDecision) {
      console.log("Returning APPROVE from auto-approve check");
      return autoApproveDecision;
    }

    // RÈGLE 6: Finding BLOCK sans repairabilité auto → BLOCK
    const unrepairableBlocks = findings.filter(
      (f) => f.severity === "BLOCK" && f.repairability !== "auto" && f.repairability !== "content",
    );
    if (unrepairableBlocks.length > 0) {
      hardReasons.push(
        `Unrepairable block findings: ${unrepairableBlocks.map((f) => f.check).join(", ")}`,
      );
      console.log("Returning BLOCK due to unrepairable blocks");
      return this.createBlockingDecision(input, "BLOCK", hardReasons, "critical");
    }

    // RÈGLE 7: Finding BLOCK repairable → REQUEST_CHANGES
    const repairableBlocks = findings.filter(
      (f) =>
        f.severity === "BLOCK" && (f.repairability === "auto" || f.repairability === "content"),
    );
    console.log(
      "All findings:",
      JSON.stringify(findings, (_, value) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value,
      ),
    );
    console.log("Repairable blocks found:", repairableBlocks);
    if (repairableBlocks.length > 0) {
      hardReasons.push(
        `Repairable block findings: ${repairableBlocks.map((f) => f.check).join(", ")}`,
      );
      console.log("Returning REQUEST_CHANGES due to repairable blocks");
      return this.createBlockingDecision(input, "REQUEST_CHANGES", hardReasons, "warning");
    }

    // RÈGLE 8: Résultat vide pour success → REQUEST_CHANGES
    if (
      executionResult.outcome === "success" &&
      (!executionResult.result || executionResult.result.trim().length === 0)
    ) {
      hardReasons.push("Success outcome with empty result");
      console.log("Returning REQUEST_CHANGES due to empty result");
      return this.createBlockingDecision(input, "REQUEST_CHANGES", hardReasons, "warning");
    }

    // RÈGLE 9: Invalid required evidence for capability → REQUEST_CHANGES
    console.log("About to check invalid required evidence");
    const invalidEvidence = this.getInvalidRequiredEvidence(input);
    console.log("Invalid evidence:", invalidEvidence);
    if (invalidEvidence.length > 0) {
      hardReasons.push(`Invalid evidence: ${invalidEvidence.join(", ")}`);
      console.log("Returning REQUEST_CHANGES due to invalid evidence");
      return this.createBlockingDecision(input, "REQUEST_CHANGES", hardReasons, "warning");
    }

    // Aucune règle dure déclenchée → continuer vers LLM
    console.log("Returning null (proceed to LLM)");
    return {
      blockingDecision: null,
      hardReasons: [],
      proceedToLlm: true,
    };
  }

  /**
   * Check if the evidence is sufficient for an automatic APPROVE decision.
   * Returns a blocking decision with APPROVE if sufficient, otherwise null.
   */
  private checkForAutoApprove(input: ReviewInput): DeterministicReviewResult | null {
    console.log("checkForAutoApprove called with input:", {
      outcome: input.executionResult.outcome,
      findings: this.getAllFindings(input),
      evidence: this.getAllEvidence(input),
    });
    const { executionResult, findings } = input;
    const evidence = this.getAllEvidence(input);

    // Only consider auto-approve for success outcome
    if (executionResult.outcome !== "success") {
      console.log("checkForAutoApprove: outcome not success");
      return null;
    }

    // Check that findings are only PASS or WARN
    const findingsArePassOrWarn = findings.every(
      (f) => f.severity === "PASS" || f.severity === "WARN",
    );
    if (!findingsArePassOrWarn) {
      console.log("checkForAutoApprove: findings contain non-PASS/WARN");
      return null;
    }

    // Check that result is non-empty
    if (!executionResult.result || executionResult.result.trim().length === 0) {
      console.log("checkForAutoApprove: result empty");
      return null;
    }

    // Check for valid preview evidence
    if (this.isValidWebsitePreviewEvidence(evidence)) {
      console.log("checkForAutoApprove: valid preview evidence");
      return this.createBlockingDecision(
        input,
        "APPROVE",
        ["Preview evidence sufficient for auto-approval"],
        "info",
      );
    }

    // Check for valid website.qa evidence
    if (this.isValidWebsiteQaEvidence(evidence)) {
      console.log("checkForAutoApprove: valid website.qa evidence");
      return this.createBlockingDecision(
        input,
        "APPROVE",
        [
          "All required evidence present, findings are PASS/WARN, success outcome with non-empty result",
        ],
        "info",
      );
    }

    console.log("checkForAutoApprove: no sufficient evidence");
    return null;
  }

  /**
   * Check if the evidence for website.qa is sufficient for auto-approve.
   * Expected:
   *   gate-report: JSON string representing an object with:
   *     { gates: Array<{name: string, passed: boolean, severity: string}>, overall: string }
   *   qa-findings: JSON string representing an array of objects with:
   *     { severity: string, category: string, message: string }
   */
  private isValidWebsiteQaEvidence(evidence: readonly Evidence[]): boolean {
    console.log("isValidWebsiteQaEvidence called with evidence:", evidence);
    const gateReportEvidence = evidence.find((e) => e.type === "gate-report");
    const qaFindingsEvidence = evidence.find((e) => e.type === "qa-findings");
    if (!gateReportEvidence || !qaFindingsEvidence) {
      console.log("isValidWebsiteQaEvidence: missing gate-report or qa-findings evidence");
      return false;
    }

    const gateReportContent = this.getEvidenceContent(gateReportEvidence);
    const qaFindingsContent = this.getEvidenceContent(qaFindingsEvidence);
    if (gateReportContent === null || qaFindingsContent === null) {
      console.log("isValidWebsiteQaEvidence: missing content in evidence", {
        gateReportContent,
        qaFindingsContent,
      });
      return false;
    }

    let gateReportObj: any;
    let qaFindingsArr: any[];
    try {
      gateReportObj = JSON.parse(gateReportContent);
      qaFindingsArr = JSON.parse(qaFindingsContent);
    } catch (e) {
      console.log("isValidWebsiteQaEvidence: JSON parse error", e);
      return false;
    }

    console.log("isValidWebsiteQaEvidence: parsed gateReportObj:", gateReportObj);
    console.log("isValidWebsiteQaEvidence: parsed qaFindingsArr:", qaFindingsArr);

    // Validate gate-report object
    if (
      typeof gateReportObj !== "object" ||
      gateReportObj === null ||
      Array.isArray(gateReportObj) ||
      !("gates" in gateReportObj) ||
      !Array.isArray(gateReportObj.gates) ||
      !("overall" in gateReportObj) ||
      typeof gateReportObj.overall !== "string"
    ) {
      console.log("isValidWebsiteQaEvidence: invalid gate-report object");
      return false;
    }

    // Validate each gate
    for (const gate of gateReportObj.gates) {
      if (
        typeof gate !== "object" ||
        gate === null ||
        Array.isArray(gate) ||
        typeof gate.name !== "string" ||
        typeof gate.passed !== "boolean" ||
        typeof gate.severity !== "string"
      ) {
        console.log("isValidWebsiteQaEvidence: invalid gate", gate);
        return false;
      }
    }

    // Validate qa-findings array
    if (!Array.isArray(qaFindingsArr)) {
      console.log("isValidWebsiteQaEvidence: qa-findings is not an array");
      return false;
    }

    for (const finding of qaFindingsArr) {
      if (
        typeof finding !== "object" ||
        finding === null ||
        Array.isArray(finding) ||
        typeof finding.severity !== "string" ||
        typeof finding.category !== "string" ||
        typeof finding.message !== "string"
      ) {
        console.log("isValidWebsiteQaEvidence: invalid finding", finding);
        return false;
      }
    }

    console.log("isValidWebsiteQaEvidence: returning true");
    return true;
  }

  /**
   * Check if the evidence for website.preview is sufficient for auto-approve.
   * Expected:
   *   preview-metadata: JSON string representing an object with:
   *     { url: string, port: number, ready: boolean, pages: Array<{path: string, status: number}> }
   *   preview-routes: JSON string representing an array of objects with:
   *     { path: string, status: number }
   */
  private isValidWebsitePreviewEvidence(evidence: readonly Evidence[]): boolean {
    console.log("isValidWebsitePreviewEvidence called with evidence:", evidence);
    const previewMetadataEvidence = evidence.find((e) => e.type === "preview-metadata");
    const previewRoutesEvidence = evidence.find((e) => e.type === "preview-routes");
    if (!previewMetadataEvidence || !previewRoutesEvidence) {
      console.log("isValidWebsitePreviewEvidence: missing preview metadata or routes evidence");
      return false;
    }

    const previewMetadataContent = this.getEvidenceContent(previewMetadataEvidence);
    const previewRoutesContent = this.getEvidenceContent(previewRoutesEvidence);
    if (previewMetadataContent === null || previewRoutesContent === null) {
      console.log("isValidWebsitePreviewEvidence: missing content in evidence", {
        previewMetadataContent,
        previewRoutesContent,
      });
      return false;
    }

    let previewMetadataObj: any;
    let previewRoutesArr: any[];
    try {
      previewMetadataObj = JSON.parse(previewMetadataContent);
      previewRoutesArr = JSON.parse(previewRoutesContent);
    } catch (e) {
      console.log("isValidWebsitePreviewEvidence: JSON parse error", e);
      return false;
    }

    console.log("isValidWebsitePreviewEvidence: parsed previewMetadataObj:", previewMetadataObj);
    console.log("isValidWebsitePreviewEvidence: parsed previewRoutesArr:", previewRoutesArr);

    // Validate preview-metadata object
    if (
      typeof previewMetadataObj !== "object" ||
      previewMetadataObj === null ||
      Array.isArray(previewMetadataObj) ||
      typeof previewMetadataObj.url !== "string" ||
      typeof previewMetadataObj.port !== "number" ||
      typeof previewMetadataObj.ready !== "boolean" ||
      !Array.isArray(previewMetadataObj.pages)
    ) {
      console.log(
        "isValidWebsitePreviewEvidence: invalid preview metadata object",
        previewMetadataObj,
      );
      return false;
    }

    // Validate each page
    for (const page of previewMetadataObj.pages) {
      if (
        typeof page !== "object" ||
        page === null ||
        Array.isArray(page) ||
        typeof page.path !== "string" ||
        typeof page.status !== "number"
      ) {
        console.log("isValidWebsitePreviewEvidence: invalid page", page);
        return false;
      }
    }

    // Validate preview-routes array
    if (!Array.isArray(previewRoutesArr)) {
      console.log("isValidWebsitePreviewEvidence: preview routes is not an array");
      return false;
    }

    for (const route of previewRoutesArr) {
      if (
        typeof route !== "object" ||
        route === null ||
        Array.isArray(route) ||
        typeof route.path !== "string" ||
        typeof route.status !== "number"
      ) {
        console.log("isValidWebsitePreviewEvidence: invalid route", route);
        return false;
      }
    }

    console.log("isValidWebsitePreviewEvidence: returning true");
    return true;
  }

  /**
   * Détermine les types de preuves requis selon la capability.
   */
  private getRequiredEvidenceTypes(capability?: string | null): string[] {
    switch (capability) {
      case "website.qa":
        return ["gate-report", "qa-findings"];
      case "website.preview":
        return ["preview-metadata", "preview-routes"];
      case "website.build":
        return ["build-output", "build-logs"];
      case "website.heal":
        return ["healer-journal", "healer-actions"];
      default:
        return [];
    }
  }

  /**
   * Returns invalid required evidence types for the given capability.
   * If any required evidence type is missing, we return the missing types (blocking).
   * If all required evidence types are present but invalid, we return the list of required evidence types.
   */
  private getInvalidRequiredEvidence(input: ReviewInput): string[] {
    console.log("getInvalidRequiredEvidence called with capability:", input.missionTask.capability);
    const capability = input.missionTask.capability;
    const required = this.getRequiredEvidenceTypes(capability);
    if (required.length === 0) {
      console.log("No required evidence types for capability:", capability);
      return [];
    }
    const evidence = this.getAllEvidence(input);
    const presentTypes = evidence.map((e) => e.type);
    console.log("Present evidence types:", presentTypes);
    const missing = required.filter((type) => !presentTypes.includes(type));
    if (missing.length > 0) {
      console.log("Missing evidence types (blocking):", missing);
      return missing; // missing evidence -> block (REQUEST_CHANGES)
    }
    // All required types are present, now check if they are valid together
    let isValid = false;
    if (capability === "website.qa") {
      isValid = this.isValidWebsiteQaEvidence(evidence);
      console.log("isValidWebsiteQaEvidence result:", isValid);
    } else if (capability === "website.preview") {
      isValid = this.isValidWebsitePreviewEvidence(evidence);
      console.log("isValidWebsitePreviewEvidence result:", isValid);
    }
    // For other capabilities, we assume valid if types are present (we could add more validations later)
    if (!isValid) {
      console.log("Evidence is invalid, returning all required types as invalid");
      return required; // treat all as invalid
    }
    console.log("Evidence is valid, returning empty array");
    return [];
  }

  /**
   * Détection basique de prompt injection dans le contenu non-fiable.
   */
  private detectPromptInjection(evidence: readonly Evidence[], result?: string): boolean {
    const suspiciousPatterns = [
      /ignore\s+previous\s+instructions?/i,
      /disregard\s+(?:all\s+)?(?:rules?|instructions?|guidelines?)/i,
      /you\s+(?:are|must|should)\s+(?:now|always)\s+(?:ignore|approve|accept)/i,
      /system\s*:=\s*you\s+are\s+(?:an\s+)?(?:admin|reviewer|approver)/i,
      /<inject>|<prompt>|<system>/i,
      /approve\s+this\s+(?:task|execution|result)/i,
      /override\s+(?:security|policy|rules?)/i,
    ];

    const allText = [
      ...evidence.map((e) => {
        const content = this.getEvidenceContent(e);
        return content ?? "";
      }),
      result ?? "",
    ].join(" ");

    return suspiciousPatterns.some((pattern) => pattern.test(allText));
  }

  /**
   * Safely extract the content string from evidence.metadata.content.
   * Returns null if the structure is not as expected.
   */
  private getEvidenceContent(evidence: Evidence): string | null {
    if (
      evidence.metadata &&
      typeof evidence.metadata === "object" &&
      "content" in evidence.metadata &&
      typeof evidence.metadata.content === "string"
    ) {
      return evidence.metadata.content;
    }
    return null;
  }

  /**
   * Returns all evidence from both top-level evidence and executionResult.evidence.
   */
  private getAllEvidence(input: ReviewInput): Evidence[] {
    const topLevel = input.evidence ?? [];
    const execution = input.executionResult.evidence ?? [];
    return [...topLevel, ...execution];
  }

  /**
   * Returns all findings from both top-level findings and executionResult.findings.
   */
  private getAllFindings(input: ReviewInput): Finding[] {
    const topLevel = input.findings ?? [];
    const execution = input.executionResult.findings ?? [];
    return [...topLevel, ...execution];
  }

  /**
   * Détermine si une action est hautement risquée et ambiguë, nécessitant une revue humaine.
   * Selon le test, la capability "website.build" avec une description contenant "Deploy to production environment"
   * est considérée comme hautement risquée et ambiguë.
   */
  private isHighRiskAmbiguousAction(missionTask: MissionTask | undefined): boolean {
    if (!missionTask) return false;
    const { capability, description } = missionTask;
    if (
      capability === "website.build" &&
      description?.includes("Deploy to production environment")
    ) {
      return true;
    }
    return false;
  }

  /**
   * Crée une décision de revue bloquante.
   */
  private createBlockingDecision(
    input: ReviewInput,
    decision: ReviewDecision,
    reasons: string[],
    severity: ReviewSeverity,
  ): DeterministicReviewResult {
    const { missionTask, executionResult } = input;
    const id =
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const workflowId = "wf-1"; // In a real implementation, this would come from the input or be generated
    const decisionRecord: ReviewDecisionRecord = {
      id,
      workflowId,
      missionId: missionTask.missionId,
      taskId: missionTask.taskId,
      decision,
      reasons,
      severity,
      reviewerKind: "deterministic",
      humanOverridden: false,
      overriddenBy: undefined,
      requestedChanges:
        decision === "REQUEST_CHANGES"
          ? [{ field: "evidence", reason: "Please provide valid evidence", suggestion: undefined }]
          : undefined,
      evidenceRefs: this.getAllEvidence(input).map((e) => e.type),
      findingRefs: this.getAllFindings(input).map((f) => f.check),
      policyRefs: ["deterministic-rules"],
      providerMetadata: undefined,
      confidence: 1,
      createdAt: new Date().toISOString(),
    };
    // Validate the decision record against the schema
    const parsed = reviewDecisionRecordSchema.safeParse(decisionRecord);
    if (!parsed.success) {
      throw new Error(`Invalid review decision record: ${parsed.error.message}`);
    }
    return {
      blockingDecision: decisionRecord,
      hardReasons: reasons,
      proceedToLlm: false,
    };
  }
}
