const FALLBACK_PATH = "/";

function decodedCandidates(candidate: string): string[] {
  const candidates = [candidate];
  let current = candidate;

  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        break;
      }
      candidates.push(decoded);
      current = decoded;
    } catch {
      return [];
    }
  }

  return candidates;
}

/** Retourne uniquement une destination locale non ambiguë. */
export function safeNextPath(candidate: string | null): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return FALLBACK_PATH;
  }

  const candidates = decodedCandidates(candidate);
  if (
    candidates.length === 0 ||
    candidates.some(
      (value) => !value.startsWith("/") || value.startsWith("//") || value.includes("\\"),
    )
  ) {
    return FALLBACK_PATH;
  }

  return candidate;
}
