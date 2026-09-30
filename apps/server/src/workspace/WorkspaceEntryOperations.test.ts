// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create hard links or read inodes.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { WorkspaceEntryOperationError } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceEntryOperations from "./WorkspaceEntryOperations.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceEntryOperations.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntriesLayer),
    ),
  ),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entry-operations-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-entry-operations-" });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const exists = Effect.fn("exists")(function* (cwd: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.exists(path.join(cwd, relativePath)).pipe(Effect.orDie);
});

const readText = Effect.fn("readText")(function* (cwd: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(cwd, relativePath)).pipe(Effect.orDie);
});

const expectFailure = (error: unknown, failure: WorkspaceEntryOperationError["failure"]) => {
  expect(error).toBeInstanceOf(WorkspaceEntryOperationError);
  expect((error as WorkspaceEntryOperationError).failure).toBe(failure);
};

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntryOperations", (it) => {
  describe("createEntry", () => {
    it.effect("creates an empty file with its missing parent folders", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;

        const result = yield* operations.createEntry({
          cwd,
          relativePath: "a/b/c.ts",
          kind: "file",
        });

        expect(result).toEqual({ relativePath: "a/b/c.ts" });
        expect(yield* readText(cwd, "a/b/c.ts")).toBe("");
      }),
    );

    it.effect("creates a folder and refuses one that already exists", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        yield* operations.createEntry({ cwd, relativePath: "docs", kind: "directory" });
        const error = yield* operations
          .createEntry({ cwd, relativePath: "docs", kind: "directory" })
          .pipe(Effect.flip);

        expect((yield* fileSystem.stat(path.join(cwd, "docs"))).type).toBe("Directory");
        expectFailure(error, "already_exists");
        expect(error.message).toBe("A file or folder 'docs' already exists at this location.");
      }),
    );

    it.effect("never overwrites an existing file", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "keep me\n");

        const error = yield* operations
          .createEntry({ cwd, relativePath: "notes.md", kind: "file" })
          .pipe(Effect.flip);

        expectFailure(error, "already_exists");
        expect(yield* readText(cwd, "notes.md")).toBe("keep me\n");
      }),
    );

    it.effect("rejects the root, paths outside it and anything inside .git", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;

        const outside = yield* operations
          .createEntry({ cwd, relativePath: "../escape.ts", kind: "file" })
          .pipe(Effect.flip);
        const root = yield* operations
          .createEntry({ cwd, relativePath: "a/..", kind: "directory" })
          .pipe(Effect.flip);
        const git = yield* operations
          .createEntry({ cwd, relativePath: ".git/hooks/pre-commit", kind: "file" })
          .pipe(Effect.flip);

        expectFailure(outside, "outside_root");
        expectFailure(root, "invalid_destination");
        expectFailure(git, "invalid_destination");
        expect(yield* exists(cwd, ".git")).toBe(false);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects a path through a symlinked folder that leaves the root",
      () =>
        Effect.gen(function* () {
          const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked"));

          const error = yield* operations
            .createEntry({ cwd, relativePath: "linked/nested/escape.ts", kind: "file" })
            .pipe(Effect.flip);

          expectFailure(error, "outside_root");
          expect(yield* fileSystem.readDirectory(outsideDir)).toEqual([]);
        }),
    );
  });

  describe("moveEntry", () => {
    it.effect("renames a file and moves it into new folders", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "export {};\n");

        const renamed = yield* operations.moveEntry({ cwd, fromPath: "a.ts", toPath: "b.ts" });
        const moved = yield* operations.moveEntry({
          cwd,
          fromPath: "b.ts",
          toPath: "src/lib/b.ts",
        });

        expect(renamed).toEqual({ relativePath: "b.ts" });
        expect(moved).toEqual({ relativePath: "src/lib/b.ts" });
        expect(yield* exists(cwd, "a.ts")).toBe(false);
        expect(yield* readText(cwd, "src/lib/b.ts")).toBe("export {};\n");
      }),
    );

    it.effect("refuses to replace an existing entry", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "a\n");
        yield* writeTextFile(cwd, "b.ts", "b\n");

        const error = yield* operations
          .moveEntry({ cwd, fromPath: "a.ts", toPath: "b.ts" })
          .pipe(Effect.flip);

        expectFailure(error, "already_exists");
        expect(error.message).toBe("A file or folder 'b.ts' already exists at this location.");
        expect(yield* readText(cwd, "b.ts")).toBe("b\n");
      }),
    );

    it.effect("changes only the letter case of a name", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "readme.md", "# Hi\n");

        yield* operations.moveEntry({ cwd, fromPath: "readme.md", toPath: "README.md" });

        expect(yield* fileSystem.readDirectory(cwd)).toEqual(["README.md"]);
      }),
    );

    it.effect("treats a hard link under another name as an existing entry", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "shared\n");
        yield* Effect.promise(() => NodeFSP.link(path.join(cwd, "a.ts"), path.join(cwd, "b.ts")));

        const error = yield* operations
          .moveEntry({ cwd, fromPath: "a.ts", toPath: "b.ts" })
          .pipe(Effect.flip);

        expectFailure(error, "already_exists");
        expect(yield* exists(cwd, "a.ts")).toBe(true);
      }),
    );

    it.effect("refuses to move a folder into itself", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts");

        const error = yield* operations
          .moveEntry({ cwd, fromPath: "src", toPath: "src/nested/src" })
          .pipe(Effect.flip);

        expectFailure(error, "invalid_destination");
        expect(yield* exists(cwd, "src/nested")).toBe(false);
        expect(yield* exists(cwd, "src/index.ts")).toBe(true);
      }),
    );

    it.effect("reports a source that no longer exists", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;

        const error = yield* operations
          .moveEntry({ cwd, fromPath: "gone.ts", toPath: "here.ts" })
          .pipe(Effect.flip);

        expectFailure(error, "not_found");
      }),
    );

    it.effect("refuses to move .git", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/HEAD", "ref: refs/heads/main\n");

        const error = yield* operations
          .moveEntry({ cwd, fromPath: ".git", toPath: "git-backup" })
          .pipe(Effect.flip);

        expectFailure(error, "outside_root");
        expect(yield* exists(cwd, ".git/HEAD")).toBe(true);
      }),
    );
  });

  describe("copyEntry", () => {
    it.effect("copies a folder recursively", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/a.ts", "a\n");
        yield* writeTextFile(cwd, "src/nested/b.ts", "b\n");

        const result = yield* operations.copyEntry({
          cwd,
          fromPath: "src",
          toPath: "copies/src copy",
        });

        expect(result).toEqual({ relativePath: "copies/src copy" });
        expect(yield* readText(cwd, "copies/src copy/a.ts")).toBe("a\n");
        expect(yield* readText(cwd, "copies/src copy/nested/b.ts")).toBe("b\n");
        expect(yield* readText(cwd, "src/a.ts")).toBe("a\n");
      }),
    );

    it.effect("refuses an existing destination and a folder into itself", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "a\n");
        yield* writeTextFile(cwd, "b.ts", "b\n");
        yield* writeTextFile(cwd, "src/index.ts");

        const existing = yield* operations
          .copyEntry({ cwd, fromPath: "a.ts", toPath: "b.ts" })
          .pipe(Effect.flip);
        const intoItself = yield* operations
          .copyEntry({ cwd, fromPath: "src", toPath: "src/copy" })
          .pipe(Effect.flip);

        expectFailure(existing, "already_exists");
        expectFailure(intoItself, "invalid_destination");
        expect(yield* readText(cwd, "b.ts")).toBe("b\n");
        expect(yield* exists(cwd, "src/copy")).toBe(false);
      }),
    );
  });

  describe("deleteEntries", () => {
    it.effect("deletes files and folders permanently, skipping what is already gone", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/a.ts");
        yield* writeTextFile(cwd, "src/nested/b.ts");
        yield* writeTextFile(cwd, "keep.ts");

        const result = yield* operations.deleteEntries({
          cwd,
          relativePaths: ["src", "src/a.ts", "gone.ts"],
          permanently: true,
        });

        expect(result).toEqual({ trashed: false });
        expect(yield* exists(cwd, "src")).toBe(false);
        expect(yield* exists(cwd, "keep.ts")).toBe(true);
      }),
    );

    it.effect("moves entries to the XDG trash with their original location", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const home = yield* makeTempDir;
        const dataHome = path.join(home, "data");
        yield* writeTextFile(cwd, "notes.md", "first\n");

        const deleteNotes = operations
          .deleteEntries({ cwd, relativePaths: ["notes.md"], permanently: false })
          .pipe(
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessEnvironment, { HOME: home, XDG_DATA_HOME: dataHome }),
          );
        const first = yield* deleteNotes;
        yield* writeTextFile(cwd, "notes.md", "second\n");
        yield* deleteNotes;

        const realCwd = yield* Effect.promise(() => NodeFSP.realpath(cwd));
        const trashInfo = yield* readText(dataHome, "Trash/info/notes.md.trashinfo");
        expect(first).toEqual({ trashed: true });
        expect(yield* exists(cwd, "notes.md")).toBe(false);
        expect(yield* readText(dataHome, "Trash/files/notes.md")).toBe("first\n");
        expect(yield* readText(dataHome, "Trash/files/notes.2.md")).toBe("second\n");
        expect(trashInfo).toContain("[Trash Info]\n");
        expect(trashInfo).toContain(
          `Path=${path.join(realCwd, "notes.md").split("/").map(encodeURIComponent).join("/")}\n`,
        );
        expect(trashInfo).toMatch(/DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);
        expect(yield* exists(dataHome, "Trash/info/notes.2.md.trashinfo")).toBe(true);
      }),
    );

    it.effect("moves entries to the macOS Trash under a free name", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const home = yield* makeTempDir;
        yield* writeTextFile(home, ".Trash/report.md", "already trashed\n");
        yield* writeTextFile(cwd, "report.md", "new\n");
        yield* writeTextFile(cwd, "drafts/one.md");

        const result = yield* operations
          .deleteEntries({ cwd, relativePaths: ["report.md", "drafts"], permanently: false })
          .pipe(
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.provideService(HostProcessEnvironment, { HOME: home }),
          );

        const trashed = (yield* fileSystem.readDirectory(path.join(home, ".Trash"))).toSorted();
        expect(result).toEqual({ trashed: true });
        expect(yield* exists(cwd, "report.md")).toBe(false);
        expect(yield* exists(cwd, "drafts")).toBe(false);
        expect(trashed).toHaveLength(3);
        expect(trashed).toContain("drafts");
        const renamed = trashed.find((name) =>
          /^report \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.md$/.test(name),
        );
        expect(renamed).toBeDefined();
        expect(yield* readText(home, `.Trash/${renamed}`)).toBe("new\n");
        expect(yield* readText(home, ".Trash/report.md")).toBe("already trashed\n");
      }),
    );

    it.effect("reports the Trash unavailable without deleting anything", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts");

        const error = yield* operations
          .deleteEntries({ cwd, relativePaths: ["a.ts"], permanently: false })
          .pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.flip);

        expectFailure(error, "trash_unavailable");
        expect(yield* exists(cwd, "a.ts")).toBe(true);
      }),
    );

    it.effect("refuses to delete .git", () =>
      Effect.gen(function* () {
        const operations = yield* WorkspaceEntryOperations.WorkspaceEntryOperations;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/HEAD", "ref: refs/heads/main\n");

        const error = yield* operations
          .deleteEntries({ cwd, relativePaths: [".git/HEAD"], permanently: true })
          .pipe(Effect.flip);

        expectFailure(error, "outside_root");
        expect(yield* exists(cwd, ".git/HEAD")).toBe(true);
      }),
    );
  });
});
