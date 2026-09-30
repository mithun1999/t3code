import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type OrchestrationThreadWorktree,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  checkpointStartRefForThreadTurn,
  resolveThreadRepoRoots,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

function threadWorktreePaths(thread: {
  readonly worktreePath: string | null;
  readonly worktrees: ReadonlyArray<{ readonly worktreePath: string }>;
}): ReadonlyArray<string> {
  const paths = new Set(thread.worktrees.map((entry) => entry.worktreePath));
  if (thread.worktreePath !== null) paths.add(thread.worktreePath);
  return [...paths];
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const activityRepository = yield* ProjectionThreadActivityRepository;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const queuedEntryRefreshes = new Set<string>();
  const entryRefreshWorker = yield* makeDrainableWorker((cwd: string) =>
    Effect.sync(() => queuedEntryRefreshes.delete(cwd)).pipe(
      Effect.andThen(workspaceEntries.refresh(cwd)),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () =>
          Effect.logWarning("failed to refresh checkpoint workspace entries", {
            cwd,
          }),
      ),
    ),
  );
  const refreshWorkspaceEntries = Effect.fn("refreshWorkspaceEntries")(function* (cwd: string) {
    if (queuedEntryRefreshes.has(cwd)) return;
    queuedEntryRefreshes.add(cwd);
    yield* entryRefreshWorker.enqueue(cwd);
  });

  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendFilesRestoredActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-files-restored"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "info",
            kind: "checkpoint.files.restored",
            summary: "Files restored",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const isGitWorkspace = (cwd: string) => checkpointStore.isGitRepository(cwd);

  // Resolves the full ordered set of git roots a thread's checkpoints should
  // span (multi-repo). Prefers the project's configured repo roots (or the
  // thread's worktree), filtered to git repositories. Falls back to the active
  // provider session CWD when project config yields no git roots (pre-migration
  // threads, or before a project's roots are resolved). Returns an empty array
  // when no git root can be determined.
  const resolveCheckpointRoots = Effect.fn("resolveCheckpointRoots")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly worktrees?: ReadonlyArray<OrchestrationThreadWorktree> | undefined;
    };
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly workspaceRoot: string;
      readonly repoRoots?: ReadonlyArray<string> | undefined;
    }>;
  }): Effect.fn.Return<ReadonlyArray<string>, CheckpointStoreError> {
    const project = input.projects.find((candidate) => candidate.id === input.thread.projectId);
    const configRoots = project
      ? resolveThreadRepoRoots({
          worktreePath: input.thread.worktreePath,
          worktrees: input.thread.worktrees,
          repoRoots: project.repoRoots ?? [],
          workspaceRoot: project.workspaceRoot,
        })
      : [];
    const gitConfigRoots: Array<string> = [];
    for (const root of configRoots) {
      if (yield* isGitWorkspace(root)) {
        gitConfigRoots.push(root);
      }
    }
    if (gitConfigRoots.length > 0) {
      return gitConfigRoots;
    }

    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const sessionCwd = Option.match(fromSession, {
      onNone: () => undefined,
      onSome: (runtime) => runtime.cwd,
    });
    if (sessionCwd && (yield* isGitWorkspace(sessionCwd))) {
      return [sessionCwd];
    }
    return [];
  });

  // Captures a pre-turn baseline ref in every root that doesn't already have it.
  // Best-effort per root; returns true when at least one root was newly captured
  // (so callers only emit the baseline receipt when work actually happened).
  const captureBaselineAcrossRoots = Effect.fn("captureBaselineAcrossRoots")(function* (input: {
    readonly threadId: ThreadId;
    readonly roots: ReadonlyArray<string>;
    readonly baselineCheckpointRef: CheckpointRef;
  }): Effect.fn.Return<boolean> {
    const results = yield* Effect.forEach(
      input.roots,
      (root) =>
        Effect.gen(function* () {
          const exists = yield* checkpointStore.hasCheckpointRef({
            cwd: root,
            checkpointRef: input.baselineCheckpointRef,
          });
          if (exists) {
            return false;
          }
          yield* checkpointStore.captureCheckpoint({
            cwd: root,
            checkpointRef: input.baselineCheckpointRef,
          });
          return true;
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("pre-turn baseline capture failed for root", {
              threadId: input.threadId,
              root,
              detail: error.message,
            }).pipe(Effect.as(false)),
          ),
        ),
      { concurrency: 4 },
    );
    return results.some((captured) => captured);
  });

  // Records the files as the turn found them, including edits made since the last turn.
  const captureTurnStartAcrossRoots = Effect.fn("captureTurnStartAcrossRoots")(function* (input: {
    readonly threadId: ThreadId;
    readonly roots: ReadonlyArray<string>;
    readonly startCheckpointRef: CheckpointRef;
  }) {
    yield* Effect.forEach(
      input.roots,
      (root) =>
        checkpointStore
          .captureCheckpoint({ cwd: root, checkpointRef: input.startCheckpointRef })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("turn start capture failed for root", {
                threadId: input.threadId,
                root,
                detail: error.message,
              }),
            ),
          ),
      { concurrency: 4, discard: true },
    );
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly roots: ReadonlyArray<string>;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const previousCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const startCheckpointRef = checkpointStartRefForThreadTurn(input.threadId, input.turnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    // Capture + diff every repo root (multi-repo). Best-effort per root: a repo
    // that fails to capture is logged and excluded rather than aborting the
    // whole checkpoint. Results preserve `roots` order regardless of concurrency.
    const captureOneRoot = Effect.fn("captureOneRoot")(function* (root: string) {
      // The turn's own start leaves out edits made between turns.
      const fromCheckpointRef = (yield* checkpointStore
        .hasCheckpointRef({ cwd: root, checkpointRef: startCheckpointRef })
        .pipe(Effect.orElseSucceed(() => false)))
        ? startCheckpointRef
        : previousCheckpointRef;
      const fromCheckpointExists = yield* checkpointStore
        .hasCheckpointRef({
          cwd: root,
          checkpointRef: fromCheckpointRef,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("checkpoint capture previous ref lookup failed", {
              threadId: input.threadId,
              checkpointRef: fromCheckpointRef,
              root,
              category: error._tag,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!fromCheckpointExists) {
        yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
          threadId: input.threadId,
          turnId: input.turnId,
          fromTurnCount,
          root,
        });
      }

      yield* checkpointStore.captureCheckpoint({ cwd: root, checkpointRef: targetCheckpointRef });

      // Invalidate the workspace entry cache so the @-mention file picker
      // reflects files created or deleted during this turn.
      yield* refreshWorkspaceEntries(root);

      // Git may have been initialized during this turn, leaving no pre-turn
      // snapshot. Keep the completion checkpoint for future turns, but do not
      // invent a baseline or attempt a diff against a ref that does not exist.
      return yield* (
        fromCheckpointExists
          ? checkpointStore.diffCheckpoints({
              cwd: root,
              fromCheckpointRef,
              toCheckpointRef: targetCheckpointRef,
              fallbackFromToHead: false,
              ignoreWhitespace: false,
              format: "numstat",
            })
          : Effect.succeed("")
      ).pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromNumstat(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
            // Two repos can change the same relative path.
            ...(input.roots.length > 1 ? { repoRoot: root } : {}),
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable for ${root}: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            root,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );
    });

    const perRoot = yield* Effect.forEach(
      input.roots,
      (root) =>
        captureOneRoot(root).pipe(
          Effect.map((files) => ({ root, files })),
          Effect.catch((error) =>
            Effect.logWarning("checkpoint capture failed for root", {
              threadId: input.threadId,
              turnId: input.turnId,
              turnCount: input.turnCount,
              root,
              detail: error.message,
            }).pipe(Effect.as(null)),
          ),
        ),
      { concurrency: 4 },
    );
    const captured = perRoot.flatMap((entry) => (entry === null ? [] : [entry]));

    if (captured.length === 0) {
      yield* Effect.logWarning("checkpoint capture produced no roots", {
        threadId: input.threadId,
        turnId: input.turnId,
        turnCount: input.turnCount,
      });
      return;
    }

    const files = captured.flatMap((entry) => entry.files);
    const checkpointRefs = captured.map((entry) => ({
      repoRoot: entry.root,
      checkpointRef: targetCheckpointRef,
    }));

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);
    // Lets clients offer rewind on a turn that was stopped before any reply.
    const userMessageId = yield* projectionTurnRepository
      .getByTurnId({ threadId: input.threadId, turnId: input.turnId })
      .pipe(
        Effect.map((turn) => Option.getOrUndefined(turn)?.pendingMessageId ?? undefined),
        Effect.orElseSucceed(() => undefined),
      );

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      checkpointRefs,
      status: input.status,
      files,
      assistantMessageId,
      ...(userMessageId !== undefined ? { userMessageId } : {}),
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointRoots = yield* resolveCheckpointRoots({
        threadId: thread.id,
        thread,
        projects,
      });
      if (checkpointRoots.length === 0) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        roots: checkpointRoots,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointRoots = yield* resolveCheckpointRoots({
      threadId,
      thread,
      projects,
    });
    if (checkpointRoots.length === 0) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      roots: checkpointRoots,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>, isNewTurn: boolean) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointRoots = yield* resolveCheckpointRoots({
        threadId: thread.id,
        thread,
        projects,
      });
      if (checkpointRoots.length === 0) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const captured = yield* captureBaselineAcrossRoots({
        threadId: thread.id,
        roots: checkpointRoots,
        baselineCheckpointRef,
      });
      if (isNewTurn) {
        // Replaces any start left by a turn that ended without a checkpoint.
        yield* captureTurnStartAcrossRoots({
          threadId: thread.id,
          roots: checkpointRoots,
          startCheckpointRef: checkpointStartRefForThreadTurn(thread.id, currentTurnCount + 1),
        });
      }
      if (!captured) {
        return;
      }
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("failed to follow worktree branch drift", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  // Refreshing git status ends in a remote PR lookup under the vcs status
  // write lock. Run it on its own worker so file capture for this turn (and
  // checkpoints for other threads) never wait behind that network call.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      refreshLocalGitStatusFromTurnCompletion(event).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () =>
            Effect.logWarning("failed to refresh git status after turn completion", {
              threadId: event.threadId,
            }),
        ),
      ),
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      // A bootstrap message lands before the worktree exists; its baseline
      // would snapshot the project checkout. The turn-start event that
      // follows captures it against the right cwd.
      if (
        event.metadata.historyImport === true ||
        event.metadata.deferredTurn === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointRoots = yield* resolveCheckpointRoots({
      threadId,
      thread,
      projects,
    });
    if (checkpointRoots.length === 0) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const captured = yield* captureBaselineAcrossRoots({
      threadId,
      roots: checkpointRoots,
      baselineCheckpointRef,
    });
    if (!captured) {
      return;
    }
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  // Checkpoints contain the whole checkout, so restoring a shared cwd can erase a sibling's work.
  // A multi-repo thread owns one worktree per repo root, so `cwd` may be any of them.
  const isRestoreWorkspaceIsolated = Effect.fn("isRestoreWorkspaceIsolated")(function* (
    thread: {
      readonly id: ThreadId;
      readonly worktreePath: string | null;
      readonly worktrees: ReadonlyArray<{ readonly worktreePath: string }>;
    },
    cwd: string,
  ) {
    const ownWorktrees = threadWorktreePaths(thread);
    if (ownWorktrees.length === 0) return false;
    const canonicalCwd = yield* fileSystem.realPath(cwd);
    const ownCanonical = yield* Effect.forEach(ownWorktrees, (worktreePath) =>
      fileSystem.realPath(worktreePath),
    );
    if (!ownCanonical.includes(canonicalCwd)) return false;
    const active = yield* projectionSnapshotQuery.getShellSnapshot();
    const archived = yield* projectionSnapshotQuery.getArchivedShellSnapshot();
    const projects = [...active.projects, ...archived.projects];
    const paths = new Set<string>();
    for (const other of [...active.threads, ...archived.threads]) {
      if (other.id === thread.id) continue;
      const otherWorktrees = threadWorktreePaths(other);
      if (otherWorktrees.length > 0) {
        for (const worktreePath of otherWorktrees) paths.add(worktreePath);
        continue;
      }
      // A workspace file can list repos outside its container, so a checkout
      // thread owns every repo root, not just the workspace root.
      const project = projects.find((candidate) => candidate.id === other.projectId);
      if (project === undefined) continue;
      paths.add(project.workspaceRoot);
      for (const repoRoot of project.repoRoots ?? []) paths.add(repoRoot);
    }
    for (const session of yield* providerService.listSessions()) {
      if (
        session.threadId !== thread.id &&
        session.status !== "closed" &&
        session.cwd !== undefined
      )
        paths.add(session.cwd);
    }
    for (const candidate of paths) {
      const otherCwd = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
      if (otherCwd === null) continue;
      const isWithin = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === "" ||
          (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        );
      };
      // Parent and nested owners can both have files inside the restore target.
      if (isWithin(canonicalCwd, otherCwd) || isWithin(otherCwd, canonicalCwd)) return false;
    }
    return true;
  });

  // Claude and git can name one file differently, e.g. /tmp and /private/tmp.
  const canonicalFilePath = (filePath: string) =>
    fileSystem.realPath(path.dirname(filePath)).pipe(
      Effect.map((directory) => path.join(directory, path.basename(filePath))),
      Effect.orElseSucceed(() => filePath),
    );

  // Whether the agent's edit tools wrote outside every repository during these turns.
  // An edit without a recorded path counts, so nothing is skipped on a guess.
  const editedOutsideRoots = Effect.fn("editedOutsideRoots")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnIds: ReadonlyArray<TurnId>;
    readonly roots: ReadonlyArray<string>;
  }) {
    const editedPaths = yield* activityRepository
      .listEditedFilePaths({ threadId: input.threadId, turnIds: input.turnIds })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string | null> => [null]));
    const roots = yield* Effect.forEach(input.roots, (root) =>
      fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    for (const editedPath of editedPaths) {
      if (editedPath === null || !path.isAbsolute(editedPath)) return true;
      const canonical = yield* canonicalFilePath(editedPath);
      const inside = roots.some((root) => {
        const relative = path.relative(root, canonical);
        return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!inside) return true;
    }
    return false;
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restoreFiles = event.payload.restoreFiles !== false;
    const restoreConversation = event.payload.restoreConversation !== false;
    // Agents that checkpoint their own edits (Claude) restore files in place, so a
    // shared checkout needs neither git refs nor an isolated worktree.
    const nativeFileRewindAvailable =
      restoreFiles &&
      providerService.supportsNativeFileRewind !== undefined &&
      providerService.rewindFiles !== undefined
        ? yield* providerService
            .supportsNativeFileRewind(event.payload.threadId)
            .pipe(Effect.orElseSucceed(() => false))
        : false;
    // Same roots checkpoint capture uses, so restore hits every repo that has refs.
    // A conversation-only rewind must not fail because the workspace is gone.
    const checkpointRoots = yield* resolveCheckpointRoots({
      threadId: event.payload.threadId,
      thread,
      projects: yield* resolveThreadProjects(thread.projectId),
    }).pipe(
      Effect.catch((error) =>
        restoreFiles && !nativeFileRewindAvailable
          ? Effect.fail(error)
          : Effect.succeed<ReadonlyArray<string>>([]),
      ),
    );

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    if (restoreConversation) {
      yield* providerService.assertConversationRollbackSupported(event.payload.threadId);
    }

    const targetTurnCount = event.payload.turnCount;
    const checkpointRefAt = (turnCount: number) =>
      turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === turnCount)
            ?.checkpointRef;
    const latestCheckpointRef = thread.checkpoints.find(
      (checkpoint) => checkpoint.checkpointTurnCount === currentTurnCount,
    )?.checkpointRef;
    const allRootsIsolated =
      checkpointRoots.length > 0 &&
      (yield* Effect.forEach(checkpointRoots, (root) =>
        isRestoreWorkspaceIsolated(thread, root),
      )).every(Boolean);
    // A shared checkout restores only the files that changed during the removed
    // turns, so unrelated work and edits made between turns survive.
    const restoreCheckpointChanges = allRootsIsolated
      ? undefined
      : checkpointStore.restoreCheckpointChanges;
    const gitRestoreAvailable =
      checkpointRoots.length > 0 &&
      (allRootsIsolated ||
        (restoreCheckpointChanges !== undefined && latestCheckpointRef !== undefined));
    // Git covers every repository, shell edits included. Claude's own checkpoints
    // only add files its edit tools wrote elsewhere, and reading them can mean
    // starting Claude, so they are skipped when every edit is inside a repository.
    const useNativeFileRewind =
      restoreFiles &&
      nativeFileRewindAvailable &&
      !allRootsIsolated &&
      (!gitRestoreAvailable ||
        (yield* editedOutsideRoots({
          threadId: event.payload.threadId,
          turnIds: thread.checkpoints
            .filter((checkpoint) => checkpoint.checkpointTurnCount > targetTurnCount)
            .map((checkpoint) => checkpoint.turnId),
          roots: checkpointRoots,
        })));
    const restoredFiles = new Set<string>();
    let nativeRestored = false;
    if (useNativeFileRewind && providerService.rewindFiles !== undefined) {
      const rewound = yield* providerService
        .rewindFiles({
          threadId: event.payload.threadId,
          numTurns: currentTurnCount - targetTurnCount,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({ canRewind: false, filesChanged: [], error: error.message }),
          ),
        );
      if (rewound.canRewind) {
        nativeRestored = true;
        for (const file of rewound.filesChanged) restoredFiles.add(yield* canonicalFilePath(file));
      } else if (gitRestoreAvailable) {
        // A turn stopped before the agent saved its checkpoint still has git refs.
        yield* Effect.logInfo("native file rewind unavailable, restoring from git checkpoints", {
          threadId: event.payload.threadId,
          turnCount: targetTurnCount,
          detail: rewound.error,
        });
      } else {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: targetTurnCount,
          detail: rewound.error ?? "Files could not be restored.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
    }

    // Conversation-only rewinds leave files alone but still drop stale refs in every root.
    let restoredRoots = checkpointRoots;
    let failedRoots: ReadonlyArray<string> = [];
    let gitFileCount: number | undefined;
    if (restoreFiles && (gitRestoreAvailable || !nativeRestored)) {
      if (checkpointRoots.length === 0) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: targetTurnCount,
          detail: "Checkpoint workspace is unavailable or is not a git repository.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      if (!gitRestoreAvailable) {
        yield* appendRevertFailureActivity({
          threadId: thread.id,
          turnCount: targetTurnCount,
          detail:
            "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      const targetEndRef = checkpointRefAt(targetTurnCount);
      if (!targetEndRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: targetTurnCount,
          detail: `Checkpoint ref for turn ${targetTurnCount} is unavailable in read model.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      // Files as they were when the next turn's message was sent, when recorded.
      const startRefIn = Effect.fn("startRefIn")(function* (root: string, turnCount: number) {
        const startRef = checkpointStartRefForThreadTurn(event.payload.threadId, turnCount);
        return (yield* checkpointStore.hasCheckpointRef({ cwd: root, checkpointRef: startRef }))
          ? startRef
          : undefined;
      });
      const restoreRoot = Effect.fn("restoreRoot")(function* (root: string) {
        const targetRef =
          targetTurnCount < currentTurnCount
            ? ((yield* startRefIn(root, targetTurnCount + 1)) ?? targetEndRef)
            : targetEndRef;
        if (restoreCheckpointChanges !== undefined && latestCheckpointRef !== undefined) {
          const changedWithin = yield* Effect.forEach(
            thread.checkpoints.filter(
              (checkpoint) => checkpoint.checkpointTurnCount > targetTurnCount,
            ),
            (checkpoint) =>
              Effect.gen(function* () {
                const previousEndRef = checkpointRefAt(checkpoint.checkpointTurnCount - 1);
                return {
                  fromCheckpointRef:
                    (yield* startRefIn(root, checkpoint.checkpointTurnCount)) ??
                    previousEndRef ??
                    targetRef,
                  toCheckpointRef: checkpoint.checkpointRef,
                };
              }),
          );
          const paths = yield* restoreCheckpointChanges({
            cwd: root,
            checkpointRef: targetRef,
            latestCheckpointRef,
            changedWithin,
            fallbackToHead: targetTurnCount === 0,
          });
          for (const file of paths ?? []) {
            restoredFiles.add(yield* canonicalFilePath(path.join(root, file)));
          }
          return { restored: paths !== null, files: paths?.length };
        }
        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd: root,
          checkpointRef: targetRef,
          fallbackToHead: targetTurnCount === 0,
        });
        return { restored, files: undefined };
      });
      const restoreResults = yield* Effect.forEach(
        checkpointRoots,
        (root) =>
          restoreRoot(root).pipe(
            Effect.map(({ restored, files }) => ({ root, restored, files })),
            Effect.catch((error) =>
              Effect.logWarning("checkpoint restore failed for root", {
                threadId: event.payload.threadId,
                turnCount: targetTurnCount,
                root,
                detail: error.message,
              }).pipe(Effect.as({ root, restored: false, files: 0 })),
            ),
          ),
        { concurrency: 4 },
      );
      restoredRoots = restoreResults.filter((entry) => entry.restored).map((e) => e.root);
      failedRoots = restoreResults.filter((entry) => !entry.restored).map((e) => e.root);
      if (restoreCheckpointChanges !== undefined) {
        gitFileCount = restoreResults.reduce((total, entry) => total + (entry.files ?? 0), 0);
      }

      if (restoredRoots.length === 0 && !nativeRestored) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: targetTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${targetTurnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
    }
    if (restoreFiles) {
      // Refresh the workspace entry index so the @-mention file picker
      // reflects the reverted filesystem state for each reverted root.
      yield* Effect.forEach(checkpointRoots, (root) => refreshWorkspaceEntries(root), {
        discard: true,
      });
    }
    const restoredFileCount =
      gitFileCount === undefined && !nativeRestored ? undefined : restoredFiles.size;

    // Restoring code only keeps every turn, its checkpoint refs included.
    if (!restoreConversation) {
      yield* appendFilesRestoredActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail:
          restoredFileCount === undefined
            ? `Restored files in ${restoredRoots.length} ${restoredRoots.length === 1 ? "repository" : "repositories"}.`
            : restoredFileCount === 0
              ? "No file changes to restore."
              : `Restored ${restoredFileCount} ${restoredFileCount === 1 ? "file" : "files"}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: event.payload.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(
          checkpoint.checkpointRef,
          checkpointStartRefForThreadTurn(event.payload.threadId, checkpoint.checkpointTurnCount),
        );
      }
    }

    if (staleCheckpointRefs.length > 0) {
      yield* Effect.forEach(
        restoredRoots,
        (root) =>
          checkpointStore
            .deleteCheckpointRefs({ cwd: root, checkpointRefs: staleCheckpointRefs })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to delete stale checkpoint refs for root", {
                  threadId: event.payload.threadId,
                  root,
                  detail: error.message,
                }),
              ),
            ),
        { discard: true },
      );
    }

    // Some roots reverted and others failed: surface the partial failure but
    // still complete the revert for the roots that succeeded.
    if (failedRoots.length > 0) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Reverted ${restoredRoots.length} of ${checkpointRoots.length} repositories; failed: ${failedRoots.join(", ")}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const isNewTurn = turnId !== null && !sameId(startedTurns.get(event.threadId), turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event, isNewTurn);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn(thread.projectId);
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("checkpoint reactor failed to process input", {
            source: input.source,
            eventType: input.event.type,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(
      Effect.andThen(statusRefreshWorker.drain),
      Effect.andThen(entryRefreshWorker.drain),
    ),
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProjectionThreadActivityRepositoryLive),
);
