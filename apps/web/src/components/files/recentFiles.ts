import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

/**
 * Files opened recently, newest first, per workspace: VS Code's editor
 * history, which ⌘P lists first.
 */
const RECENT_FILES_STORAGE_KEY = "t3code.recentFiles:v1";
const MAX_FILES_PER_WORKSPACE = 50;
const MAX_WORKSPACES = 20;

const RecentFilesSchema = Schema.Array(
  Schema.Struct({ workspace: Schema.String, paths: Schema.Array(Schema.String) }),
);
type RecentFiles = typeof RecentFilesSchema.Type;

function workspaceKey(environmentId: string, workspaceRoot: string): string {
  return `${environmentId}\u0000${workspaceRoot}`;
}

function readAll(): RecentFiles {
  try {
    return getLocalStorageItem(RECENT_FILES_STORAGE_KEY, RecentFilesSchema) ?? [];
  } catch {
    return [];
  }
}

/** Workspace-relative paths, most recently opened first. */
export function readRecentFiles(environmentId: string, workspaceRoot: string): readonly string[] {
  const key = workspaceKey(environmentId, workspaceRoot);
  return readAll().find((entry) => entry.workspace === key)?.paths ?? [];
}

export function recordRecentFile(
  environmentId: string,
  workspaceRoot: string,
  relativePath: string,
): void {
  const key = workspaceKey(environmentId, workspaceRoot);
  const all = readAll();
  const current = all.find((entry) => entry.workspace === key)?.paths ?? [];
  if (current[0] === relativePath) return;
  const paths = [relativePath, ...current.filter((path) => path !== relativePath)].slice(
    0,
    MAX_FILES_PER_WORKSPACE,
  );
  const next = [{ workspace: key, paths }, ...all.filter((entry) => entry.workspace !== key)].slice(
    0,
    MAX_WORKSPACES,
  );
  try {
    setLocalStorageItem(RECENT_FILES_STORAGE_KEY, next, RecentFilesSchema);
  } catch (error) {
    console.error(error);
  }
}
