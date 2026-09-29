/**
 * ASK ICOS pipeline model. The browser holds the text and nothing else: it
 * does not parse intent, pick actions or classify risk — that would be a
 * browser-side authority. Every stage past "composed" is server work (BR-17,
 * then the command bus BR-10), shown honestly as NOT CONNECTED / waiting.
 */
export const ASK_STAGES = [
  { key: "text", label: "Natural language", owner: "you" },
  { key: "intent", label: "ProposedIntent", owner: "ICOS", requirement: "BR-17" },
  { key: "action", label: "ProposedAction", owner: "ICOS", requirement: "BR-17" },
  { key: "risk", label: "Risk classification", owner: "ICOS policy", requirement: "BR-10" },
  { key: "preview", label: "Preview", owner: "cockpit" },
  { key: "confirm", label: "Confirmation (when policy requires)", owner: "you" },
  { key: "execute", label: "Execution", owner: "ICOS", requirement: "BR-10" },
  { key: "audit", label: "Audit event", owner: "ICOS", requirement: "BR-10" },
] as const;

export type StageStatus = "idle" | "ready" | "not_connected" | "waiting";

export const ASK_EXAMPLES = [
  "Pourquoi CORE3 est bloqué ?",
  "Arrête le worker qui boucle.",
  "Passe cette mission en priorité haute.",
  "Combien ICOS me coûte aujourd'hui ?",
  "Quels providers sont dégradés ?",
  "Ne lance plus de tâches NVIDIA ce soir.",
  "Quelle amélioration d'ICOS apporte le plus d'autonomie pour le moins de risque ?",
];

export const ASK_MAX_LENGTH = 2000;

/** Status of each stage after the owner submits `text`. Nothing downstream can succeed yet. */
export function askPipeline(text: string, submitted: boolean): StageStatus[] {
  const composed = text.trim().length > 0 && text.length <= ASK_MAX_LENGTH;
  return ASK_STAGES.map((stage, i) => {
    if (i === 0) return composed ? "ready" : "idle";
    if (!submitted || !composed) return "idle";
    return i === 1 ? "not_connected" : "waiting";
  });
}
