/**
 * THE output contract, shared by the worker that produces a result and the reviewer that
 * judges it.
 *
 * The reviewer is told to judge ONLY from the review context and never to treat what it
 * cannot see as present. The worker used to be told nothing at all — it received the bare
 * task description — so it wrote ordinary prose, asserted conclusions it had checked but
 * not shown, and the reviewer correctly answered that nothing in the context corroborated
 * them. Two defensible positions, one missing agreement: a real run was rejected four
 * times for "no supporting artifacts are included" when the worker had never been asked
 * for any.
 *
 * So this lives in ONE place and both sides read it. Telling the worker what evidence the
 * reviewer requires is not a weakening of review — review stays as strict as it was, and
 * the worker is simply no longer judged against a rubric it was never shown.
 */
export const EXECUTION_OUTPUT_CONTRACT = [
  "Output contract (the independent reviewer applies exactly this):",
  "- Your output is the ENTIRE review context. The reviewer cannot see this machine, the",
  "  repository, your commands or your scratch files; anything you do not include does not",
  "  exist for it.",
  "- For every factual claim, include the evidence inline: the command you ran and the",
  "  relevant part of its real output, or the file path and the lines you read.",
  "- Claim no more than your evidence shows. If you checked three things, conclude about",
  "  those three and say plainly what you did not check.",
  "- Be internally consistent: do not describe the same thing two ways in one report.",
  "- State what you could not determine rather than omitting it.",
].join("\n");

/**
 * The task's own instruction, followed by the contract. Kept as a function so the ordering
 * is fixed in one place: the objective leads, the contract qualifies it.
 */
export function executionPrompt(
  objective: string,
  context: {
    /** The mission this task serves — the reviewer sees it, so the worker must too. */
    missionObjective?: string;
    /** The task's declared file scope: what it reads (read_only) or may change. */
    fileScope?: readonly string[];
    readOnly?: boolean;
  } = {},
): string {
  /*
   * N1 lab: a planned task said "the target file"; the reviewer was given the mission and
   * named the file, the worker was not — so it asked which file and was (rightly) sent back.
   * The worker now receives the same facts the reviewer judges it against.
   */
  const facts = [
    ...(context.missionObjective ? [`Mission objective: ${context.missionObjective}`] : []),
    ...(context.fileScope && context.fileScope.length > 0
      ? [
          `${context.readOnly ? "Files in scope (read only — change nothing)" : "Files you may change (nothing else)"}: ${context.fileScope.join(", ")}`,
        ]
      : []),
  ];
  const lead = facts.length > 0 ? `${objective}\n\n${facts.join("\n")}` : objective;
  return `${lead}\n\n${EXECUTION_OUTPUT_CONTRACT}`;
}
