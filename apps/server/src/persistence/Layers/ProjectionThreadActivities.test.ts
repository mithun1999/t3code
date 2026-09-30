import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({
        threadId,
        taskId: "task-1",
      });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );

  it.effect("lists the files edited during the given turns", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-edited-files");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'edit-write', ${threadId}, 'turn-1', 'tool', 'tool.completed', 'File change',
            '{"itemType":"file_change","data":{"input":{"file_path":"/repo/a.ts"}}}', 1,
            '2026-03-01T00:00:00.000Z'
          ),
          (
            'edit-notebook', ${threadId}, 'turn-2', 'tool', 'tool.completed', 'File change',
            '{"itemType":"file_change","data":{"input":{"notebook_path":"/repo/b.ipynb"}}}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'edit-unknown', ${threadId}, 'turn-2', 'tool', 'tool.completed', 'File change',
            '{"itemType":"file_change","data":{"input":{}}}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'command', ${threadId}, 'turn-2', 'tool', 'tool.completed', 'Command run',
            '{"itemType":"command_execution","data":{"input":{"file_path":"/ignored"}}}', 4,
            '2026-03-01T00:00:03.000Z'
          ),
          (
            'not-json', ${threadId}, 'turn-2', 'tool', 'tool.completed', 'large tool output',
            'not-json', 5, '2026-03-01T00:00:04.000Z'
          ),
          (
            'other-turn', ${threadId}, 'turn-3', 'tool', 'tool.completed', 'File change',
            '{"itemType":"file_change","data":{"input":{"file_path":"/repo/c.ts"}}}', 6,
            '2026-03-01T00:00:05.000Z'
          )
      `;

      const paths = yield* repository.listEditedFilePaths({
        threadId,
        turnIds: [TurnId.make("turn-1"), TurnId.make("turn-2")],
      });
      assert.deepEqual([...paths].toSorted(), ["/repo/a.ts", "/repo/b.ipynb", null].toSorted());
      assert.deepEqual(yield* repository.listEditedFilePaths({ threadId, turnIds: [] }), []);
    }),
  );
});
