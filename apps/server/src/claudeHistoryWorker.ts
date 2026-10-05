import { forkSession, getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
);

// Claude names a fork "<title> (fork)", so each rewind would add another
// suffix and Claude would announce the rename. A rewind continues the same
// conversation, so the fork keeps the conversation's title.
export async function forkClaudeSessionKeepingTitle(
  sessionId: string,
  options: { readonly dir?: string; readonly upToMessageId?: string },
): Promise<{ sessionId: string }> {
  const info = await getSessionInfo(sessionId, options.dir ? { dir: options.dir } : {}).catch(
    () => undefined,
  );
  const title = (info?.customTitle ?? info?.summary)?.replace(/(?: \(fork\))+$/, "").trim();
  return forkSession(sessionId, { ...options, ...(title ? { title } : {}) });
}

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkClaudeSessionKeepingTitle(sessionId, options)
        : (() => {
            throw new Error("Unknown Claude history operation.");
          })();
  process.stdout.write(JSON.stringify(result));
}
