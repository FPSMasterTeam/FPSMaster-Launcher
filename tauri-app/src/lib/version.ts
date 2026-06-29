// Semantic-version comparison helpers used for launcher self-update gating.
// Pure functions extracted from App.tsx.

export function normalizeSemanticVersion(input: string): number[] {
  return input
    .trim()
    .split(".")
    .map((part) => {
      const match = part.match(/\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
}

export function compareSemanticVersion(current: string, required: string): number {
  const currentParts = normalizeSemanticVersion(current);
  const requiredParts = normalizeSemanticVersion(required);
  const maxLength = Math.max(currentParts.length, requiredParts.length, 3);
  for (let index = 0; index < maxLength; index += 1) {
    const left = currentParts[index] ?? 0;
    const right = requiredParts[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

export function isLauncherVersionCompatible(
  currentLauncherVersion: string,
  minLauncherVersion?: null | string
): boolean {
  const required = (minLauncherVersion ?? "").trim();
  if (!required) {
    return true;
  }
  return compareSemanticVersion(currentLauncherVersion, required) >= 0;
}
