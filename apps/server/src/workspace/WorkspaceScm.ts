// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceScm - Effect service contract for the source control view: git
 * status in VS Code's groups, staging, unstaging, discarding, committing, and
 * reading a file as of HEAD or the index.
 *
 * Paths are relative to the repository's top-level folder, which can sit above
 * the folder the client names. Git always runs with `core.quotePath=false` and
 * `--literal-pathspecs`, so paths come back unescaped and are never globs.
 * Failures carry git's own explanation, which the view shows as is.
 *
 * @module WorkspaceScm
 */
import * as NodeFSP from "node:fs/promises";

import {
  type ScmChange,
  type ScmChangeStatus,
  type ScmCommitInput,
  type ScmCommitResult,
  type ScmPathsInput,
  type ScmReadFileInput,
  type ScmReadFileResult,
  type ScmStatusInput,
  type ScmStatusResult,
  type VcsError,
  ScmError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  checkpointRefForThreadTurn,
  checkpointStartRefForThreadTurn,
} from "../checkpointing/Utils.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const SCM_GROUP_MAX_CHANGES = 5000;
const SCM_STATUS_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SCM_READ_FILE_MAX_BYTES = 1024 * 1024;
/** Commit hooks (formatters, linters, tests) can take a while. */
const SCM_COMMIT_TIMEOUT_MS = 120_000;
/** Longer pathspec lists go to git through stdin rather than the command line. */
const SCM_PATHSPEC_ARGUMENT_LIMIT = 100;
/** `ls-files` has no stdin pathspecs, so long lists are asked about in chunks. */
const SCM_LS_FILES_CHUNK_SIZE = 200;
const SCM_FAILURE_MESSAGE_MAX_LENGTH = 4000;
const GIT_GLOBAL_ARGS = ["-c", "core.quotePath=false", "--literal-pathspecs"] as const;
/** English messages for the stderr checks below; user-facing output keeps the user's locale. */
const STABLE_LOCALE_ENV = { LC_ALL: "C" } as const;

const NOT_A_REPOSITORY: ScmStatusResult = {
  isRepo: false,
  repoRoot: null,
  branch: null,
  hasCommits: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  merge: [],
  staged: [],
  changes: [],
  truncated: false,
};

/** Service tag for the source control view's git operations. */
export class WorkspaceScm extends Context.Service<
  WorkspaceScm,
  {
    /** Git status in VS Code's groups. A folder outside any repository reports `isRepo: false`. */
    readonly status: (input: ScmStatusInput) => Effect.Effect<ScmStatusResult, ScmError>;
    /** Stage the paths as they are on disk: new, changed and deleted alike. */
    readonly stage: (input: ScmPathsInput) => Effect.Effect<void, ScmError>;
    /** Put the paths' staged state back to HEAD, or out of the index before the first commit. */
    readonly unstage: (input: ScmPathsInput) => Effect.Effect<void, ScmError>;
    /**
     * Throw away working tree changes like VS Code's "Discard Changes": tracked
     * paths go back to their staged version, untracked files are deleted.
     */
    readonly discard: (input: ScmPathsInput) => Effect.Effect<void, ScmError>;
    readonly commit: (input: ScmCommitInput) => Effect.Effect<ScmCommitResult, ScmError>;
    /** A file as of HEAD or the index; `exists` is false where it has no version there. */
    readonly readFile: (input: ScmReadFileInput) => Effect.Effect<ScmReadFileResult, ScmError>;
  }
>()("t3/workspace/WorkspaceScm") {}

export interface ParsedScmStatus {
  readonly branch: string | null;
  readonly hasCommits: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly merge: ReadonlyArray<ScmChange>;
  readonly staged: ReadonlyArray<ScmChange>;
  readonly changes: ReadonlyArray<ScmChange>;
  readonly truncated: boolean;
}

const STATUS_BY_CODE: Readonly<Record<string, ScmChangeStatus>> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

/** Splits off `fieldCount` space-separated fields; the rest of the record is the path. */
function splitStatusRecord(
  record: string,
  fieldCount: number,
): { readonly fields: ReadonlyArray<string>; readonly path: string } | null {
  const fields: Array<string> = [];
  let start = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const space = record.indexOf(" ", start);
    if (space === -1) return null;
    fields.push(record.slice(start, space));
    start = space + 1;
  }
  const path = record.slice(start);
  return path.length > 0 ? { fields, path } : null;
}

/**
 * Parses `git status --porcelain=v2 -z --branch` into VS Code's groups: merge
 * conflicts, staged changes (the index column) and changes (the working tree
 * column, untracked files included). A group past `maxChangesPerGroup` is cut
 * and flagged `truncated`; so is output that was cut short, whose last record
 * is dropped.
 */
export function parseScmStatus(
  output: string,
  options: { readonly outputTruncated?: boolean; readonly maxChangesPerGroup?: number } = {},
): ParsedScmStatus {
  const maxChangesPerGroup = options.maxChangesPerGroup ?? SCM_GROUP_MAX_CHANGES;
  const records = output.split("\0");
  // Every record ends with NUL, so the tail is empty unless output was cut.
  const tail = records.pop() ?? "";
  if (!options.outputTruncated && tail.length > 0) records.push(tail);

  let truncated = options.outputTruncated === true;
  let branch: string | null = null;
  let hasCommits = true;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const merge: Array<ScmChange> = [];
  const staged: Array<ScmChange> = [];
  const changes: Array<ScmChange> = [];

  const add = (group: Array<ScmChange>, change: ScmChange) => {
    if (group.length < maxChangesPerGroup) group.push(change);
    else truncated = true;
  };
  const addSide = (
    group: Array<ScmChange>,
    code: string | undefined,
    path: string,
    originalPath: string | undefined,
  ) => {
    if (code === undefined || code === ".") return;
    add(group, {
      path,
      status: STATUS_BY_CODE[code] ?? "modified",
      ...((code === "R" || code === "C") && originalPath ? { originalPath } : {}),
    });
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# ")) {
      const header = record.slice(2);
      const space = header.indexOf(" ");
      const key = space === -1 ? header : header.slice(0, space);
      const value = space === -1 ? "" : header.slice(space + 1);
      if (key === "branch.oid") hasCommits = value !== "(initial)";
      else if (key === "branch.head") branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    switch (record[0]) {
      case "1": {
        // 1 XY sub mH mI mW hH hI path
        const parsed = splitStatusRecord(record, 8);
        if (!parsed) break;
        const xy = parsed.fields[1] ?? "..";
        addSide(staged, xy[0], parsed.path, undefined);
        addSide(changes, xy[1], parsed.path, undefined);
        break;
      }
      case "2": {
        // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
        const originalPath = records[index + 1];
        index += 1;
        const parsed = splitStatusRecord(record, 9);
        if (!parsed) break;
        const xy = parsed.fields[1] ?? "..";
        addSide(staged, xy[0], parsed.path, originalPath);
        addSide(changes, xy[1], parsed.path, originalPath);
        break;
      }
      case "u": {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const parsed = splitStatusRecord(record, 10);
        if (parsed) add(merge, { path: parsed.path, status: "conflicted" });
        break;
      }
      case "?": {
        const path = record.slice(2);
        if (path.length > 0) add(changes, { path, status: "untracked" });
        break;
      }
      default:
        // `!` ignored files, and anything a newer git adds.
        break;
    }
  }

  return { branch, hasCommits, upstream, ahead, behind, merge, staged, changes, truncated };
}

function revisionLabel(revision: ScmReadFileInput["revision"]): string {
  switch (revision) {
    case "HEAD":
      return "HEAD";
    case "index":
      return "the index";
    case "turn-before":
      return "before the turn";
    case "turn-after":
      return "after the turn";
  }
}

/**
 * The repository root as reached from `cwd`, given git's `--show-prefix` (the
 * path from the root down to `cwd`, with a trailing slash). Null when `cwd`
 * doesn't end with that path, e.g. through a symlinked folder.
 */
export function repoRootFromCwd(cwd: string, prefix: string): string | null {
  const folder = cwd.replace(/[\\/]+$/, "") || cwd;
  const inner = prefix.replace(/\/+$/, "");
  if (!inner) return folder;
  const suffix = `/${inner}`;
  return folder.endsWith(suffix) ? folder.slice(0, -suffix.length) || "/" : null;
}

/**
 * The part of a failed git command's output worth showing: stderr (or stdout,
 * where `git commit` explains itself) without hints and `fatal:` prefixes.
 */
export function gitFailureMessage(
  output: { readonly stdout: string; readonly stderr: string },
  fallback: string,
): string {
  const text = (output.stderr.trim().length > 0 ? output.stderr : output.stdout)
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("hint:"))
    .map((line) => line.replace(/^(?:fatal|error): /, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length === 0) return fallback;
  return text.length > SCM_FAILURE_MESSAGE_MAX_LENGTH
    ? `…${text.slice(-SCM_FAILURE_MESSAGE_MAX_LENGTH)}`
    : text;
}

function isNotRepositoryStderr(stderr: string): boolean {
  return /not a git repository|must be run in a work tree/i.test(stderr);
}

function processFailureMessage(cause: VcsError): string {
  switch (cause._tag) {
    case "VcsProcessSpawnError":
      return "Couldn't run git. Make sure Git is installed and the folder exists.";
    case "VcsProcessTimeoutError":
      return "Git took too long and was stopped.";
    default:
      return cause.message;
  }
}

interface GitRunOptions {
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const runGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: GitRunOptions = {},
  ) =>
    vcsProcess
      .run({
        operation: `WorkspaceScm.${operation}`,
        command: "git",
        args: [...GIT_GLOBAL_ARGS, ...args],
        cwd,
        allowNonZeroExit: true,
        outputMode: "truncate",
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) => new ScmError({ cwd, operation, message: processFailureMessage(cause), cause }),
        ),
      );

  /** Runs git and fails with its explanation when it exits non-zero. */
  const runGitChecked = Effect.fn("WorkspaceScm.runGitChecked")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    fallbackMessage: string,
    options: GitRunOptions = {},
  ) {
    const output = yield* runGit(operation, cwd, args, options);
    if (output.exitCode !== 0) {
      return yield* new ScmError({
        cwd,
        operation,
        message: gitFailureMessage(output, fallbackMessage),
      });
    }
    return output;
  });

  /** Runs a pathspec command, passing a long path list through stdin. */
  const runWithPathspecs = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    paths: ReadonlyArray<string>,
    fallbackMessage: string,
  ) =>
    paths.length > SCM_PATHSPEC_ARGUMENT_LIMIT
      ? runGitChecked(
          operation,
          cwd,
          [...args, "--pathspec-from-file=-", "--pathspec-file-nul"],
          fallbackMessage,
          { stdin: paths.join("\0") },
        )
      : runGitChecked(operation, cwd, [...args, "--", ...paths], fallbackMessage);

  /**
   * The repository's top-level folder, or null outside any repository. It is
   * spelled from `cwd` where possible (git reports the real path, so /tmp
   * would come back as /private/tmp), so clients can match it to their roots.
   */
  const resolveRepoRoot = Effect.fn("WorkspaceScm.resolveRepoRoot")(function* (
    operation: string,
    cwd: string,
  ) {
    const output = yield* runGit(
      operation,
      cwd,
      ["rev-parse", "--show-toplevel", "--show-prefix"],
      {
        env: STABLE_LOCALE_ENV,
      },
    );
    if (output.exitCode === 0) {
      const [toplevel = "", prefix = ""] = output.stdout.split(/\r?\n/);
      return repoRootFromCwd(cwd, prefix) ?? toplevel;
    }
    if (isNotRepositoryStderr(output.stderr)) {
      return null;
    }
    return yield* new ScmError({
      cwd,
      operation,
      message: gitFailureMessage(output, "Couldn't find the Git repository."),
    });
  });

  const requireRepoRoot = Effect.fn("WorkspaceScm.requireRepoRoot")(function* (
    operation: string,
    cwd: string,
  ) {
    const repoRoot = yield* resolveRepoRoot(operation, cwd);
    if (repoRoot === null) {
      return yield* new ScmError({
        cwd,
        operation,
        message: `'${cwd}' is not in a Git repository.`,
      });
    }
    return repoRoot;
  });

  const hasHeadCommit = Effect.fn("WorkspaceScm.hasHeadCommit")(function* (
    operation: string,
    repoRoot: string,
  ) {
    const output = yield* runGit(operation, repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return output.exitCode === 0;
  });

  /** Index or untracked entries (per `ls-files` flags) matching the paths. */
  const listFiles = Effect.fn("WorkspaceScm.listFiles")(function* (
    operation: string,
    repoRoot: string,
    flags: ReadonlyArray<string>,
    paths: ReadonlyArray<string>,
  ) {
    const entries: Array<string> = [];
    for (let offset = 0; offset < paths.length; offset += SCM_LS_FILES_CHUNK_SIZE) {
      const chunk = paths.slice(offset, offset + SCM_LS_FILES_CHUNK_SIZE);
      const output = yield* runGitChecked(
        operation,
        repoRoot,
        ["ls-files", "-z", ...flags, "--", ...chunk],
        "Couldn't list the files to discard.",
        { maxOutputBytes: SCM_STATUS_MAX_OUTPUT_BYTES },
      );
      entries.push(...output.stdout.split("\0").filter((entry) => entry.length > 0));
    }
    return entries;
  });

  const status: WorkspaceScm["Service"]["status"] = Effect.fn("WorkspaceScm.status")(
    function* (input) {
      const repoRoot = yield* resolveRepoRoot("status", input.cwd);
      if (repoRoot === null) {
        return NOT_A_REPOSITORY;
      }
      const output = yield* runGitChecked(
        "status",
        repoRoot,
        [
          // Without the optional index refresh, reading status doesn't write
          // .git/index, which would wake the watcher and ask for status again.
          "--no-optional-locks",
          "-c",
          "status.relativePaths=false",
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
        ],
        "Couldn't read the Git status.",
        { maxOutputBytes: SCM_STATUS_MAX_OUTPUT_BYTES },
      );
      const parsed = parseScmStatus(output.stdout, { outputTruncated: output.stdoutTruncated });
      return { isRepo: true, repoRoot, ...parsed };
    },
  );

  const stage: WorkspaceScm["Service"]["stage"] = Effect.fn("WorkspaceScm.stage")(
    function* (input) {
      const repoRoot = yield* requireRepoRoot("stage", input.cwd);
      yield* runWithPathspecs(
        "stage",
        repoRoot,
        ["add", "-A"],
        input.paths,
        "Couldn't stage the changes.",
      );
    },
  );

  const unstage: WorkspaceScm["Service"]["unstage"] = Effect.fn("WorkspaceScm.unstage")(
    function* (input) {
      const repoRoot = yield* requireRepoRoot("unstage", input.cwd);
      const args = (yield* hasHeadCommit("unstage", repoRoot))
        ? ["reset", "-q"]
        : // Before the first commit there is no HEAD to reset to.
          ["rm", "--cached", "-r", "-q", "--ignore-unmatch"];
      yield* runWithPathspecs(
        "unstage",
        repoRoot,
        args,
        input.paths,
        "Couldn't unstage the changes.",
      );
    },
  );

  const discard: WorkspaceScm["Service"]["discard"] = Effect.fn("WorkspaceScm.discard")(
    function* (input) {
      const repoRoot = yield* requireRepoRoot("discard", input.cwd);
      const tracked = yield* listFiles("discard", repoRoot, ["--cached"], input.paths);
      const untracked = yield* listFiles(
        "discard",
        repoRoot,
        ["--others", "--exclude-standard"],
        input.paths,
      );
      const matchesTracked = (requested: string) => {
        const folderPrefix = requested.endsWith("/") ? requested : `${requested}/`;
        return tracked.some((entry) => entry === requested || entry.startsWith(folderPrefix));
      };
      const restorePaths = input.paths.filter(matchesTracked);
      if (restorePaths.length > 0) {
        yield* runWithPathspecs(
          "discard",
          repoRoot,
          ["restore", "--worktree"],
          restorePaths,
          "Couldn't discard the changes.",
        );
      }

      // Untracked files have no other version to go back to.
      for (const entry of untracked) {
        const absolutePath = path.resolve(repoRoot, entry);
        const relativePath = path.relative(repoRoot, absolutePath);
        if (
          relativePath.length === 0 ||
          relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath) ||
          relativePath.split(path.sep).some((segment) => segment.toLowerCase() === ".git")
        ) {
          continue;
        }
        yield* Effect.tryPromise({
          // A trailing slash is an untracked nested repository, listed whole.
          try: () => NodeFSP.rm(absolutePath, { recursive: entry.endsWith("/"), force: true }),
          catch: (cause) =>
            new ScmError({
              cwd: input.cwd,
              operation: "discard",
              message: `Couldn't delete '${entry}': ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        });
      }
    },
  );

  const commit: WorkspaceScm["Service"]["commit"] = Effect.fn("WorkspaceScm.commit")(
    function* (input) {
      const repoRoot = yield* requireRepoRoot("commit", input.cwd);
      if (input.stageAll) {
        yield* runGitChecked("commit", repoRoot, ["add", "-A"], "Couldn't stage the changes.");
      }
      const output = yield* runGit(
        "commit",
        repoRoot,
        ["commit", "-F", "-", ...(input.amend ? ["--amend"] : [])],
        { stdin: input.message, timeoutMs: SCM_COMMIT_TIMEOUT_MS },
      );
      if (output.exitCode !== 0) {
        const nothingToCommit =
          output.stderr.trim().length === 0 &&
          /nothing (?:added )?to commit|no changes added to commit/.test(output.stdout);
        return yield* new ScmError({
          cwd: input.cwd,
          operation: "commit",
          message: nothingToCommit
            ? "There are no staged changes to commit."
            : gitFailureMessage(output, "Git couldn't create the commit."),
        });
      }
      const head = yield* runGitChecked(
        "commit",
        repoRoot,
        ["rev-parse", "HEAD"],
        "Couldn't read the new commit.",
      );
      const subject =
        input.message
          .split(/\r?\n/)
          .find((line) => line.trim().length > 0)
          ?.trim() ?? "";
      return { sha: head.stdout.trim(), subject };
    },
  );

  /**
   * The ref a read targets. A turn's "before" is the checkpoint taken when the
   * turn started (so edits made between turns stay out), or the previous
   * turn's checkpoint for threads from before those existed.
   */
  const resolveRevision = Effect.fn("WorkspaceScm.resolveRevision")(function* (
    input: ScmReadFileInput,
  ) {
    if (input.revision === "HEAD" || input.revision === "index") return input.revision;
    if (input.threadId === undefined || input.turnCount === undefined) {
      return yield* new ScmError({
        cwd: input.cwd,
        operation: "readFile",
        message: "Reading a turn's version of a file needs the thread and turn.",
      });
    }
    if (input.revision === "turn-after") {
      return checkpointRefForThreadTurn(input.threadId, input.turnCount);
    }
    const startRef = checkpointStartRefForThreadTurn(input.threadId, input.turnCount);
    const start = yield* runGit(
      "readFile",
      input.cwd,
      ["rev-parse", "--verify", "--quiet", `${startRef}^{commit}`],
      { env: STABLE_LOCALE_ENV },
    );
    return start.exitCode === 0
      ? startRef
      : checkpointRefForThreadTurn(input.threadId, Math.max(0, input.turnCount - 1));
  });

  const readFile: WorkspaceScm["Service"]["readFile"] = Effect.fn("WorkspaceScm.readFile")(
    function* (input) {
      const relativePath = input.relativePath.replace(/^(?:\.\/)+/, "");
      const revisionName = yield* resolveRevision(input);
      // `:0:` names the index entry explicitly; a bare `:` would read `1:x`
      // as merge stage 1 of `x`.
      const objectName =
        revisionName === "index" ? `:0:${relativePath}` : `${revisionName}:${relativePath}`;
      const missing: ScmReadFileResult = {
        exists: false,
        contents: "",
        binary: false,
        truncated: false,
      };

      const objectType = yield* runGit("readFile", input.cwd, ["cat-file", "-t", objectName], {
        env: STABLE_LOCALE_ENV,
      });
      if (objectType.exitCode !== 0) {
        if (isNotRepositoryStderr(objectType.stderr)) {
          return yield* new ScmError({
            cwd: input.cwd,
            operation: "readFile",
            message: `'${input.cwd}' is not in a Git repository.`,
          });
        }
        // No such path at that revision, or no commits yet.
        return missing;
      }
      // A folder or submodule at that path has no file contents to show.
      if (objectType.stdout.trim() !== "blob") {
        return missing;
      }

      const output = yield* runGitChecked(
        "readFile",
        input.cwd,
        ["show", objectName],
        `Couldn't read '${relativePath}' from ${revisionLabel(input.revision)}.`,
        { maxOutputBytes: SCM_READ_FILE_MAX_BYTES },
      );
      if (output.stdout.includes("\0")) {
        return { exists: true, contents: "", binary: true, truncated: false };
      }
      return {
        exists: true,
        contents: output.stdout,
        binary: false,
        truncated: output.stdoutTruncated,
      };
    },
  );

  return WorkspaceScm.of({ status, stage, unstage, discard, commit, readFile });
});

export const layer = Layer.effect(WorkspaceScm, make).pipe(Layer.provide(VcsProcess.layer));
