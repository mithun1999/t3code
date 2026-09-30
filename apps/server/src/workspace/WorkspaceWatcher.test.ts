import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { type WorkspaceChangeEvent, WorkspaceWatchError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as WorkspaceWatcher from "./WorkspaceWatcher.ts";

/** Native watchers opened and closed, by watched path. */
const watcherCounts = new Map<string, { opened: number; closed: number }>();
const countingNativeWatch: WorkspaceWatcher.NativeWatchFactory = (
  target,
  options,
  onChange,
  onError,
) => {
  const counts = watcherCounts.get(target) ?? { opened: 0, closed: 0 };
  watcherCounts.set(target, counts);
  counts.opened += 1;
  const handle = WorkspaceWatcher.nodeNativeWatch(target, options, onChange, onError);
  return {
    close: () => {
      counts.closed += 1;
      handle.close();
    },
  };
};

const LINGER_MS = 50;

const TestLayer = WorkspaceWatcher.layerWithOptions({
  lingerMs: LINGER_MS,
  nativeWatch: countingNativeWatch,
}).pipe(Layer.provideMerge(NodeServices.layer));

/** A real path, so it matches the key the watcher is shared under. */
const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-watcher-",
  });
  return yield* fileSystem.realPath(directory);
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

/** Subscribes in the background and gives the native watcher a moment to start. */
const subscribe = Effect.fn("subscribe")(function* (cwd: string) {
  const watcher = yield* WorkspaceWatcher.WorkspaceWatcher;
  const events = yield* Queue.unbounded<WorkspaceChangeEvent>();
  const fiber = yield* watcher.watch(cwd).pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  yield* Effect.sleep(Duration.millis(300));
  return { events, fiber };
});

const awaitEvent = Effect.fn("awaitEvent")(function* (
  events: Queue.Queue<WorkspaceChangeEvent>,
  predicate: (event: WorkspaceChangeEvent) => boolean,
  seen: Array<WorkspaceChangeEvent> = [],
) {
  return yield* Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(events);
      seen.push(event);
      if (predicate(event)) return event;
    }
  }).pipe(Effect.timeout(Duration.seconds(5)));
});

describe("watch batches", () => {
  const batchOf = (signals: ReadonlyArray<WorkspaceWatcher.WatchSignal>) => {
    const batch = WorkspaceWatcher.makeWatchBatch();
    for (const signal of signals) WorkspaceWatcher.addWatchSignal(batch, signal);
    return WorkspaceWatcher.watchBatchToEvent(batch);
  };
  const paths = (...values: ReadonlyArray<string>) =>
    values.map((path) => ({ _tag: "path" as const, path }));

  it("names each file with its folder and itself as folders to reload", () => {
    expect(batchOf(paths("src/a.ts", "src/a.ts", "top.md", "win\\style.ts"))).toEqual({
      directories: ["src", "src/a.ts", "", "top.md", "win", "win/style.ts"],
      files: ["src/a.ts", "top.md", "win/style.ts"],
      gitChanged: false,
      overflow: false,
    });
  });

  it("reduces .git to its state files and ignores other repositories' internals", () => {
    expect(
      batchOf(paths(".git/objects/ab/cdef", ".git/index.lock", "vendor/lib/.git/index")),
    ).toBeNull();
    for (const gitPath of [".git/index", ".git/HEAD", ".git/refs/heads/main", ".git/packed-refs"]) {
      expect(batchOf(paths(gitPath))).toEqual({
        directories: [],
        files: [],
        gitChanged: true,
        overflow: false,
      });
    }
  });

  it("overflows past the path limit or when a path is unknown", () => {
    const overflow = { directories: [], files: [], gitChanged: true, overflow: true };
    expect(
      batchOf(paths(...Array.from({ length: 1001 }, (_, index) => `generated/${index}.ts`))),
    ).toEqual(overflow);
    expect(batchOf([{ _tag: "unknownPath" }])).toEqual(overflow);
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceWatcher", (it) => {
  it.effect("reports created, changed and deleted files with their folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* fileSystem.makeDirectory(path.join(cwd, "src"));
      const { events } = yield* subscribe(cwd);
      const mentionsFile = (event: WorkspaceChangeEvent) => event.files.includes("src/a.ts");

      yield* writeTextFile(cwd, "src/a.ts", "created\n");
      const created = yield* awaitEvent(events, mentionsFile);
      yield* writeTextFile(cwd, "src/a.ts", "changed\n");
      yield* awaitEvent(events, mentionsFile);
      yield* fileSystem.remove(path.join(cwd, "src/a.ts"));
      yield* awaitEvent(events, mentionsFile);

      expect(created.directories).toEqual(expect.arrayContaining(["src", "src/a.ts"]));
      expect(created.overflow).toBe(false);
    }),
  );

  it.effect("flags git state changes without listing .git internals", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, ".git/HEAD", "ref: refs/heads/main\n");
      const { events } = yield* subscribe(cwd);
      const seen: Array<WorkspaceChangeEvent> = [];

      yield* writeTextFile(cwd, ".git/objects/ab/cdef", "blob");
      yield* writeTextFile(cwd, ".git/index", "index");
      yield* awaitEvent(events, (event) => event.gitChanged, seen);

      expect(
        seen.flatMap((event) => event.files).filter((file) => file.startsWith(".git")),
      ).toEqual([]);
    }),
  );

  it.effect("watches a linked worktree's git folder for its index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const gitDir = yield* makeTempDir;
      yield* writeTextFile(cwd, ".git", `gitdir: ${gitDir}\n`);
      const { events } = yield* subscribe(cwd);

      yield* writeTextFile(gitDir, "index", "index");
      yield* awaitEvent(events, (event) => event.gitChanged);

      expect(watcherCounts.get(gitDir)?.opened).toBe(1);
    }),
  );

  it.effect("shares one native watcher between subscribers and closes it after the last", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const first = yield* subscribe(cwd);
      const second = yield* subscribe(cwd);

      yield* writeTextFile(cwd, "shared.md", "hello\n");
      yield* awaitEvent(first.events, (event) => event.files.includes("shared.md"));
      yield* awaitEvent(second.events, (event) => event.files.includes("shared.md"));
      expect(watcherCounts.get(cwd)).toEqual({ opened: 1, closed: 0 });

      yield* Fiber.interrupt(first.fiber);
      yield* Effect.sleep(Duration.millis(LINGER_MS * 3));
      expect(watcherCounts.get(cwd)).toEqual({ opened: 1, closed: 0 });

      yield* Fiber.interrupt(second.fiber);
      yield* Effect.sleep(Duration.millis(LINGER_MS * 3));
      expect(watcherCounts.get(cwd)).toEqual({ opened: 1, closed: 1 });

      const third = yield* subscribe(cwd);
      yield* writeTextFile(cwd, "again.md", "hello\n");
      yield* awaitEvent(third.events, (event) => event.files.includes("again.md"));
      expect(watcherCounts.get(cwd)).toEqual({ opened: 2, closed: 1 });
    }),
  );

  it.effect("fails when the folder can't be watched", () =>
    Effect.gen(function* () {
      const watcher = yield* WorkspaceWatcher.WorkspaceWatcher;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;

      const error = yield* watcher
        .watch(path.join(cwd, "missing"))
        .pipe(Stream.runDrain, Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceWatchError);
    }),
  );
});

it.live("sends overflow when the native watcher breaks, then reopens it", () => {
  const failures: Array<(cause: unknown) => void> = [];
  let opened = 0;
  const BrokenWatchLayer = WorkspaceWatcher.layerWithOptions({
    nativeWatch: (_target, _options, _onChange, onError) => {
      opened += 1;
      failures.push(onError);
      return { close: () => undefined };
    },
  }).pipe(Layer.provideMerge(NodeServices.layer));

  return Effect.gen(function* () {
    const cwd = yield* makeTempDir;
    const { events } = yield* subscribe(cwd);

    failures[0]?.(new Error("watch limit reached"));
    const broken = yield* awaitEvent(events, () => true);
    const reopened = yield* awaitEvent(events, () => true);

    expect(broken.overflow).toBe(true);
    expect(reopened.overflow).toBe(true);
    expect(opened).toBe(2);
  }).pipe(Effect.provide(BrokenWatchLayer));
});

describe("ignored-only changes", () => {
  it("recognises a batch of ignored files by their folders, and caches the folders", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const ignored = new Set([".next/cache/", "logs/", "debug.log"]);
    const classify = WorkspaceWatcher.makeIgnoredChangeClassifier(async (paths) => {
      calls.push(paths);
      return new Set(paths.filter((path) => ignored.has(path)));
    });

    expect(await classify([".next/cache/a.json", ".next/cache/b.json", "logs/app.log"])).toBe(true);
    expect(calls).toEqual([[".next/cache/", "logs/"]]);
    expect(await classify([".next/cache/c.json"])).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await classify(["debug.log"])).toBe(true);
    expect(await classify(["src/app.ts", ".next/cache/d.json"])).toBe(false);
  });

  it("treats a .gitignore edit as a real change and forgets cached folders", async () => {
    let checks = 0;
    const classify = WorkspaceWatcher.makeIgnoredChangeClassifier(async (paths) => {
      checks += 1;
      return new Set(paths);
    });
    expect(await classify(["dist/a.js"])).toBe(true);
    expect(await classify([".gitignore"])).toBe(false);
    expect(await classify(["dist/b.js"])).toBe(true);
    expect(checks).toBe(2);
  });
});
