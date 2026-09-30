import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { readLocalApi } from "~/localApi";
import { toastManager } from "~/components/ui/toast";

/** The message to show for a failed command, or null when it was only cancelled. */
export function commandFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : "Something went wrong.";
}

/** The `failure` tag of a typed command error, e.g. "already_exists". */
export function commandFailureKind(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" && error !== null && "failure" in error
    ? String((error as { failure: unknown }).failure)
    : null;
}

/** Toasts a failed command. Returns whether it succeeded. */
export function reportCommandResult(
  result: AtomCommandResult<unknown, unknown>,
  title: string,
): boolean {
  const message = commandFailureMessage(result);
  if (result._tag === "Success") return true;
  if (message !== null) toastManager.add({ type: "error", title, description: message });
  return false;
}

export async function confirmAction(
  message: string,
  variant: "default" | "destructive" = "destructive",
): Promise<boolean> {
  const api = readLocalApi();
  if (!api) return window.confirm(message);
  return api.dialogs.confirm(message, { variant });
}
