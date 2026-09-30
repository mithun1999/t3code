// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceWatcher - Effect service contract for the explorer's feed of disk
 * changes under a workspace root.
 *
 * Keeps one recursive native watcher per real root, shared by every
 * subscriber and closed a few seconds after the last one leaves. Raw events
 * are batched and mapped to root-relative files and the folders to reload;
 * git's bookkeeping inside `.git` is reduced to one "git state changed" flag.
 *
 * @module WorkspaceWatcher
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { type WorkspaceChangeEvent, WorkspaceWatchError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

/** A batch closes once events pause this long… */
const WATCH_BATCH_QUIET_MS = 100;
/** …or this long after its first event, even under a steady stream. */
const WATCH_BATCH_MAX_LATENCY_MS = 300;
/** Past this many paths a batch only says "reload everything". */
const WATCH_BATCH_MAX_PATHS = 1000;
/** An unused watcher stays open this long, for a view that comes right back. */
const WATCH_LINGER_MS = 3000;
const WATCH_RETRY_BASE_MS = 1000;
const WATCH_RETRY_MAX_MS = 30_000;

const OVERFLOW_EVENT: WorkspaceChangeEvent = {
  directories: [],
  files: [],
  gitChanged: true,
  overflow: true,
};

/** How long a folder's "ignored by git" verdict is trusted. */
const IGNORE_CACHE_TTL_MS = 60_000;
const CHECK_IGNORE_TIMEOUT_MS = 5000;

/** Git files whose change can alter what the source control view shows. */
const GIT_STATE_FILES = new Set(["index", "HEAD", "packed-refs", "MERGE_HEAD"]);

/** Service tag for workspace change subscriptions. */
export class WorkspaceWatcher extends Context.Service<
  WorkspaceWatcher,
  {
    /**
     * Changes under `cwd`, batched. Fails only when the folder can't be
     * watched at all; a watcher that breaks later sends an overflow event and
     * reconnects on its own.
     */
    readonly watch: (cwd: string) => Stream.Stream<WorkspaceChangeEvent, WorkspaceWatchError>;
  }
>()("t3/workspace/WorkspaceWatcher") {}

/** A started native watcher. */
export interface NativeWatchHandle {
  readonly close: () => void;
}

/**
 * Starts a native watcher on `target`, reporting each changed path relative
 * to it (null when the platform doesn't say). Throws when `target` can't be
 * watched.
 */
export type NativeWatchFactory = (
  target: string,
  options: { readonly recursive: boolean },
  onChange: (relativePath: string | null) => void,
  onError: (cause: unknown) => void,
) => NativeWatchHandle;

export const nodeNativeWatch: NativeWatchFactory = (target, options, onChange, onError) => {
  const watcher = NodeFS.watch(
    target,
    { recursive: options.recursive, persistent: false, encoding: "utf8" },
    (_event, filename) => onChange(filename ?? null),
  );
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

export interface WorkspaceWatcherOptions {
  readonly lingerMs?: number;
  /** Test seam for observing native watchers. */
  readonly nativeWatch?: NativeWatchFactory;
}

/** What the native watchers report, before batching. */
export type WatchSignal =
  | { readonly _tag: "path"; readonly path: string }
  | { readonly _tag: "unknownPath" }
  | { readonly _tag: "gitState" }
  | { readonly _tag: "error"; readonly cause: unknown };

export interface WatchBatch {
  readonly files: Set<string>;
  rootChanged: boolean;
  gitChanged: boolean;
  overflow: boolean;
  failed: boolean;
}

export function makeWatchBatch(): WatchBatch {
  return {
    files: new Set(),
    rootChanged: false,
    gitChanged: false,
    overflow: false,
    failed: false,
  };
}

/** Whether a path inside `.git` is state the source control view shows, not git's own churn. */
export function isGitStatePath(gitRelativePath: string): boolean {
  if (gitRelativePath.endsWith(".lock")) return false;
  return GIT_STATE_FILES.has(gitRelativePath) || gitRelativePath.startsWith("refs/");
}

export function addWatchSignal(batch: WatchBatch, signal: WatchSignal): void {
  switch (signal._tag) {
    case "error":
      batch.failed = true;
      return;
    case "unknownPath":
      batch.overflow = true;
      return;
    case "gitState":
      batch.gitChanged = true;
      return;
    case "path": {
      const relativePath = signal.path
        .replaceAll("\\", "/")
        .replace(/^(?:\.\/)+/, "")
        .replace(/\/+$/, "");
      if (relativePath === "" || relativePath === ".") {
        batch.rootChanged = true;
        return;
      }
      const segments = relativePath.split("/");
      if (segments[0] === ".git") {
        if (segments.length === 1 || isGitStatePath(segments.slice(1).join("/"))) {
          batch.gitChanged = true;
        }
        return;
      }
      // Another repository's internals below this root aren't explorer content.
      if (segments.includes(".git") || batch.overflow) return;
      batch.files.add(relativePath);
      if (batch.files.size > WATCH_BATCH_MAX_PATHS) {
        batch.overflow = true;
        batch.files.clear();
      }
      return;
    }
  }
}

/**
 * The event for a batch, or null when nothing the views show changed. Each
 * path also names its parent folder ("" for the root) and itself as folders
 * to reload: the watcher doesn't stat, and the client only reloads folders it
 * has loaded.
 */
export function watchBatchToEvent(batch: WatchBatch): WorkspaceChangeEvent | null {
  if (batch.overflow) return OVERFLOW_EVENT;
  if (batch.files.size === 0 && !batch.rootChanged && !batch.gitChanged) return null;
  const directories = new Set<string>();
  if (batch.rootChanged) directories.add("");
  for (const file of batch.files) {
    const slash = file.lastIndexOf("/");
    directories.add(slash === -1 ? "" : file.slice(0, slash));
    directories.add(file);
  }
  return {
    directories: [...directories],
    files: [...batch.files],
    gitChanged: batch.gitChanged,
    overflow: false,
  };
}

/**
 * The paths git ignores, from `git check-ignore` run in `root`. Tracked files
 * are never reported, even when a pattern matches them. Any failure (no git,
 * not a repository) reports nothing as ignored.
 */
function checkIgnored(root: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(
      "git",
      ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
      { cwd: root, stdio: ["pipe", "pipe", "ignore"], timeout: CHECK_IGNORE_TIMEOUT_MS },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve(new Set()));
    child.on("close", () => resolve(new Set(output.split("\0").filter(Boolean))));
    child.stdin.on("error", () => {});
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

/**
 * Decides whether every changed file is ignored by git, so a dev server
 * rewriting its caches doesn't make every view re-read git status. Folder
 * verdicts are cached; a changed .gitignore clears them.
 */
export function makeIgnoredChangeClassifier(
  check: (paths: readonly string[]) => Promise<Set<string>>,
  now: () => number = Date.now,
) {
  const folders = new Map<string, { readonly ignored: boolean; readonly at: number }>();
  return async (files: readonly string[]): Promise<boolean> => {
    if (files.length === 0) return false;
    if (files.some((file) => file === ".gitignore" || file.endsWith("/.gitignore"))) {
      folders.clear();
      return false;
    }
    const parentOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));
    const unknown = [...new Set(files.map(parentOf).filter((folder) => folder !== ""))].filter(
      (folder) => {
        const cached = folders.get(folder);
        return cached === undefined || now() - cached.at > IGNORE_CACHE_TTL_MS;
      },
    );
    if (unknown.length > 0) {
      const ignored = await check(unknown.map((folder) => `${folder}/`));
      const at = now();
      for (const folder of unknown) folders.set(folder, { ignored: ignored.has(`${folder}/`), at });
    }
    const loose = files.filter((file) => {
      const folder = parentOf(file);
      return folder === "" || folders.get(folder)?.ignored !== true;
    });
    if (loose.length === 0) return true;
    const ignoredFiles = await check(loose);
    return loose.every((file) => ignoredFiles.has(file));
  };
}

interface ActiveWatch {
  readonly pubsub: PubSub.PubSub<WorkspaceChangeEvent>;
  readonly fiber: Fiber.Fiber<void>;
  readonly subscribers: number;
  /** Set while unused, so a linger timer only closes the idle spell it started for. */
  readonly idleToken: number | null;
}

function describeWatchFailure(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    if (cause.code === "ENOENT") return "the folder doesn't exist";
    if (cause.code === "EACCES" || cause.code === "EPERM") return "permission denied";
    if (cause.code === "ENOSPC" || cause.code === "EMFILE")
      return "the system watch limit was reached";
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** @public Service construction is part of the canonical Effect module API. */
export const makeWithOptions = Effect.fn("WorkspaceWatcher.makeWithOptions")(function* (
  options: WorkspaceWatcherOptions = {},
) {
  const path = yield* Path.Path;
  const lingerMs = options.lingerMs ?? WATCH_LINGER_MS;
  const nativeWatch = options.nativeWatch ?? nodeNativeWatch;
  const watcherScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const activeRef = yield* SynchronizedRef.make(new Map<string, ActiveWatch>());
  let nextIdleToken = 0;
  yield* Effect.addFinalizer(() =>
    SynchronizedRef.get(activeRef).pipe(
      Effect.flatMap((active) =>
        Effect.forEach(active.values(), (watch) => PubSub.shutdown(watch.pubsub), {
          discard: true,
        }),
      ),
    ),
  );

  /** A linked worktree's `.git` is a file naming its real git folder. */
  const resolveLinkedGitDir = (root: string) =>
    Effect.promise(async () => {
      const dotGit = path.join(root, ".git");
      try {
        if (!(await NodeFSP.lstat(dotGit)).isFile()) return null;
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(await NodeFSP.readFile(dotGit, "utf8"));
        return match?.[1] ? path.resolve(root, match[1]) : null;
      } catch {
        return null;
      }
    });

  const openWatchers = Effect.fn("WorkspaceWatcher.openWatchers")(function* (
    cwd: string,
    root: string,
    signals: Queue.Queue<WatchSignal>,
  ) {
    const linkedGitDir = yield* resolveLinkedGitDir(root);
    const offer = (signal: WatchSignal) => {
      Queue.offerUnsafe(signals, signal);
    };
    return yield* Effect.try({
      try: (): NativeWatchHandle => {
        const handles: Array<NativeWatchHandle> = [
          nativeWatch(
            root,
            { recursive: true },
            (relativePath) =>
              offer(
                relativePath === null
                  ? { _tag: "unknownPath" }
                  : { _tag: "path", path: relativePath },
              ),
            (cause) => offer({ _tag: "error", cause }),
          ),
        ];
        if (linkedGitDir !== null) {
          try {
            handles.push(
              nativeWatch(
                linkedGitDir,
                { recursive: false },
                (name) => {
                  if (name === null || isGitStatePath(name)) offer({ _tag: "gitState" });
                },
                (cause) => offer({ _tag: "error", cause }),
              ),
            );
          } catch {
            // Without it only the worktree's own index and HEAD go unnoticed.
          }
        }
        return {
          close: () => {
            for (const handle of handles) {
              try {
                handle.close();
              } catch {
                // Already closed.
              }
            }
          },
        };
      },
      catch: (cause) =>
        new WorkspaceWatchError({
          cwd,
          message: `Couldn't watch '${cwd}' for changes: ${describeWatchFailure(cause)}.`,
          cause,
        }),
    });
  });

  const rootIsDirectory = (root: string) =>
    Effect.promise(() =>
      NodeFSP.stat(root).then(
        (stat) => stat.isDirectory(),
        () => false,
      ),
    );

  const collectBatch = Effect.fn("WorkspaceWatcher.collectBatch")(function* (
    signals: Queue.Queue<WatchSignal>,
  ) {
    const batch = makeWatchBatch();
    addWatchSignal(batch, yield* Queue.take(signals));
    const startedAt = yield* Clock.currentTimeMillis;
    while (!batch.failed) {
      const remainingMs =
        WATCH_BATCH_MAX_LATENCY_MS - ((yield* Clock.currentTimeMillis) - startedAt);
      if (remainingMs <= 0) break;
      yield* Effect.sleep(Duration.millis(Math.min(WATCH_BATCH_QUIET_MS, remainingMs)));
      const drained = yield* Queue.clear(signals);
      for (const signal of drained) addWatchSignal(batch, signal);
      if (drained.length === 0) break;
    }
    return batch;
  });

  /**
   * Publishes batches until interrupted. When the watcher errors or the root
   * disappears, subscribers get an overflow event and the watcher is reopened
   * with backoff; reopening sends another, for the changes missed meanwhile.
   */
  const runRootWatch = Effect.fn("WorkspaceWatcher.runRootWatch")(function* (
    cwd: string,
    root: string,
    signals: Queue.Queue<WatchSignal>,
    pubsub: PubSub.PubSub<WorkspaceChangeEvent>,
    initialHandle: NativeWatchHandle,
  ) {
    let handle: NativeWatchHandle | null = initialHandle;
    let failures = 0;
    const allIgnored = makeIgnoredChangeClassifier((paths) => checkIgnored(root, paths));
    const closeHandle = Effect.sync(() => {
      handle?.close();
      handle = null;
    });

    const step = Effect.gen(function* () {
      if (handle === null) {
        yield* Effect.sleep(
          Duration.millis(
            Math.min(WATCH_RETRY_MAX_MS, WATCH_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10)),
          ),
        );
        const reopened = (yield* rootIsDirectory(root))
          ? yield* openWatchers(cwd, root, signals).pipe(Effect.option)
          : Option.none();
        if (Option.isNone(reopened)) {
          failures += 1;
          return;
        }
        handle = reopened.value;
        failures = 0;
        yield* Queue.clear(signals);
        yield* PubSub.publish(pubsub, OVERFLOW_EVENT);
        return;
      }

      const batch = yield* collectBatch(signals);
      if (batch.failed || !(yield* rootIsDirectory(root))) {
        yield* Effect.logWarning("Workspace watcher stopped; reopening", {
          rootLength: root.length,
          watcherFailed: batch.failed,
        });
        yield* closeHandle;
        failures = 1;
        yield* PubSub.publish(pubsub, OVERFLOW_EVENT);
        return;
      }
      const event = watchBatchToEvent(batch);
      if (event !== null) {
        const ignoredOnly =
          !event.gitChanged && event.files.length > 0
            ? yield* Effect.promise(() => allIgnored(event.files))
            : false;
        yield* PubSub.publish(pubsub, ignoredOnly ? { ...event, ignoredOnly } : event);
      }
    });

    return yield* Effect.forever(step).pipe(Effect.ensuring(closeHandle));
  });

  const closeIfIdle = Effect.fn("WorkspaceWatcher.closeIfIdle")(function* (
    root: string,
    idleToken: number,
  ) {
    const closed = yield* SynchronizedRef.modify(activeRef, (active) => {
      const existing = active.get(root);
      if (!existing || existing.subscribers > 0 || existing.idleToken !== idleToken) {
        return [null, active] as const;
      }
      const next = new Map(active);
      next.delete(root);
      return [existing, next] as const;
    });
    if (closed !== null) {
      yield* Fiber.interrupt(closed.fiber);
      yield* PubSub.shutdown(closed.pubsub);
    }
  });

  const retain = (cwd: string, root: string) =>
    SynchronizedRef.modifyEffect(activeRef, (active) =>
      Effect.gen(function* () {
        const existing = active.get(root);
        if (existing) {
          const next = new Map(active).set(root, {
            ...existing,
            subscribers: existing.subscribers + 1,
            idleToken: null,
          });
          return [existing.pubsub, next] as const;
        }
        const signals = yield* Queue.unbounded<WatchSignal>();
        const handle = yield* openWatchers(cwd, root, signals);
        const pubsub = yield* PubSub.unbounded<WorkspaceChangeEvent>();
        // Forked from inside the stream's (uninterruptible) acquire step, so
        // say explicitly that closing the watch may interrupt it.
        const fiber = yield* runRootWatch(cwd, root, signals, pubsub, handle).pipe(
          Effect.interruptible,
          Effect.forkIn(watcherScope),
        );
        const next = new Map(active).set(root, { pubsub, fiber, subscribers: 1, idleToken: null });
        return [pubsub, next] as const;
      }),
    );

  const release = (root: string) =>
    SynchronizedRef.modifyEffect(activeRef, (active) =>
      Effect.gen(function* () {
        const existing = active.get(root);
        if (!existing) {
          return [undefined, active] as const;
        }
        if (existing.subscribers > 1) {
          const next = new Map(active).set(root, {
            ...existing,
            subscribers: existing.subscribers - 1,
          });
          return [undefined, next] as const;
        }
        nextIdleToken += 1;
        const idleToken = nextIdleToken;
        yield* Effect.sleep(Duration.millis(lingerMs)).pipe(
          Effect.andThen(closeIfIdle(root, idleToken)),
          Effect.interruptible,
          Effect.forkIn(watcherScope),
        );
        const next = new Map(active).set(root, { ...existing, subscribers: 0, idleToken });
        return [undefined, next] as const;
      }),
    );

  const watch: WorkspaceWatcher["Service"]["watch"] = (cwd) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(cwd),
          catch: (cause) =>
            new WorkspaceWatchError({
              cwd,
              message: `Couldn't watch '${cwd}' for changes: ${describeWatchFailure(cause)}.`,
              cause,
            }),
        });
        if (!(yield* rootIsDirectory(root))) {
          return yield* new WorkspaceWatchError({
            cwd,
            message: `Couldn't watch '${cwd}' for changes: it isn't a folder.`,
          });
        }
        const pubsub = yield* Effect.acquireRelease(retain(cwd, root), () => release(root));
        const subscription = yield* PubSub.subscribe(pubsub);
        return Stream.fromSubscription(subscription);
      }),
    );

  return WorkspaceWatcher.of({ watch });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeWithOptions();

export const layer = Layer.effect(WorkspaceWatcher, make);

export const layerWithOptions = (options: WorkspaceWatcherOptions) =>
  Layer.effect(WorkspaceWatcher, makeWithOptions(options));
