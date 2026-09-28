/**
 * Data-honesty primitive of the cockpit.
 *
 * Every operational value shown to the owner is either REAL (read from a
 * canonical ICOS source) or explicitly missing. There is no third option: the
 * UI never renders a default, an estimate or a placeholder number.
 */
export type MissingKind = "unknown" | "not_available" | "not_yet_wired";

export type Truth<T> =
  | {
      kind: "real";
      value: T;
      /** Set when the value is derived from canonical data rather than read as-is. */
      derivation?: string;
    }
  | {
      kind: MissingKind;
      reason: string;
      /** Backend requirement id in audit/cockpit-control-center/BACKEND_REQUIREMENTS.md. */
      requirement?: string;
    };

export const real = <T>(value: T, derivation?: string): Truth<T> =>
  derivation ? { kind: "real", value, derivation } : { kind: "real", value };

export const missing = <T = never>(
  kind: MissingKind,
  reason: string,
  requirement?: string,
): Truth<T> => (requirement ? { kind, reason, requirement } : { kind, reason });

export const MISSING_LABEL: Record<MissingKind, string> = {
  unknown: "UNKNOWN",
  not_available: "NOT AVAILABLE",
  not_yet_wired: "NOT YET WIRED",
};

export function isReal<T>(truth: Truth<T>): truth is Extract<Truth<T>, { kind: "real" }> {
  return truth.kind === "real";
}

/** Maps a real value, propagating a missing one untouched. */
export function mapTruth<T, U>(truth: Truth<T>, fn: (value: T) => U): Truth<U> {
  return truth.kind === "real" ? { ...truth, value: fn(truth.value) } : truth;
}
