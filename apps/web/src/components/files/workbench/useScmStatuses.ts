import type { EnvironmentId, ScmStatusResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { workspaceIde } from "~/state/workspaceIde";

import { useWorkspaceChanges } from "./useWorkspaceChanges";

/** Waits for a burst of saves (an agent editing many files) to settle. */
const STATUS_REFRESH_DELAY_MS = 250;
const STATUS_REFRESH_MIN_GAP_MS = 1000;

export interface ScmRepoState {
  readonly root: string;
  readonly status: ScmStatusResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface ScmStatuses {
  readonly repos: readonly ScmRepoState[];
  readonly byRoot: ReadonlyMap<string, ScmRepoState>;
  /** Re-reads git status now, for one repo or all of them. */
  readonly refresh: (root?: string) => void;
}

function repoState(root: string, result: AsyncResult.AsyncResult<ScmStatusResult, unknown>) {
  const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
  return {
    root,
    // The last good status stays up while a refresh runs or fails.
    status: Option.getOrNull(AsyncResult.value(result)),
    error: cause === null ? null : cause instanceof Error ? cause.message : "Git status failed.",
    isPending: result.waiting,
  } satisfies ScmRepoState;
}

/**
 * Git status for each repo, kept current by the server's file watcher: any
 * change on disk, or to git's index and refs, re-reads the repo's status.
 */
export function useScmStatuses(
  environmentId: EnvironmentId,
  roots: readonly string[],
): ScmStatuses {
  const rootsKey = [...new Set(roots)].join("\0");
  const uniqueRoots = useMemo(() => (rootsKey ? rootsKey.split("\0") : []), [rootsKey]);
  const [results, setResults] = useState<ReadonlyMap<string, ScmRepoState>>(new Map());

  useEffect(() => {
    const unsubscribes = uniqueRoots.map((root) =>
      appAtomRegistry.subscribe(
        workspaceIde.scmStatus({ environmentId, input: { cwd: root } }),
        (result) => {
          setResults((previous) => new Map(previous).set(root, repoState(root, result)));
        },
        { immediate: true },
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [environmentId, uniqueRoots]);

  const refresh = useCallback(
    (root?: string) => {
      for (const target of root === undefined ? uniqueRoots : [root]) {
        appAtomRegistry.refresh(workspaceIde.scmStatus({ environmentId, input: { cwd: target } }));
      }
    },
    [environmentId, uniqueRoots],
  );

  // One pending refresh per repo: a burst of saves shares it, and a steady
  // stream refreshes at most every STATUS_REFRESH_MIN_GAP_MS.
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastRefreshRef = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useWorkspaceChanges(environmentId, uniqueRoots, (root, event) => {
    // Build output and caches changing can't change git status.
    if (event.ignoredOnly) return;
    const timers = timersRef.current;
    if (timers.has(root)) return;
    const sinceLast = Date.now() - (lastRefreshRef.current.get(root) ?? 0);
    timers.set(
      root,
      setTimeout(
        () => {
          timers.delete(root);
          lastRefreshRef.current.set(root, Date.now());
          refresh(root);
        },
        Math.max(STATUS_REFRESH_DELAY_MS, STATUS_REFRESH_MIN_GAP_MS - sinceLast),
      ),
    );
  });

  return useMemo(() => {
    const byRoot = new Map<string, ScmRepoState>();
    for (const root of uniqueRoots) {
      byRoot.set(root, results.get(root) ?? { root, status: null, error: null, isPending: true });
    }
    return { repos: [...byRoot.values()], byRoot, refresh };
  }, [refresh, results, uniqueRoots]);
}
