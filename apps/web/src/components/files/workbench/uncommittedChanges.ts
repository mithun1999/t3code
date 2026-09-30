import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { workspaceIde } from "~/state/workspaceIde";

import { rootWithinRepo } from "./scmPresentation";

export interface UncommittedChange {
  /** The repository's top-level folder. */
  readonly repoRoot: string;
  /** Relative to `repoRoot`. */
  readonly path: string;
  readonly compare: "working-tree" | "staged";
}

/**
 * The first of `files` that still has uncommitted changes, as git status sees
 * it now: unstaged changes first, then staged ones. `path`s are relative to
 * their `root`, or to `workspaceRoot` when it has none.
 */
export async function findUncommittedChange(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  files: ReadonlyArray<{ readonly path: string; readonly root?: string | undefined }>,
): Promise<UncommittedChange | null> {
  for (const file of files) {
    const root = file.root ?? workspaceRoot;
    const result = await executeAtomQuery(
      appAtomRegistry,
      workspaceIde.scmStatus({ environmentId, input: { cwd: root } }),
      { reportFailure: false, reportDefect: false },
    );
    if (result._tag !== "Success" || !result.value.isRepo) continue;
    const status = result.value;
    const repoRoot = status.repoRoot ?? root;
    const prefix = rootWithinRepo(repoRoot, root);
    if (prefix === null) continue;
    const path = prefix ? `${prefix}/${file.path}` : file.path;
    const matches = (change: { readonly path: string }) => change.path === path;
    if (status.changes.some(matches) || status.merge.some(matches)) {
      return { repoRoot, path, compare: "working-tree" };
    }
    if (status.staged.some(matches)) return { repoRoot, path, compare: "staged" };
  }
  return null;
}
