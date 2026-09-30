import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { createRef, type RefObject, useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

/**
 * Lets an editor make its saves conflict-safe: each write names the revision
 * it was based on, and the server refuses it if the file changed since.
 */
export interface FileSaveHooks {
  /** The disk revision the edits are based on. */
  expectedRevision(): string | undefined;
  /** Saves wait while this is true, e.g. while a conflict is unresolved. */
  isBlocked(): boolean;
  onSaved(contents: string, revision: string | undefined): void;
  /** The file changed on disk since `expectedRevision`; nothing was written. */
  onConflict(): void;
}

function readHooks(hooks: RefObject<FileSaveHooks | null> | undefined): FileSaveHooks | null {
  return hooks?.current ?? null;
}

function isRevisionConflict(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    (error as { failure: unknown }).failure === "revision_conflict"
  );
}

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  // Multi-repo workspaces (#923): the repo root that owns this file, forwarded
  // to `onPendingChange` so the pending state lands on the surface that opened
  // it in a non-anchor repo. Absent for single-repo projects.
  root?: string | undefined;
  onPendingChange: (relativePath: string, pending: boolean, root?: string | undefined) => void;
  hooks?: RefObject<FileSaveHooks | null>;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  root,
  onPendingChange,
  hooks,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change" | "flush"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      flush: () => coordinatorRef.current?.flush(),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => onPendingChange(relativePath, pending, root),
          persist: async (nextContents) => {
            const saveHooks = readHooks(hooks);
            if (saveHooks?.isBlocked()) {
              return AsyncResult.failure(Cause.fail(new Error("Save paused on a conflict.")));
            }
            const expectedRevision = saveHooks?.expectedRevision();
            const result = await writeFile({
              environmentId,
              input: {
                cwd,
                relativePath,
                contents: nextContents,
                ...(expectedRevision === undefined ? {} : { expectedRevision }),
              },
            });
            if (result._tag === "Success") saveHooks?.onSaved(nextContents, result.value.revision);
            else if (isRevisionConflict(result.cause)) saveHooks?.onConflict();
            return result;
          },
          onConfirmed: (confirmedContents) => {
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, hooks, onPendingChange, relativePath, root, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
