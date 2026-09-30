// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceEntryOperations - Effect service contract for the explorer's file
 * operations: create, rename and move, copy, and delete to the Trash or for
 * good.
 *
 * Every path stays inside the workspace root, symlinked folders included, and
 * neither the root itself nor anything inside `.git` can be touched. Failures
 * carry a message the explorer shows as is.
 *
 * @module WorkspaceEntryOperations
 */
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import {
  type WorkspaceCopyEntryInput,
  type WorkspaceCreateEntryInput,
  type WorkspaceDeleteEntriesInput,
  type WorkspaceDeleteEntriesResult,
  type WorkspaceEntryOperationFailure,
  type WorkspaceEntryResult,
  type WorkspaceMoveEntryInput,
  WorkspaceEntryOperationError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import { isPathWithinRoot, realPathThroughMissingTail } from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

/** Gives up finding a free name in the Trash after this many tries. */
const TRASH_NAME_ATTEMPTS = 100;

/** Service tag for workspace file and folder operations. */
export class WorkspaceEntryOperations extends Context.Service<
  WorkspaceEntryOperations,
  {
    /**
     * Create an empty file or a folder. Missing parent folders are created, so
     * a nested path like `a/b/c.ts` works.
     */
    readonly createEntry: (
      input: WorkspaceCreateEntryInput,
    ) => Effect.Effect<WorkspaceEntryResult, WorkspaceEntryOperationError>;
    /**
     * Rename or move a file or folder to a path that doesn't exist yet. A
     * rename that only changes letter case is allowed.
     */
    readonly moveEntry: (
      input: WorkspaceMoveEntryInput,
    ) => Effect.Effect<WorkspaceEntryResult, WorkspaceEntryOperationError>;
    /** Copy a file or folder (recursively) to a path that doesn't exist yet. */
    readonly copyEntry: (
      input: WorkspaceCopyEntryInput,
    ) => Effect.Effect<WorkspaceEntryResult, WorkspaceEntryOperationError>;
    /**
     * Move files and folders to the Trash, or delete them for good with
     * `permanently`. Paths that are already gone are skipped. When any entry
     * can't go to the Trash, nothing is moved and the delete fails with
     * `trash_unavailable`.
     */
    readonly deleteEntries: (
      input: WorkspaceDeleteEntriesInput,
    ) => Effect.Effect<WorkspaceDeleteEntriesResult, WorkspaceEntryOperationError>;
  }
>()("t3/workspace/WorkspaceEntryOperations") {}

interface ResolvedRoot {
  readonly root: string;
  readonly realRoot: string;
}

interface ResolvedEntry {
  /** Normalized, root-relative, `/`-separated. */
  readonly relativePath: string;
  /** The entry's path under its parent folder's real path. */
  readonly absolutePath: string;
  readonly name: string;
}

interface ExistingEntry {
  readonly entry: ResolvedEntry;
  readonly stat: NodeFS.Stats;
}

interface OperationContext {
  readonly cwd: string;
  readonly entry: ResolvedEntry;
  /** Completes "Couldn't … 'name'", e.g. "rename" or "move to the Trash". */
  readonly verb: string;
}

/** A failed `node:fs` call, held until it becomes an error the explorer can show. */
class FileSystemCallError extends Data.TaggedError("FileSystemCallError")<{
  readonly cause: unknown;
}> {}

function rawCause(cause: unknown): unknown {
  return cause instanceof FileSystemCallError ? cause.cause : cause;
}

function errnoCode(value: unknown): string | undefined {
  const cause = rawCause(value);
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : undefined;
}

/** A short reason for a failed file system call, without the absolute paths Node's messages carry. */
function describeFileSystemFailure(value: unknown): string {
  const cause = rawCause(value);
  const code = errnoCode(cause);
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EBUSY":
      return "it is in use";
    case "ENOSPC":
      return "the disk is full";
    case "EROFS":
      return "the disk is read-only";
    case "ENAMETOOLONG":
      return "the name is too long";
    case "ENOTEMPTY":
      return "the folder is not empty";
    case "ENOTDIR":
      return "part of the path is a file, not a folder";
    case "EISDIR":
      return "it is a folder";
    case "ELOOP":
      return "too many symbolic links";
    case "EINVAL":
      return "the name is not valid";
    case "EXDEV":
      return "it is on a different drive";
    case undefined:
      return cause instanceof Error && cause.message.trim().length > 0
        ? cause.message.trim()
        : "unknown error";
    default:
      return code;
  }
}

function entryError(
  cwd: string,
  relativePath: string,
  failure: WorkspaceEntryOperationFailure,
  message: string,
  cause?: unknown,
): WorkspaceEntryOperationError {
  return new WorkspaceEntryOperationError({
    cwd,
    relativePath,
    failure,
    message,
    ...(cause === undefined ? {} : { cause: rawCause(cause) }),
  });
}

function operationFailed(context: OperationContext, cause: unknown) {
  return entryError(
    context.cwd,
    context.entry.relativePath,
    "operation_failed",
    `Couldn't ${context.verb} '${context.entry.name}': ${describeFileSystemFailure(cause)}.`,
    cause,
  );
}

function alreadyExists(cwd: string, entry: ResolvedEntry, cause?: unknown) {
  return entryError(
    cwd,
    entry.relativePath,
    "already_exists",
    `A file or folder '${entry.name}' already exists at this location.`,
    cause,
  );
}

function trashUnavailable(cwd: string, entry: ResolvedEntry, reason: string, cause?: unknown) {
  return entryError(
    cwd,
    entry.relativePath,
    "trash_unavailable",
    `Couldn't move '${entry.name}' to the Trash: ${reason}.`,
    cause,
  );
}

function hasGitSegment(relativePath: string): boolean {
  // Case-insensitive, since `.GIT` is the same folder on macOS and Windows.
  return relativePath.split("/").some((segment) => segment.toLowerCase() === ".git");
}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FileSystemCallError({ cause }) });

const hasCode =
  (...codes: ReadonlyArray<string>) =>
  (error: FileSystemCallError): boolean => {
    const code = errnoCode(error);
    return code !== undefined && codes.includes(code);
  };

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-09-30 10.15.03`, the stamp Finder adds when a name is taken in the Trash. */
function trashTimestamp(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())} ${padTwo(date.getHours())}.${padTwo(date.getMinutes())}.${padTwo(date.getSeconds())}`;
}

/** Local time without a zone, as the XDG trash spec asks for `DeletionDate`. */
function trashInfoDate(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}T${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const splitExtension = (name: string, isDirectory: boolean) => {
    const extension = isDirectory ? "" : path.extname(name);
    return { stem: name.slice(0, name.length - extension.length), extension };
  };

  const refreshInBackground = (root: string) =>
    workspaceEntries
      .refresh(root)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const resolveRoot = Effect.fn("WorkspaceEntryOperations.resolveRoot")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const root = yield* workspacePaths
      .normalizeWorkspaceRoot(cwd)
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "WorkspaceRootNotExistsError" ||
          cause._tag === "WorkspaceRootNotDirectoryError"
            ? entryError(cwd, relativePath, "not_found", "The workspace folder no longer exists.")
            : entryError(
                cwd,
                relativePath,
                "operation_failed",
                "Couldn't open the workspace folder.",
                cause,
              ),
        ),
      );
    const realRoot = yield* attempt(() => NodeFSP.realpath(root)).pipe(
      Effect.mapError((cause) =>
        entryError(
          cwd,
          relativePath,
          "operation_failed",
          `Couldn't open the workspace folder: ${describeFileSystemFailure(cause)}.`,
          cause,
        ),
      ),
    );
    return { root, realRoot } satisfies ResolvedRoot;
  });

  /**
   * Resolves a root-relative path through the real path of its parent folder,
   * so a symlinked folder can't lead outside the root or into `.git`. The
   * entry itself isn't followed: renaming or deleting a symlink acts on the
   * link.
   */
  const resolveEntry = Effect.fn("WorkspaceEntryOperations.resolveEntry")(function* (
    cwd: string,
    resolvedRoot: ResolvedRoot,
    relativePath: string,
    role: "source" | "destination",
  ) {
    const outsideRoot = () =>
      entryError(
        cwd,
        relativePath,
        "outside_root",
        `'${relativePath}' is outside the workspace folder.`,
      );
    const insideGit = () =>
      entryError(
        cwd,
        relativePath,
        role === "source" ? "outside_root" : "invalid_destination",
        "Files inside '.git' are managed by Git and can't be changed here.",
      );

    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: resolvedRoot.root, relativePath })
      .pipe(
        Effect.mapError(() =>
          path.resolve(resolvedRoot.root, relativePath.trim()) === resolvedRoot.root
            ? entryError(
                cwd,
                relativePath,
                role === "source" ? "outside_root" : "invalid_destination",
                "The workspace folder itself can't be changed here.",
              )
            : outsideRoot(),
        ),
      );
    if (hasGitSegment(resolved.relativePath)) {
      return yield* insideGit();
    }

    const name = path.basename(resolved.absolutePath);
    const realParent = yield* attempt(() =>
      realPathThroughMissingTail(path, path.dirname(resolved.absolutePath)),
    ).pipe(
      Effect.mapError((cause) =>
        entryError(
          cwd,
          resolved.relativePath,
          "operation_failed",
          `Couldn't resolve '${resolved.relativePath}': ${describeFileSystemFailure(cause)}.`,
          cause,
        ),
      ),
    );
    if (!isPathWithinRoot(path, resolvedRoot.realRoot, realParent)) {
      return yield* outsideRoot();
    }
    const absolutePath = path.join(realParent, name);
    if (hasGitSegment(path.relative(resolvedRoot.realRoot, absolutePath).replaceAll("\\", "/"))) {
      return yield* insideGit();
    }
    return { relativePath: resolved.relativePath, absolutePath, name } satisfies ResolvedEntry;
  });

  const lstatOrNull = (context: OperationContext, absolutePath: string) =>
    attempt(() => NodeFSP.lstat(absolutePath)).pipe(
      Effect.catchIf(hasCode("ENOENT", "ENOTDIR"), () => Effect.succeed(null)),
      Effect.mapError((cause) => operationFailed(context, cause)),
    );

  const requireSource = Effect.fn("WorkspaceEntryOperations.requireSource")(function* (
    context: OperationContext,
  ) {
    const stat = yield* lstatOrNull(context, context.entry.absolutePath);
    if (stat === null) {
      return yield* entryError(
        context.cwd,
        context.entry.relativePath,
        "not_found",
        `'${context.entry.name}' no longer exists. It may have been moved or deleted.`,
      );
    }
    return stat;
  });

  /** Fails when `destination` is the folder `source` itself or inside it. */
  const rejectIntoItself = Effect.fn("WorkspaceEntryOperations.rejectIntoItself")(function* (
    context: OperationContext,
    destination: ResolvedEntry,
  ) {
    const realSource = yield* attempt(() => NodeFSP.realpath(context.entry.absolutePath)).pipe(
      Effect.mapError((cause) => operationFailed(context, cause)),
    );
    const realDestinationParent = yield* attempt(() =>
      realPathThroughMissingTail(path, path.dirname(destination.absolutePath)),
    ).pipe(Effect.mapError((cause) => operationFailed(context, cause)));
    if (isPathWithinRoot(path, realSource, realDestinationParent)) {
      return yield* entryError(
        context.cwd,
        destination.relativePath,
        "invalid_destination",
        `Can't ${context.verb} '${context.entry.name}' into itself.`,
      );
    }
  });

  const makeParentDirectory = (context: OperationContext, entry: ResolvedEntry) =>
    attempt(() => NodeFSP.mkdir(path.dirname(entry.absolutePath), { recursive: true })).pipe(
      Effect.mapError((cause) =>
        errnoCode(cause) === "EEXIST" || errnoCode(cause) === "ENOTDIR"
          ? entryError(
              context.cwd,
              entry.relativePath,
              "invalid_destination",
              `Couldn't ${context.verb} '${entry.name}': part of its path is a file, not a folder.`,
              cause,
            )
          : operationFailed(context, cause),
      ),
    );

  const createEntry: WorkspaceEntryOperations["Service"]["createEntry"] = Effect.fn(
    "WorkspaceEntryOperations.createEntry",
  )(function* (input) {
    const resolvedRoot = yield* resolveRoot(input.cwd, input.relativePath);
    const entry = yield* resolveEntry(input.cwd, resolvedRoot, input.relativePath, "destination");
    const context = { cwd: input.cwd, entry, verb: "create" } satisfies OperationContext;

    yield* makeParentDirectory(context, entry);
    yield* attempt(() =>
      input.kind === "directory"
        ? NodeFSP.mkdir(entry.absolutePath)
        : NodeFSP.writeFile(entry.absolutePath, "", { flag: "wx" }),
    ).pipe(
      Effect.mapError((cause) =>
        errnoCode(cause) === "EEXIST"
          ? alreadyExists(input.cwd, entry, cause)
          : operationFailed(context, cause),
      ),
    );
    yield* refreshInBackground(resolvedRoot.root);
    return { relativePath: entry.relativePath };
  });

  const moveEntry: WorkspaceEntryOperations["Service"]["moveEntry"] = Effect.fn(
    "WorkspaceEntryOperations.moveEntry",
  )(function* (input) {
    const resolvedRoot = yield* resolveRoot(input.cwd, input.fromPath);
    const source = yield* resolveEntry(input.cwd, resolvedRoot, input.fromPath, "source");
    const destination = yield* resolveEntry(input.cwd, resolvedRoot, input.toPath, "destination");
    if (source.absolutePath === destination.absolutePath) {
      return { relativePath: destination.relativePath };
    }
    const context = {
      cwd: input.cwd,
      entry: source,
      verb:
        path.dirname(source.absolutePath) === path.dirname(destination.absolutePath)
          ? "rename"
          : "move",
    } satisfies OperationContext;

    const sourceStat = yield* requireSource(context);
    if (sourceStat.isDirectory()) {
      yield* rejectIntoItself(context, destination);
    }
    const destinationStat = yield* lstatOrNull(context, destination.absolutePath);
    if (destinationStat !== null) {
      // On a case-insensitive disk `Foo.ts` finds `foo.ts` itself; renaming
      // it to fix the case is fine. A hard link has the same inode under a
      // different name, so the names must match too.
      const caseOnlyRename =
        source.absolutePath.toLowerCase() === destination.absolutePath.toLowerCase() &&
        destinationStat.dev === sourceStat.dev &&
        destinationStat.ino === sourceStat.ino;
      if (!caseOnlyRename) {
        return yield* alreadyExists(input.cwd, destination);
      }
    }

    yield* makeParentDirectory(context, destination);
    const mapMoveFailure = (cause: unknown) => {
      const code = errnoCode(cause);
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ERR_FS_CP_EEXIST") {
        return alreadyExists(input.cwd, destination, cause);
      }
      if (code === "ENOENT") {
        return entryError(
          input.cwd,
          source.relativePath,
          "not_found",
          `'${source.name}' no longer exists. It may have been moved or deleted.`,
          cause,
        );
      }
      return operationFailed(context, cause);
    };
    yield* attempt(() => NodeFSP.rename(source.absolutePath, destination.absolutePath)).pipe(
      // A mount point inside the root: copy across, then remove the original.
      Effect.catchIf(hasCode("EXDEV"), () =>
        attempt(async () => {
          await NodeFSP.cp(source.absolutePath, destination.absolutePath, {
            recursive: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
          await NodeFSP.rm(source.absolutePath, { recursive: true, force: true });
        }),
      ),
      Effect.mapError(mapMoveFailure),
    );
    yield* refreshInBackground(resolvedRoot.root);
    return { relativePath: destination.relativePath };
  });

  const copyEntry: WorkspaceEntryOperations["Service"]["copyEntry"] = Effect.fn(
    "WorkspaceEntryOperations.copyEntry",
  )(function* (input) {
    const resolvedRoot = yield* resolveRoot(input.cwd, input.fromPath);
    const source = yield* resolveEntry(input.cwd, resolvedRoot, input.fromPath, "source");
    const destination = yield* resolveEntry(input.cwd, resolvedRoot, input.toPath, "destination");
    const context = { cwd: input.cwd, entry: source, verb: "copy" } satisfies OperationContext;

    const sourceStat = yield* requireSource(context);
    if ((yield* lstatOrNull(context, destination.absolutePath)) !== null) {
      return yield* alreadyExists(input.cwd, destination);
    }
    if (sourceStat.isDirectory()) {
      yield* rejectIntoItself(context, destination);
    }

    yield* makeParentDirectory(context, destination);
    yield* attempt(() =>
      NodeFSP.cp(source.absolutePath, destination.absolutePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        // Links are copied as links, so one pointing outside the root stays a link.
        verbatimSymlinks: true,
      }),
    ).pipe(
      Effect.mapError((cause) => {
        const code = errnoCode(cause);
        if (code === "ERR_FS_CP_EEXIST" || code === "EEXIST") {
          return alreadyExists(input.cwd, destination, cause);
        }
        if (code === "ERR_FS_CP_EINVAL") {
          return entryError(
            input.cwd,
            destination.relativePath,
            "invalid_destination",
            `Can't copy '${source.name}' into itself.`,
            cause,
          );
        }
        return operationFailed(context, cause);
      }),
    );
    yield* refreshInBackground(resolvedRoot.root);
    return { relativePath: destination.relativePath };
  });

  /**
   * Checks every entry can reach the Trash before moving any, so a delete
   * doesn't stop half done: the Trash is only a rename away on the same disk.
   */
  const moveToTrash = Effect.fn("WorkspaceEntryOperations.moveToTrash")(function* (
    cwd: string,
    entries: ReadonlyArray<ExistingEntry>,
  ) {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    const firstEntry = entries[0]!.entry;
    const home = environment.HOME || NodeOS.homedir();
    const layout =
      platform === "darwin"
        ? { kind: "macos" as const, filesDirectory: path.join(home, ".Trash") }
        : platform === "linux"
          ? (() => {
              const dataHome =
                environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
                  ? environment.XDG_DATA_HOME
                  : path.join(home, ".local", "share");
              const trashDirectory = path.join(dataHome, "Trash");
              return {
                kind: "xdg" as const,
                filesDirectory: path.join(trashDirectory, "files"),
                infoDirectory: path.join(trashDirectory, "info"),
              };
            })()
          : null;
    if (layout === null) {
      return yield* trashUnavailable(cwd, firstEntry, "this system has no supported Trash");
    }

    const trashStat = yield* attempt(async () => {
      await NodeFSP.mkdir(layout.filesDirectory, { recursive: true, mode: 0o700 });
      if (layout.kind === "xdg") {
        await NodeFSP.mkdir(layout.infoDirectory, { recursive: true, mode: 0o700 });
      }
      return NodeFSP.stat(layout.filesDirectory);
    }).pipe(
      Effect.mapError((cause) =>
        trashUnavailable(cwd, firstEntry, describeFileSystemFailure(cause), cause),
      ),
    );
    for (const { entry, stat } of entries) {
      if (stat.dev !== trashStat.dev) {
        return yield* trashUnavailable(cwd, entry, "it is on a different drive than the Trash");
      }
    }

    const deletedAt = yield* DateTime.nowAsDate;
    for (const { entry, stat } of entries) {
      const { stem, extension } = splitExtension(entry.name, stat.isDirectory());
      const failTrash = (cause: unknown) =>
        trashUnavailable(cwd, entry, describeFileSystemFailure(cause), cause);

      if (layout.kind === "macos") {
        let trashedName: string | null = null;
        for (let index = 0; index < TRASH_NAME_ATTEMPTS && trashedName === null; index += 1) {
          const candidate =
            index === 0
              ? entry.name
              : `${stem} ${trashTimestamp(deletedAt)}${index === 1 ? "" : ` ${index}`}${extension}`;
          const taken = yield* attempt(() =>
            NodeFSP.lstat(path.join(layout.filesDirectory, candidate)),
          ).pipe(
            Effect.as(true),
            Effect.catchIf(hasCode("ENOENT"), () => Effect.succeed(false)),
            Effect.mapError(failTrash),
          );
          if (!taken) trashedName = candidate;
        }
        if (trashedName === null) {
          return yield* trashUnavailable(cwd, entry, "no free name in the Trash");
        }
        const trashedPath = path.join(layout.filesDirectory, trashedName);
        yield* attempt(() => NodeFSP.rename(entry.absolutePath, trashedPath)).pipe(
          Effect.mapError(failTrash),
        );
        continue;
      }

      // XDG: reserve the name by creating its .trashinfo exclusively, then
      // move the entry into files/ under that name.
      const trashInfo = [
        "[Trash Info]",
        `Path=${entry.absolutePath.split("/").map(encodeURIComponent).join("/")}`,
        `DeletionDate=${trashInfoDate(deletedAt)}`,
        "",
      ].join("\n");
      let reservedName: string | null = null;
      for (let index = 0; index < TRASH_NAME_ATTEMPTS && reservedName === null; index += 1) {
        const candidate = index === 0 ? entry.name : `${stem}.${index + 1}${extension}`;
        const infoPath = path.join(layout.infoDirectory, `${candidate}.trashinfo`);
        const reserved = yield* attempt(async () => {
          await NodeFSP.writeFile(infoPath, trashInfo, { flag: "wx", mode: 0o600 });
          const orphan = await NodeFSP.lstat(path.join(layout.filesDirectory, candidate)).then(
            () => true,
            () => false,
          );
          if (orphan) {
            await NodeFSP.rm(infoPath, { force: true });
          }
          return !orphan;
        }).pipe(
          Effect.catchIf(hasCode("EEXIST"), () => Effect.succeed(false)),
          Effect.mapError(failTrash),
        );
        if (reserved) reservedName = candidate;
      }
      if (reservedName === null) {
        return yield* trashUnavailable(cwd, entry, "no free name in the Trash");
      }
      const infoPath = path.join(layout.infoDirectory, `${reservedName}.trashinfo`);
      const trashedPath = path.join(layout.filesDirectory, reservedName);
      yield* attempt(() => NodeFSP.rename(entry.absolutePath, trashedPath)).pipe(
        Effect.tapError(() =>
          attempt(() => NodeFSP.rm(infoPath, { force: true })).pipe(Effect.ignore),
        ),
        Effect.mapError(failTrash),
      );
    }
  });

  const deleteEntries: WorkspaceEntryOperations["Service"]["deleteEntries"] = Effect.fn(
    "WorkspaceEntryOperations.deleteEntries",
  )(function* (input) {
    const firstPath = input.relativePaths[0] ?? "";
    const resolvedRoot = yield* resolveRoot(input.cwd, firstPath);
    const resolved = yield* Effect.forEach(input.relativePaths, (relativePath) =>
      resolveEntry(input.cwd, resolvedRoot, relativePath, "source"),
    );
    // Deleting a folder takes whatever else was selected inside it along.
    const uniqueEntries = [
      ...new Map(resolved.map((entry) => [entry.absolutePath, entry])).values(),
    ];
    const topLevelEntries = uniqueEntries.filter(
      (entry) =>
        !uniqueEntries.some(
          (other) =>
            other !== entry && isPathWithinRoot(path, other.absolutePath, entry.absolutePath),
        ),
    );
    const verb = input.permanently ? "delete" : "move to the Trash";
    const existing: Array<ExistingEntry> = [];
    for (const entry of topLevelEntries) {
      const stat = yield* lstatOrNull({ cwd: input.cwd, entry, verb }, entry.absolutePath);
      if (stat !== null) {
        existing.push({ entry, stat });
      }
    }

    if (input.permanently) {
      for (const { entry } of existing) {
        yield* attempt(() => NodeFSP.rm(entry.absolutePath, { recursive: true, force: true })).pipe(
          Effect.mapError((cause) => operationFailed({ cwd: input.cwd, entry, verb }, cause)),
        );
      }
    } else if (existing.length > 0) {
      yield* moveToTrash(input.cwd, existing);
    }

    yield* refreshInBackground(resolvedRoot.root);
    return { trashed: !input.permanently };
  });

  return WorkspaceEntryOperations.of({ createEntry, moveEntry, copyEntry, deleteEntries });
});

export const layer = Layer.effect(WorkspaceEntryOperations, make);
