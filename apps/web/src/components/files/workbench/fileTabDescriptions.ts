import type { RightPanelSurface } from "~/rightPanelStore";

function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter((segment) => segment.length > 0);
}

/**
 * What tells apart file tabs that share a title, as VS Code does: the
 * shortest trailing part of each file's folder path (its repo first, in a
 * multi-repo workspace) that no other tab of the same name has. Tabs with a
 * unique title get no description.
 */
export function fileTabDescriptions(
  surfaces: ReadonlyArray<RightPanelSurface>,
): ReadonlyMap<string, string> {
  const groups = new Map<string, Array<{ readonly id: string; readonly folders: string[] }>>();
  for (const surface of surfaces) {
    if (surface.kind !== "file" || surface.attachment) continue;
    const segments = pathSegments(surface.relativePath);
    const name = segments.at(-1) ?? surface.relativePath;
    const rootName = surface.root ? pathSegments(surface.root).at(-1) : undefined;
    const folders = [...(rootName ? [rootName] : []), ...segments.slice(0, -1)];
    const key = `${name}\0${surface.compare ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), { id: surface.id, folders }]);
  }
  const descriptions = new Map<string, string>();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      const others = entries.filter((other) => other !== entry);
      for (let depth = 1; depth <= entry.folders.length; depth += 1) {
        const label = entry.folders.slice(-depth).join("/");
        const shared = others.some((other) => other.folders.slice(-depth).join("/") === label);
        if (!shared || depth === entry.folders.length) {
          descriptions.set(entry.id, label);
          break;
        }
      }
    }
  }
  return descriptions;
}
