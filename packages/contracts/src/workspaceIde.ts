/**
 * Contracts for the VS Code-style explorer and source control views: file
 * operations inside a workspace root, a stream of on-disk changes, and git
 * staging, discarding and committing.
 *
 * Every input names one root (`cwd`); multi-repo workspaces call once per repo.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectEntryKind } from "./project.ts";

const WORKSPACE_PATH_MAX_LENGTH = 1024;
const WORKSPACE_BATCH_MAX_PATHS = 5000;
const SCM_COMMIT_MESSAGE_MAX_LENGTH = 20_000;

const WorkspaceRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKSPACE_PATH_MAX_LENGTH),
);
const WorkspaceRelativePaths = Schema.Array(WorkspaceRelativePath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(WORKSPACE_BATCH_MAX_PATHS),
);

// File operations

export const WorkspaceCreateEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  kind: ProjectEntryKind,
});
export type WorkspaceCreateEntryInput = typeof WorkspaceCreateEntryInput.Type;

export const WorkspaceMoveEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  fromPath: WorkspaceRelativePath,
  toPath: WorkspaceRelativePath,
});
export type WorkspaceMoveEntryInput = typeof WorkspaceMoveEntryInput.Type;

/** Copies a file or folder (recursively) to a path that must not exist yet. */
export const WorkspaceCopyEntryInput = WorkspaceMoveEntryInput;
export type WorkspaceCopyEntryInput = typeof WorkspaceCopyEntryInput.Type;

export const WorkspaceEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type WorkspaceEntryResult = typeof WorkspaceEntryResult.Type;

export const WorkspaceDeleteEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePaths: WorkspaceRelativePaths,
  /** Skip the Trash. Without it, a failed move to the Trash fails the delete. */
  permanently: Schema.Boolean,
});
export type WorkspaceDeleteEntriesInput = typeof WorkspaceDeleteEntriesInput.Type;

export const WorkspaceDeleteEntriesResult = Schema.Struct({
  trashed: Schema.Boolean,
});
export type WorkspaceDeleteEntriesResult = typeof WorkspaceDeleteEntriesResult.Type;

export const WorkspaceEntryOperationFailure = Schema.Literals([
  "outside_root",
  "not_found",
  "already_exists",
  "invalid_destination",
  "trash_unavailable",
  "operation_failed",
]);
export type WorkspaceEntryOperationFailure = typeof WorkspaceEntryOperationFailure.Type;

export class WorkspaceEntryOperationError extends Schema.TaggedError<WorkspaceEntryOperationError>()(
  "WorkspaceEntryOperationError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
    failure: WorkspaceEntryOperationFailure,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Disk changes

export const WorkspaceWatchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type WorkspaceWatchInput = typeof WorkspaceWatchInput.Type;

export const WorkspaceChangeEvent = Schema.Struct({
  /** Root-relative folders whose children changed; "" is the root itself. */
  directories: Schema.Array(Schema.String),
  /** Root-relative files that were written, created or removed. */
  files: Schema.Array(Schema.String),
  /** Git's index, HEAD or refs changed, so staged state may differ. */
  gitChanged: Schema.Boolean,
  /** Too many changes to list; refresh everything that is loaded. */
  overflow: Schema.Boolean,
  /**
   * Every changed file is ignored by git (build output, caches, logs), so git
   * status can't have changed. Absent when unknown.
   */
  ignoredOnly: Schema.optional(Schema.Boolean),
});
export type WorkspaceChangeEvent = typeof WorkspaceChangeEvent.Type;

export class WorkspaceWatchError extends Schema.TaggedError<WorkspaceWatchError>()(
  "WorkspaceWatchError",
  {
    cwd: Schema.String,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Source control

export const ScmChangeStatus = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "untracked",
  "conflicted",
]);
export type ScmChangeStatus = typeof ScmChangeStatus.Type;

export const ScmChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** The path before a rename or copy. */
  originalPath: Schema.optional(TrimmedNonEmptyString),
  status: ScmChangeStatus,
});
export type ScmChange = typeof ScmChange.Type;

export const ScmStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ScmStatusInput = typeof ScmStatusInput.Type;

export const ScmStatusResult = Schema.Struct({
  isRepo: Schema.Boolean,
  /** The repository's top-level folder; paths below are relative to it. */
  repoRoot: Schema.NullOr(Schema.String),
  /** Null when HEAD is detached. */
  branch: Schema.NullOr(Schema.String),
  /** False in a repository with no commits yet. */
  hasCommits: Schema.Boolean,
  upstream: Schema.NullOr(Schema.String),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  /** Unresolved merge conflicts ("Merge Changes" in VS Code). */
  merge: Schema.Array(ScmChange),
  staged: Schema.Array(ScmChange),
  /** Unstaged changes, untracked files included. */
  changes: Schema.Array(ScmChange),
  /** More changes than the server lists. */
  truncated: Schema.Boolean,
});
export type ScmStatusResult = typeof ScmStatusResult.Type;

export const ScmPathsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Repository-relative paths. */
  paths: WorkspaceRelativePaths,
});
export type ScmPathsInput = typeof ScmPathsInput.Type;

export const ScmCommitInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  message: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(SCM_COMMIT_MESSAGE_MAX_LENGTH),
  ),
  amend: Schema.optional(Schema.Boolean),
  /** Stage every change first (VS Code's "smart commit"). */
  stageAll: Schema.optional(Schema.Boolean),
});
export type ScmCommitInput = typeof ScmCommitInput.Type;

export const ScmCommitResult = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: Schema.String,
});
export type ScmCommitResult = typeof ScmCommitResult.Type;

export const ScmRevision = Schema.Literals(["HEAD", "index"]);
export type ScmRevision = typeof ScmRevision.Type;

export const ScmReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Repository-relative path. */
  relativePath: WorkspaceRelativePath,
  revision: ScmRevision,
});
export type ScmReadFileInput = typeof ScmReadFileInput.Type;

export const ScmReadFileResult = Schema.Struct({
  /** False when the path has no version at that revision (a new file). */
  exists: Schema.Boolean,
  contents: Schema.String,
  binary: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type ScmReadFileResult = typeof ScmReadFileResult.Type;

export class ScmError extends Schema.TaggedError<ScmError>()("ScmError", {
  cwd: Schema.String,
  operation: Schema.String,
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
