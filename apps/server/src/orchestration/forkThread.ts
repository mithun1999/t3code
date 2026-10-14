import {
  CommandId,
  MessageId,
  ThreadForkError,
  ThreadId,
  type ThreadForkInput,
  type ThreadForkResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const BUSY_SESSION_STATUSES = new Set(["starting", "running"]);

/**
 * Copy a thread into a new one in the same project that continues on its
 * own: the provider conversation is forked, the visible messages are copied
 * as history, and the new thread starts active. The source is untouched.
 */
export const forkThread = Effect.fn("forkThread")(function* (input: ThreadForkInput) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const providerService = yield* ProviderService.ProviderService;
  const crypto = yield* Crypto.Crypto;
  const fail = (detail: string) => new ThreadForkError({ threadId: input.threadId, detail });

  const source = Option.getOrUndefined(
    yield* snapshots
      .getThreadDetailById(input.threadId)
      .pipe(Effect.mapError(() => fail("Could not read the thread to fork."))),
  );
  if (source === undefined || source.deletedAt !== null) {
    return yield* fail("This thread no longer exists.");
  }
  if (
    (source.session !== null && BUSY_SESSION_STATUSES.has(source.session.status)) ||
    source.latestTurn?.state === "running"
  ) {
    return yield* fail("Wait for the current turn to finish before forking.");
  }
  const messages = source.messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  if (messages.length === 0) {
    return yield* fail("There is nothing to fork yet.");
  }
  if (providerService.forkSession === undefined) {
    return yield* fail("Forking is not available on this server.");
  }

  const threadId = ThreadId.make(
    yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => fail("Could not create the fork."))),
  );
  const forked = yield* providerService
    .forkSession({ sourceThreadId: source.id, targetThreadId: threadId })
    .pipe(Effect.mapError((cause) => fail(cause.message)));
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const commandId = Effect.map(crypto.randomUUIDv4, (id) => CommandId.make(id));

  return yield* Effect.gen(function* () {
    // Install the cursor before the thread becomes visible, so its first turn
    // resumes the copied conversation instead of starting a fresh one.
    yield* directory.upsert({
      threadId,
      provider: forked.provider,
      providerInstanceId: forked.providerInstanceId,
      status: "stopped",
      runtimeMode: forked.runtimeMode ?? source.runtimeMode,
      resumeCursor: forked.resumeCursor,
      runtimePayload: { cwd: forked.cwd ?? null, modelSelection: source.modelSelection },
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: yield* commandId,
      threadId,
      projectId: source.projectId,
      title: `${source.title} fork`,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      ...(source.worktrees.length > 0 ? { worktrees: source.worktrees } : {}),
      createdAt,
      historyImport: true,
    });
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: yield* commandId,
      threadId,
      messages: messages.map((message, index) => ({
        messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        text: message.text,
        createdAt: message.createdAt,
      })),
    });
    // Imported history lands settled; a fork is work in progress.
    yield* engine.dispatch({
      type: "thread.unsettle",
      commandId: yield* commandId,
      threadId,
      reason: "user",
    });
    return { threadId } satisfies ThreadForkResult;
  }).pipe(Effect.mapError((cause) => fail(`Could not create the fork: ${cause.message}`)));
});
