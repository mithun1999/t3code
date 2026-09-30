import type { GitStatus } from "@pierre/trees";
import type { ScmChange, ScmChangeStatus, ScmStatusResult } from "@t3tools/contracts";

/** VS Code's one-letter badges. */
export const SCM_STATUS_LETTER: Record<ScmChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
  untracked: "U",
  conflicted: "!",
};

export const SCM_STATUS_TITLE: Record<ScmChangeStatus, string> = {
  modified: "Modified",
  added: "Index Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type Changed",
  untracked: "Untracked",
  conflicted: "Conflict",
};

/** Text colour per status, matching VS Code's gitDecoration colours. */
export const SCM_STATUS_CLASS: Record<ScmChangeStatus, string> = {
  modified: "text-amber-600 dark:text-[#e2c08d]",
  added: "text-green-700 dark:text-[#81b88b]",
  deleted: "text-red-700 dark:text-[#c74e39]",
  renamed: "text-teal-700 dark:text-[#73c991]",
  copied: "text-green-700 dark:text-[#81b88b]",
  type_changed: "text-amber-600 dark:text-[#e2c08d]",
  untracked: "text-teal-700 dark:text-[#73c991]",
  conflicted: "text-red-700 dark:text-[#e4676b]",
};

const TREE_STATUS: Record<ScmChangeStatus, GitStatus> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "added",
  type_changed: "modified",
  untracked: "untracked",
  conflicted: "modified",
};

/**
 * `root` relative to the repository's top-level folder: "" when they are the
 * same, `null` when `root` is not inside it.
 */
export function rootWithinRepo(repoRoot: string, root: string): string | null {
  const repo = repoRoot.replace(/[\\/]+$/, "");
  const target = root.replace(/[\\/]+$/, "");
  if (repo === target) return "";
  return target.startsWith(`${repo}/`) ? target.slice(repo.length + 1) : null;
}

/**
 * Git status per file for the explorer, keyed by the path relative to `root`.
 * A file with changes in both the index and the working tree shows its
 * working-tree status, as in VS Code.
 */
export function explorerGitStatuses(
  status: ScmStatusResult,
  root: string,
): ReadonlyMap<string, GitStatus> {
  const result = new Map<string, GitStatus>();
  const prefix = status.repoRoot === null ? "" : rootWithinRepo(status.repoRoot, root);
  if (prefix === null) return result;
  const add = (change: ScmChange) => {
    if (prefix && !change.path.startsWith(`${prefix}/`)) return;
    result.set(
      prefix ? change.path.slice(prefix.length + 1) : change.path,
      TREE_STATUS[change.status],
    );
  };
  for (const change of status.staged) add(change);
  for (const change of status.changes) add(change);
  for (const change of status.merge) add(change);
  return result;
}

/** Splits a repo-relative path into its file name and the folder it sits in. */
export function splitChangePath(path: string): {
  readonly name: string;
  readonly directory: string;
} {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { name: path, directory: "" }
    : { name: path.slice(index + 1), directory: path.slice(0, index) };
}

export function scmChangeCount(status: ScmStatusResult | null): number {
  if (!status) return 0;
  return status.merge.length + status.staged.length + status.changes.length;
}
