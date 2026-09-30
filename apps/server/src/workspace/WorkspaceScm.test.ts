// @effect-diagnostics nodeBuiltinImport:off - fixtures drive git directly.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { ScmError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceScm from "./WorkspaceScm.ts";

const TestLayer = WorkspaceScm.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) =>
        NodeChildProcess.execFile("git", [...args], { cwd }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        ),
      ),
  );

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-workspace-scm-" });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string | Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* (
    typeof contents === "string"
      ? fileSystem.writeFileString(absolutePath, contents)
      : fileSystem.writeFile(absolutePath, contents)
  ).pipe(Effect.orDie);
});

/** A repository with its own identity and hooks, whatever the machine's git config says. */
const makeRepo = Effect.fn("makeRepo")(function* (options: { readonly commit: boolean }) {
  const cwd = yield* makeTempDir;
  yield* git(cwd, "init", "-q", "-b", "main");
  yield* git(cwd, "config", "user.name", "Test");
  yield* git(cwd, "config", "user.email", "test@example.com");
  yield* git(cwd, "config", "commit.gpgsign", "false");
  yield* git(cwd, "config", "core.hooksPath", ".git/hooks");
  if (options.commit) {
    yield* writeTextFile(cwd, "README.md", "# Test\n");
    yield* git(cwd, "add", "README.md");
    yield* git(cwd, "commit", "-q", "-m", "Initial commit");
  }
  return cwd;
});

const readText = Effect.fn("readText")(function* (cwd: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(cwd, relativePath)).pipe(Effect.orDie);
});

describe("parseScmStatus", () => {
  it("groups porcelain v2 entries the way VS Code does", () => {
    const output = [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaaa bbbb src/staged.ts",
      "1 .M N... 100644 100644 100644 aaaa aaaa src/changed file.ts",
      "1 MD N... 100644 100644 000000 aaaa bbbb both.ts",
      "1 A. N... 000000 100644 100644 0000 bbbb added.ts",
      "1 .T N... 100644 100644 120000 aaaa aaaa link",
      "2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.ts",
      "old name.ts",
      "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts",
      "? notes/naïve.md",
      "! ignored.log",
      "",
    ].join("\0");

    expect(WorkspaceScm.parseScmStatus(output)).toEqual({
      branch: "feature/x",
      hasCommits: true,
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 1,
      merge: [{ path: "conflict.ts", status: "conflicted" }],
      staged: [
        { path: "src/staged.ts", status: "modified" },
        { path: "both.ts", status: "modified" },
        { path: "added.ts", status: "added" },
        { path: "new name.ts", status: "renamed", originalPath: "old name.ts" },
      ],
      changes: [
        { path: "src/changed file.ts", status: "modified" },
        { path: "both.ts", status: "deleted" },
        { path: "link", status: "type_changed" },
        { path: "notes/naïve.md", status: "untracked" },
      ],
      truncated: false,
    });
  });

  it("reads an unborn branch and a detached HEAD", () => {
    expect(
      WorkspaceScm.parseScmStatus("# branch.oid (initial)\0# branch.head main\0"),
    ).toMatchObject({ branch: "main", hasCommits: false, upstream: null, ahead: 0, behind: 0 });
    expect(
      WorkspaceScm.parseScmStatus("# branch.oid abc\0# branch.head (detached)\0"),
    ).toMatchObject({ branch: null, hasCommits: true });
  });

  it("caps each group and drops a record cut off by the output limit", () => {
    const capped = WorkspaceScm.parseScmStatus("? a\0? b\0? c\0", { maxChangesPerGroup: 2 });
    expect(capped.changes.map((change) => change.path)).toEqual(["a", "b"]);
    expect(capped.truncated).toBe(true);

    const cut = WorkspaceScm.parseScmStatus("? a\0? partial-na", { outputTruncated: true });
    expect(cut.changes.map((change) => change.path)).toEqual(["a"]);
    expect(cut.truncated).toBe(true);
  });
});

describe("repoRootFromCwd", () => {
  it("keeps the caller's spelling of the repository root", () => {
    expect(WorkspaceScm.repoRootFromCwd("/tmp/repo", "")).toBe("/tmp/repo");
    expect(WorkspaceScm.repoRootFromCwd("/tmp/repo/", "")).toBe("/tmp/repo");
    expect(WorkspaceScm.repoRootFromCwd("/tmp/repo/packages/app", "packages/app/")).toBe(
      "/tmp/repo",
    );
    expect(WorkspaceScm.repoRootFromCwd("/elsewhere/app", "packages/app/")).toBeNull();
  });
});

describe("gitFailureMessage", () => {
  it("keeps git's explanation without hints or prefixes", () => {
    expect(
      WorkspaceScm.gitFailureMessage(
        {
          stdout: "",
          stderr: "hint: Use 'git add' first\nfatal: pathspec 'nope' did not match any files\n",
        },
        "fallback",
      ),
    ).toBe("pathspec 'nope' did not match any files");
    expect(WorkspaceScm.gitFailureMessage({ stdout: "", stderr: "  \n" }, "fallback")).toBe(
      "fallback",
    );
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceScm", (it) => {
  describe("status", () => {
    it.effect("reports a folder outside any repository", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeTempDir;

        const status = yield* scm.status({ cwd });

        expect(status).toEqual({
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
        });
      }),
    );

    it.effect("lists repository-relative changes from a subfolder, renames included", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "src/old.ts", "export const value = 1;\n");
        yield* git(cwd, "add", ".");
        yield* git(cwd, "commit", "-q", "-m", "Add old");
        yield* git(cwd, "mv", "src/old.ts", "src/new.ts");
        yield* writeTextFile(cwd, "README.md", "# Changed\n");
        yield* writeTextFile(cwd, "docs/naïve notes.md", "untracked\n");

        const status = yield* scm.status({ cwd: path.join(cwd, "src") });

        expect(status.isRepo).toBe(true);
        // Spelled as the caller reached it, not git's real path (/var vs /private/var).
        expect(status.repoRoot).toBe(cwd);
        expect(status.branch).toBe("main");
        expect(status.hasCommits).toBe(true);
        expect(status.staged).toEqual([
          { path: "src/new.ts", status: "renamed", originalPath: "src/old.ts" },
        ]);
        expect(status.changes).toEqual([
          { path: "README.md", status: "modified" },
          { path: "docs/naïve notes.md", status: "untracked" },
        ]);
      }),
    );
  });

  describe("stage and unstage", () => {
    it.effect("stages and unstages in a repository with commits", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "README.md", "# Changed\n");
        yield* writeTextFile(cwd, "new file.ts", "export {};\n");

        yield* scm.stage({ cwd, paths: ["README.md", "new file.ts"] });
        const staged = yield* scm.status({ cwd });
        yield* scm.unstage({ cwd, paths: ["README.md", "new file.ts"] });
        const unstaged = yield* scm.status({ cwd });

        expect(staged.staged).toEqual([
          { path: "README.md", status: "modified" },
          { path: "new file.ts", status: "added" },
        ]);
        expect(staged.changes).toEqual([]);
        expect(unstaged.staged).toEqual([]);
        expect(unstaged.changes).toEqual([
          { path: "README.md", status: "modified" },
          { path: "new file.ts", status: "untracked" },
        ]);
      }),
    );

    it.effect("unstages before the first commit", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: false });
        yield* writeTextFile(cwd, "a.ts", "a\n");

        yield* scm.stage({ cwd, paths: ["a.ts"] });
        const staged = yield* scm.status({ cwd });
        yield* scm.unstage({ cwd, paths: ["a.ts"] });
        const unstaged = yield* scm.status({ cwd });

        expect(staged).toMatchObject({
          hasCommits: false,
          branch: "main",
          staged: [{ path: "a.ts", status: "added" }],
        });
        expect(unstaged.staged).toEqual([]);
        expect(unstaged.changes).toEqual([{ path: "a.ts", status: "untracked" }]);
      }),
    );

    it.effect("stages a long list of paths through stdin", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });
        const paths = Array.from({ length: 150 }, (_, index) => `many/file-${index}.txt`);
        for (const relativePath of paths) {
          yield* writeTextFile(cwd, relativePath, `${relativePath}\n`);
        }

        yield* scm.stage({ cwd, paths });
        const status = yield* scm.status({ cwd });

        expect(status.staged).toHaveLength(150);
        expect(status.changes).toEqual([]);
      }),
    );

    it.effect("fails with git's explanation", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });

        const error = yield* scm.stage({ cwd, paths: ["missing.ts"] }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ScmError);
        expect(error.message).toContain("missing.ts");
        expect(error.message).not.toMatch(/^fatal:/);
      }),
    );
  });

  describe("discard", () => {
    it.effect("restores tracked files from the index and deletes untracked ones", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "README.md", "# Staged\n");
        yield* git(cwd, "add", "README.md");
        yield* writeTextFile(cwd, "README.md", "# Unstaged on top\n");
        yield* writeTextFile(cwd, "scratch/tmp.txt", "throwaway\n");

        yield* scm.discard({ cwd, paths: ["README.md", "scratch/tmp.txt"] });
        const status = yield* scm.status({ cwd });

        expect(yield* readText(cwd, "README.md")).toBe("# Staged\n");
        expect(yield* fileSystem.exists(path.join(cwd, "scratch/tmp.txt"))).toBe(false);
        expect(status.staged).toEqual([{ path: "README.md", status: "modified" }]);
        expect(status.changes).toEqual([]);
      }),
    );
  });

  describe("commit", () => {
    it.effect("commits staged changes and reports the new commit", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "README.md", "# Changed\n");
        yield* git(cwd, "add", "README.md");

        const result = yield* scm.commit({ cwd, message: "\nUpdate readme\n\nWith a body.\n" });
        const head = (yield* git(cwd, "rev-parse", "HEAD")).trim();
        const message = yield* git(cwd, "log", "-1", "--format=%B");

        expect(result).toEqual({ sha: head, subject: "Update readme" });
        expect(message.trim()).toBe("Update readme\n\nWith a body.");
        expect((yield* scm.status({ cwd })).staged).toEqual([]);
      }),
    );

    it.effect("stages everything first when asked, and amends", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "a.ts", "a\n");
        const parent = (yield* git(cwd, "rev-parse", "HEAD")).trim();

        yield* scm.commit({ cwd, message: "Add a", stageAll: true });
        yield* writeTextFile(cwd, "b.ts", "b\n");
        const amended = yield* scm.commit({
          cwd,
          message: "Add a and b",
          stageAll: true,
          amend: true,
        });

        expect(amended.subject).toBe("Add a and b");
        expect((yield* git(cwd, "rev-parse", "HEAD~1")).trim()).toBe(parent);
        expect(
          (yield* git(cwd, "show", "--name-only", "--format=", "HEAD")).trim().split("\n"),
        ).toEqual(["a.ts", "b.ts"]);
        const status = yield* scm.status({ cwd });
        expect([...status.staged, ...status.changes]).toEqual([]);
      }),
    );

    it.effect("explains an empty commit and a failing hook", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo({ commit: true });

        const empty = yield* scm.commit({ cwd, message: "Nothing" }).pipe(Effect.flip);

        const hookPath = path.join(cwd, ".git/hooks/pre-commit");
        yield* writeTextFile(
          cwd,
          ".git/hooks/pre-commit",
          "#!/bin/sh\necho 'lint failed: src/a.ts' >&2\nexit 1\n",
        );
        yield* fileSystem.chmod(hookPath, 0o755);
        yield* writeTextFile(cwd, "a.ts", "a\n");
        const hooked = yield* scm
          .commit({ cwd, message: "Add a", stageAll: true })
          .pipe(Effect.flip);

        expect(empty).toBeInstanceOf(ScmError);
        expect(empty.message).toBe("There are no staged changes to commit.");
        expect(hooked.message).toBe("lint failed: src/a.ts");
      }),
    );
  });

  describe("readFile", () => {
    it.effect("reads a file from HEAD and from the index", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "README.md", "# Staged\n");
        yield* git(cwd, "add", "README.md");
        yield* writeTextFile(cwd, "README.md", "# Working tree\n");

        const head = yield* scm.readFile({ cwd, relativePath: "README.md", revision: "HEAD" });
        const index = yield* scm.readFile({ cwd, relativePath: "README.md", revision: "index" });

        expect(head).toEqual({
          exists: true,
          contents: "# Test\n",
          binary: false,
          truncated: false,
        });
        expect(index).toEqual({
          exists: true,
          contents: "# Staged\n",
          binary: false,
          truncated: false,
        });
      }),
    );

    it.effect("reports paths with no version at that revision", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const unborn = yield* makeRepo({ commit: false });
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "src/new.ts", "new\n");
        yield* git(cwd, "add", "src/new.ts");
        const missing = { exists: false, contents: "", binary: false, truncated: false };

        expect(yield* scm.readFile({ cwd, relativePath: "src/new.ts", revision: "HEAD" })).toEqual(
          missing,
        );
        expect(yield* scm.readFile({ cwd, relativePath: "src", revision: "index" })).toEqual(
          missing,
        );
        expect(
          yield* scm.readFile({ cwd: unborn, relativePath: "a.ts", revision: "HEAD" }),
        ).toEqual(missing);
      }),
    );

    it.effect("flags binary files and caps large ones", () =>
      Effect.gen(function* () {
        const scm = yield* WorkspaceScm.WorkspaceScm;
        const cwd = yield* makeRepo({ commit: true });
        yield* writeTextFile(cwd, "image.bin", Uint8Array.from([0x89, 0x50, 0x00, 0x47]));
        yield* writeTextFile(cwd, "large.txt", "x".repeat(1024 * 1024 + 10));
        yield* git(cwd, "add", ".");

        const binary = yield* scm.readFile({ cwd, relativePath: "image.bin", revision: "index" });
        const large = yield* scm.readFile({ cwd, relativePath: "large.txt", revision: "index" });

        expect(binary).toEqual({ exists: true, contents: "", binary: true, truncated: false });
        expect(large.truncated).toBe(true);
        expect(large.contents.length).toBeLessThanOrEqual(1024 * 1024);
      }),
    );
  });
});
