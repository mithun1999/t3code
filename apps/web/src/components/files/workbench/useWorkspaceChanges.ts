import type { EnvironmentId, WorkspaceChangeEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useLayoutEffect, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { workspaceIde } from "~/state/workspaceIde";

/**
 * Calls `onChange` for every batch of on-disk changes under each root while
 * the caller is mounted. Each root has one watcher on the server, shared by
 * every view that listens to it.
 */
export function useWorkspaceChanges(
  environmentId: EnvironmentId,
  roots: readonly string[],
  onChange: (root: string, event: WorkspaceChangeEvent) => void,
): void {
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const rootsKey = [...new Set(roots)].join("\0");
  useEffect(() => {
    if (!rootsKey) return;
    const unsubscribes = rootsKey.split("\0").map((root) => {
      let lastSequence: number | null = null;
      return appAtomRegistry.subscribe(
        workspaceIde.changes({ environmentId, input: { cwd: root } }),
        (result) => {
          const notice = Option.getOrNull(AsyncResult.value(result));
          const sequence = notice?.sequence ?? 0;
          // The immediate first call only primes: its batch, if any, happened
          // before this view subscribed.
          if (lastSequence === null || !notice || sequence === lastSequence) {
            lastSequence = sequence;
            return;
          }
          lastSequence = sequence;
          onChangeRef.current(root, notice.event);
        },
        { immediate: true },
      );
    });
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [environmentId, rootsKey]);
}

/** Whether a change batch touches `relativePath` (root-relative), or can't tell. */
export function changeTouchesFile(event: WorkspaceChangeEvent, relativePath: string): boolean {
  return event.overflow || event.files.includes(relativePath);
}
