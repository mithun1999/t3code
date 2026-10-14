import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadFork } from "../state/agentSessions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";

const FORK_ARRIVAL_TIMEOUT_MS = 10_000;

/** Claude copies its session for a fork; other providers cannot yet. */
export function readThreadSupportsFork(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): boolean {
  const providers = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.providers;
  return (
    providers?.find((provider) => provider.instanceId === instanceId)?.driver === "claudeAgent"
  );
}

async function waitForThread(ref: ScopedThreadRef): Promise<boolean> {
  const deadline = Date.now() + FORK_ARRIVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readThreadShell(ref) !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Fork a thread and open the copy once it reaches this client. */
export function useForkThread() {
  const router = useRouter();
  const forkThread = useAtomCommand(threadFork, { reportFailure: false });
  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const result = await forkThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not fork thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const forkRef = scopeThreadRef(threadRef.environmentId, result.value.threadId);
      if (await waitForThread(forkRef)) {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(forkRef),
        });
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Thread forked",
          description: "The fork continues on its own. The original thread is unchanged.",
        }),
      );
    },
    [forkThread, router],
  );
}
