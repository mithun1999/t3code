/**
 * Web-only atoms behind the VS Code-style explorer and source control views:
 * on-disk change streams, git status per repo, and the file and git commands.
 */
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type WorkspaceChangeEvent, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

/** A change event numbered so two identical batches still read as two updates. */
export interface WorkspaceChangeNotice {
  readonly sequence: number;
  readonly event: WorkspaceChangeEvent;
}

const entryScheduler = createAtomCommandScheduler();
const scmScheduler = createAtomCommandScheduler();
// Git takes a lock on the index, so commands against one repo run one at a time.
const scmConcurrency = {
  mode: "serial" as const,
  key: ({ environmentId, input }: { environmentId: string; input: { cwd: string } }) =>
    JSON.stringify([environmentId, input.cwd]),
};

export const workspaceIde = {
  changes: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:workspace:changes",
    tag: WS_METHODS.subscribeWorkspaceChanges,
    idleTtlMs: 30_000,
    transform: (stream) =>
      stream.pipe(
        Stream.mapAccum(
          () => 0,
          (sequence, event) => {
            const next = sequence + 1;
            return [next, [{ sequence: next, event } satisfies WorkspaceChangeNotice]] as const;
          },
        ),
      ),
  }),
  scmStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:scm:status",
    tag: WS_METHODS.scmStatus,
    staleTimeMs: 1_000,
    idleTtlMs: 5 * 60_000,
  }),
  scmReadFile: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:scm:read-file",
    tag: WS_METHODS.scmReadFile,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
  }),
  createEntry: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:workspace:create-entry",
    tag: WS_METHODS.workspaceCreateEntry,
    scheduler: entryScheduler,
  }),
  moveEntry: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:workspace:move-entry",
    tag: WS_METHODS.workspaceMoveEntry,
    scheduler: entryScheduler,
  }),
  copyEntry: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:workspace:copy-entry",
    tag: WS_METHODS.workspaceCopyEntry,
    scheduler: entryScheduler,
  }),
  deleteEntries: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:workspace:delete-entries",
    tag: WS_METHODS.workspaceDeleteEntries,
    scheduler: entryScheduler,
  }),
  replaceInFiles: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:workspace:replace-in-files",
    tag: WS_METHODS.workspaceReplaceInFiles,
    scheduler: entryScheduler,
  }),
  stage: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scm:stage",
    tag: WS_METHODS.scmStage,
    scheduler: scmScheduler,
    concurrency: scmConcurrency,
  }),
  unstage: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scm:unstage",
    tag: WS_METHODS.scmUnstage,
    scheduler: scmScheduler,
    concurrency: scmConcurrency,
  }),
  discard: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scm:discard",
    tag: WS_METHODS.scmDiscard,
    scheduler: scmScheduler,
    concurrency: scmConcurrency,
  }),
  commit: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scm:commit",
    tag: WS_METHODS.scmCommit,
    scheduler: scmScheduler,
    concurrency: scmConcurrency,
  }),
};
