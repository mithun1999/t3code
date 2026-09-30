import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

/** A repo root shown as its own top-level tree node in multi-repo workspaces (#923). */
export interface DirectoryEntriesRoot {
  readonly root: string;
  readonly label: string;
}

interface DirectorySource {
  readonly label: string;
  readonly root: string;
}

/**
 * Folder listings for one tree, kept outside React so closing the Files panel
 * and coming back shows the tree at once, as it was, and only revalidates it.
 */
interface DirectoryStore {
  directories: ReadonlyMap<string, readonly ProjectEntry[]>;
  errors: ReadonlyMap<string, string>;
  /** Folders listed at least once; the ones a refresh brings up to date. */
  readonly requested: Set<string>;
  readonly inflight: Map<string, Promise<void>>;
  /** Tree paths of the folders that were expanded, restored on the next mount. */
  expanded: readonly string[];
  /** Loads of folders that have nothing to show yet. Refreshes don't count. */
  initialLoads: number;
  syncedRootsKey: string | null;
  running: number;
  readonly waiting: Array<() => void>;
  version: number;
  lastUsedAt: number;
  readonly listeners: Set<() => void>;
}

const MAX_CACHED_TREES = 12;
const MAX_CONCURRENT_LOADS = 4;
const stores = new Map<string, DirectoryStore>();

function directoryStore(key: string): DirectoryStore {
  const existing = stores.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const store: DirectoryStore = {
    directories: new Map(),
    errors: new Map(),
    requested: new Set(),
    inflight: new Map(),
    expanded: [],
    initialLoads: 0,
    syncedRootsKey: null,
    running: 0,
    waiting: [],
    version: 0,
    lastUsedAt: Date.now(),
    listeners: new Set(),
  };
  stores.set(key, store);
  const unused = [...stores.entries()]
    .filter(([, candidate]) => candidate.listeners.size === 0)
    .toSorted(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
  for (const [staleKey] of unused.slice(0, Math.max(0, stores.size - MAX_CACHED_TREES))) {
    stores.delete(staleKey);
  }
  return store;
}

function publish(store: DirectoryStore): void {
  store.version += 1;
  for (const listener of store.listeners) listener();
}

async function withLoadSlot<A>(store: DirectoryStore, run: () => Promise<A>): Promise<A> {
  if (store.running >= MAX_CONCURRENT_LOADS) {
    await new Promise<void>((resolve) => store.waiting.push(resolve));
  } else {
    store.running += 1;
  }
  try {
    return await run();
  } finally {
    const next = store.waiting.shift();
    if (next) next();
    else store.running -= 1;
  }
}

/** Parses the roots key back into sources, longest label first so a nested label wins. */
function parseSources(rootsKey: string): readonly DirectorySource[] | null {
  if (!rootsKey) return null;
  return rootsKey
    .split("\0\0")
    .map((pair) => {
      const [label = "", root = ""] = pair.split("\0");
      return { label, root };
    })
    .sort((left, right) => right.label.length - left.label.length);
}

function rememberExpandedPaths(store: DirectoryStore, paths: readonly string[]): void {
  store.expanded = paths;
}

interface LoadContext {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly rootsKey: string;
  readonly sources: readonly DirectorySource[] | null;
}

function loadDirectory(
  store: DirectoryStore,
  context: LoadContext,
  directoryPath: string,
  refresh = false,
): Promise<void> {
  const { environmentId, cwd, rootsKey, sources } = context;
  if (sources && directoryPath === "") {
    // The repo nodes are synthesized locally; rebuild only when the roots change.
    if (store.syncedRootsKey === rootsKey) return Promise.resolve();
    store.syncedRootsKey = rootsKey;
    store.directories = new Map(store.directories).set(
      "",
      sources.map(({ label, root }) => ({ path: label, kind: "directory", root })),
    );
    publish(store);
    return Promise.resolve();
  }
  const existing = store.inflight.get(directoryPath);
  if (existing)
    return refresh
      ? existing.then(() => loadDirectory(store, context, directoryPath, true))
      : existing;
  const hasListing = store.directories.has(directoryPath);
  if (!refresh && hasListing) return Promise.resolve();
  const source = sources
    ? sources.find(({ label }) => directoryPath === label || directoryPath.startsWith(`${label}/`))
    : { label: "", root: cwd };
  // Not under any repo label (e.g. an ancestor of a nested label): nothing to load.
  if (!source) return Promise.resolve();
  const prefix = sources ? `${source.label}/` : "";
  const relativeDirectory = sources ? directoryPath.slice(source.label.length + 1) : directoryPath;
  store.requested.add(directoryPath);
  const atom = projectEnvironment.listEntries({
    environmentId,
    input: { cwd: source.root, directoryPath: relativeDirectory },
  });
  // Only a folder with nothing on screen yet counts as loading; a refresh
  // swaps its listing in place.
  if (!hasListing) {
    store.initialLoads += 1;
    publish(store);
  }
  const request = withLoadSlot(store, () =>
    executeAtomQuery(appAtomRegistry, atom, {
      refresh: true,
      reportFailure: false,
      reportDefect: false,
    }),
  )
    .then((result) => {
      if (result._tag === "Success") {
        store.directories = new Map(store.directories).set(
          directoryPath,
          result.value.entries
            .filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === relativeDirectory,
            )
            .map((entry) =>
              sources ? { ...entry, path: `${prefix}${entry.path}`, root: source.root } : entry,
            ),
        );
        if (store.errors.has(directoryPath)) {
          const errors = new Map(store.errors);
          errors.delete(directoryPath);
          store.errors = errors;
        }
      } else if (!hasListing) {
        // Only a first load reports failure. A failed refresh keeps the old
        // listing; a folder deleted on disk leaves when its parent is re-listed.
        const cause = Cause.squash(result.cause);
        store.errors = new Map(store.errors).set(
          directoryPath,
          cause instanceof Error ? cause.message : "Unable to load folder.",
        );
      }
    })
    .finally(() => {
      store.inflight.delete(directoryPath);
      if (!hasListing) store.initialLoads -= 1;
      publish(store);
    });
  store.inflight.set(directoryPath, request);
  return request;
}

/** The tree folder a root-relative folder of `root` appears as. */
export function treeDirectoryForRoot(
  roots: readonly DirectoryEntriesRoot[] | undefined,
  root: string,
  directory: string,
): string | null {
  if (!roots || roots.length === 0) return directory;
  const source = roots.find((candidate) => candidate.root === root);
  if (!source) return null;
  return directory ? `${source.label}/${directory}` : source.label;
}

/**
 * Loads only requested directories; collapsing a folder keeps its children cached.
 *
 * Directory keys and entry paths are tree paths. With `roots`, the top level is
 * one directory per repo (its label) and `label/sub` loads `sub` from that repo;
 * entries come back tagged with `root` so callers can strip the label again.
 */
export function useDirectoryEntries(
  environmentId: EnvironmentId,
  cwd: string,
  roots?: readonly DirectoryEntriesRoot[],
) {
  const rootsKey = roots?.map((entry) => `${entry.label}\0${entry.root}`).join("\0\0") ?? "";
  const storeKey = `${environmentId}\0${cwd}\0${rootsKey}`;
  const store = useMemo(() => directoryStore(storeKey), [storeKey]);
  const sources = useMemo(() => parseSources(rootsKey), [rootsKey]);
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
        store.lastUsedAt = Date.now();
      };
    },
    [store],
  );
  useSyncExternalStore(
    subscribe,
    () => store.version,
    () => store.version,
  );

  const load = useCallback(
    (directoryPath: string, refresh = false) =>
      loadDirectory(store, { environmentId, cwd, rootsKey, sources }, directoryPath, refresh),
    [cwd, environmentId, rootsKey, sources, store],
  );

  const directories = store.directories;
  const entries = useMemo(() => {
    const result: ProjectEntry[] = [];
    const visit = (path: string) => {
      for (const entry of directories.get(path) ?? []) {
        result.push(entry);
        if (entry.kind === "directory") visit(entry.path);
      }
    };
    visit("");
    return result;
  }, [directories]);

  const reachableDirectories = useMemo(
    () =>
      new Set([
        "",
        ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
      ]),
    [entries],
  );

  /** Re-lists the given folders, or every visited one, keeping expansion as is. */
  const refresh = useCallback(
    (only?: Iterable<string>) => {
      const wanted = only ? new Set(only) : null;
      const paths = [...store.requested].filter(
        (path) => reachableDirectories.has(path) && (wanted === null || wanted.has(path)),
      );
      for (const path of paths) void load(path, true);
    },
    [load, reachableDirectories, store],
  );

  const rememberExpanded = useCallback(
    (paths: readonly string[]) => rememberExpandedPaths(store, paths),
    [store],
  );

  useEffect(() => {
    const hadListing = store.directories.has("");
    void load("");
    // Cached folders show at once; bring them up to date behind the scenes.
    if (hadListing) {
      for (const path of store.requested) void load(path, true);
    }
  }, [load, store]);

  return {
    entries,
    load,
    refresh,
    rememberExpanded,
    /** Folders that were expanded the last time this tree was shown. */
    initialExpandedPaths: store.expanded,
    isPending: store.initialLoads > 0,
    ready: directories.has(""),
    error: [...store.errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
  };
}
