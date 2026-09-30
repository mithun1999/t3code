/**
 * Path arithmetic for the explorer's file operations. Tree paths are what the
 * tree shows: repo-relative in a single-repo workspace, and prefixed with the
 * repo's label in a multi-repo one. Folders carry a trailing "/" in the tree.
 */

export interface RootedPath {
  /** The repo (or workspace) root the path lives in. */
  readonly root: string;
  /** Relative to `root`; "" is the root itself. */
  readonly relativePath: string;
}

/** Placeholder leaf for a file or folder being named; renders as an empty name. */
export const NEW_ENTRY_PLACEHOLDER = "​";

export function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function parentTreePath(path: string): string {
  const trimmed = stripTrailingSlash(path);
  const index = trimmed.lastIndexOf("/");
  return index < 0 ? "" : trimmed.slice(0, index);
}

export function leafName(path: string): string {
  const trimmed = stripTrailingSlash(path);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function joinTreePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

export function isPlaceholderPath(path: string): boolean {
  return leafName(path) === NEW_ENTRY_PLACEHOLDER;
}

/** A name typed into the new-entry row, minus the invisible placeholder. */
export function typedEntryName(path: string): string {
  return leafName(path).replaceAll(NEW_ENTRY_PLACEHOLDER, "").trim();
}

/**
 * Maps a tree path to its repo and repo-relative path. With labels (multi-repo),
 * the first segments name the repo; a bare label is that repo's root folder.
 */
export function resolveTreePath(
  treePath: string,
  input: {
    readonly cwd: string;
    /** Label to root, longest label first so nested labels win. */
    readonly labels: ReadonlyArray<{ readonly label: string; readonly root: string }> | null;
  },
): RootedPath | null {
  const path = stripTrailingSlash(treePath);
  if (!input.labels) return { root: input.cwd, relativePath: path };
  for (const { label, root } of input.labels) {
    if (path === label) return { root, relativePath: "" };
    if (path.startsWith(`${label}/`)) return { root, relativePath: path.slice(label.length + 1) };
  }
  return null;
}

/** The tree path of a repo-relative path. */
export function treePathFor(
  rooted: RootedPath,
  labels: ReadonlyArray<{ readonly label: string; readonly root: string }> | null,
): string | null {
  if (!labels) return rooted.relativePath;
  const label = labels.find((candidate) => candidate.root === rooted.root)?.label;
  if (label === undefined) return null;
  return rooted.relativePath ? `${label}/${rooted.relativePath}` : label;
}

/**
 * VS Code's name for a duplicate: "name copy.ext", then "name copy 2.ext" and
 * so on until the name is free.
 */
export function duplicateName(name: string, taken: (candidate: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${stem} copy${attempt === 1 ? "" : ` ${attempt}`}${extension}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Whether moving `from` into the folder `to` would put a folder inside itself. */
export function isSelfOrDescendant(from: string, to: string): boolean {
  const source = stripTrailingSlash(from);
  const target = stripTrailingSlash(to);
  return target === source || target.startsWith(`${source}/`);
}
