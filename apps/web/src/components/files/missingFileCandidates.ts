/**
 * Agents often name files relative to the folder they changed into, such as a
 * package inside a repo (`app/utils/hostApp.ts` for
 * `popups/apps/popups-editor/app/utils/hostApp.ts`). When such a path isn't at
 * the workspace root, the workspace files that end with it are the candidates,
 * as VS Code's terminal links look files up.
 */

const MAX_CANDIDATES = 20;

/** The relative path to look up, or null when it can't be one (absolute, or leaving its folder). */
export function missingFileLookupPath(relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return normalized;
}

/** Workspace files whose trailing path segments are `lookupPath`, shortest first. */
export function findMissingFileCandidates(
  paths: ReadonlyArray<string>,
  lookupPath: string,
): string[] {
  const suffix = `/${lookupPath}`;
  return [...new Set(paths)]
    .filter((path) => path !== lookupPath && path.endsWith(suffix))
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_CANDIDATES);
}
