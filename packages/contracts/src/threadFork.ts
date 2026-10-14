import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/** Copy a thread's conversation into a new thread that continues on its own. */
export const ThreadForkInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  threadId: ThreadId,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
