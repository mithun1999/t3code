// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks. Reads also accept absolute host
 * paths so clients can show files an agent left outside the workspace; writes
 * never leave the root.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspaceFileRevisionConflictError extends Schema.TaggedError<WorkspaceFileRevisionConflictError>()(
  "WorkspaceFileRevisionConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    expectedRevision: Schema.String,
    actualRevision: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' changed on disk since it was last read.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceFileRevisionConflictError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /**
     * Read a UTF-8 text file relative to the workspace root, or any host file by
     * absolute path.
     */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root, symlinks included. The write is atomic and keeps the
     * replaced file's mode. With `expectedRevision`, fails instead of
     * overwriting a file that changed on disk since the caller read it.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** The revision clients send back to detect conflicting writes: a SHA-1 of the file's bytes. */
export function fileRevision(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha1").update(bytes).digest("hex");
}

/** Whether `candidate` is `root` or inside it. Both must be absolute. */
export function isPathWithinRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return !(
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === ".." ||
    path.isAbsolute(relativePath)
  );
}

/**
 * The real path of `target`, resolved through its nearest existing ancestor
 * when the tail doesn't exist yet, so a path about to be created can be
 * checked against symlinks before anything is made.
 */
export async function realPathThroughMissingTail(path: Path.Path, target: string): Promise<string> {
  const missingSegments: Array<string> = [];
  let current = target;
  for (;;) {
    try {
      const realPath = await NodeFSP.realpath(current);
      return missingSegments.length === 0
        ? realPath
        : path.join(realPath, ...missingSegments.toReversed());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) {
        throw error;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  /**
   * Resolves the file a read targets. Workspace-relative paths must stay inside the
   * root, symlinks included. An absolute path reads a host file in place, such as a
   * report an agent wrote to a temp directory; it gets no root check.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isPathWithinRoot(path, realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const realTargetPath = target.realTargetPath;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. Windows lacks it.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated,
            ...(truncated ? {} : { revision: fileRevision(fileBytes) }),
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const operationError = (
      operation: WorkspaceFileSystemOperationError["operation"],
      operationPath: string,
      cause: unknown,
    ) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        operationPath,
        operation,
        cause,
      });
    const escapeError = (resolvedWorkspaceRoot: string, resolvedPath: string) =>
      new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot,
        resolvedPath,
      });

    const parentPath = path.dirname(target.absolutePath);
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) => operationError("realpath-workspace-root", input.cwd, cause),
    });
    // Check before creating anything, so a symlinked folder inside the root
    // can't carry the write (or its new parent folders) outside it.
    const realParentPath = yield* Effect.tryPromise({
      try: () => realPathThroughMissingTail(path, parentPath),
      catch: (cause) => operationError("realpath-target", parentPath, cause),
    });
    let writePath = path.join(realParentPath, path.basename(target.absolutePath));
    if (!isPathWithinRoot(path, realWorkspaceRoot, realParentPath)) {
      return yield* escapeError(realWorkspaceRoot, writePath);
    }

    const existingLink = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(writePath),
      catch: (cause) => operationError("stat", writePath, cause),
    }).pipe(
      Effect.catchIf(
        (error) => (error.cause as NodeJS.ErrnoException).code === "ENOENT",
        () => Effect.succeed(null),
      ),
    );
    if (existingLink?.isSymbolicLink()) {
      // Save through the link like an editor does; the atomic rename would
      // otherwise replace the link with a plain file.
      const linkPath = writePath;
      writePath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(linkPath),
        catch: (cause) => operationError("realpath-target", linkPath, cause),
      });
      if (!isPathWithinRoot(path, realWorkspaceRoot, writePath)) {
        return yield* escapeError(realWorkspaceRoot, writePath);
      }
    }
    const existing = existingLink?.isSymbolicLink()
      ? yield* Effect.tryPromise({
          try: () => NodeFSP.stat(writePath),
          catch: (cause) => operationError("stat", writePath, cause),
        })
      : existingLink;
    if (existing && !existing.isFile()) {
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: writePath,
      });
    }

    // A missing file has no revision to conflict with: saving recreates it.
    if (input.expectedRevision !== undefined && existing) {
      const currentBytes = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(writePath),
        catch: (cause) => operationError("read", writePath, cause),
      });
      const actualRevision = fileRevision(currentBytes);
      if (actualRevision !== input.expectedRevision) {
        return yield* new WorkspaceFileRevisionConflictError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: writePath,
          expectedRevision: input.expectedRevision,
          actualRevision,
        });
      }
    }

    yield* fileSystem
      .makeDirectory(path.dirname(writePath), { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          operationError("make-directory", path.dirname(writePath), cause),
        ),
      );
    yield* writeFileStringAtomically({
      filePath: writePath,
      contents: input.contents,
      ...(existing ? { mode: existing.mode & 0o7777 } : {}),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => operationError("write-file", writePath, cause)),
    );
    // Rescanning a big repository takes seconds; the save shouldn't wait on it.
    yield* workspaceEntries
      .refresh(input.cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
    return {
      relativePath: target.relativePath,
      revision: fileRevision(Buffer.from(input.contents, "utf8")),
    };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
