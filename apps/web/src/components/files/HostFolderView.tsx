import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useMemo } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Spinner } from "~/components/ui/spinner";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

function withTrailingSeparator(path: string): string {
  return /[\\/]$/.test(path) ? path : `${path}/`;
}

function parentFolder(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index <= 0
    ? trimmed.startsWith("/") && trimmed.length > 1
      ? "/"
      : null
    : trimmed.slice(0, index);
}

/**
 * A folder outside the workspace, such as a cache folder an agent mentions:
 * its contents, read-only. Files open as read-only previews and folders open
 * in place, so the tab browses like a file manager.
 */
export function HostFolderView(props: {
  readonly environmentId: EnvironmentId;
  readonly folderPath: string;
  readonly theme: "light" | "dark";
  readonly onOpenEntry: (absolutePath: string) => void;
}) {
  const listing = useEnvironmentQuery(
    filesystemEnvironment.browse({
      environmentId: props.environmentId,
      input: { partialPath: withTrailingSeparator(props.folderPath), includeFiles: true },
    }),
  );
  const parent = useMemo(() => parentFolder(props.folderPath), [props.folderPath]);
  const entries = listing.data?.entries ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-host-folder={props.folderPath}>
      <p className="shrink-0 border-b border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
        This folder is outside the workspace. Its files open read-only.
      </p>
      <div
        role="list"
        aria-label={`Contents of ${props.folderPath}`}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {parent ? (
          <button
            type="button"
            className="flex h-[22px] w-full items-center gap-1.5 px-3 text-left text-xs text-muted-foreground hover:bg-accent/50"
            onClick={() => props.onOpenEntry(parent)}
          >
            <ArrowUpIcon className="size-3.5 shrink-0" />
            ..
          </button>
        ) : null}
        {listing.isPending && entries.length === 0 ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : listing.error ? (
          <p className="px-3 py-2 text-xs text-destructive">{listing.error}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</p>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.fullPath}
              type="button"
              role="listitem"
              data-host-entry={entry.fullPath}
              className="flex h-[22px] w-full items-center gap-1.5 px-3 text-left text-xs hover:bg-accent/50"
              onClick={() => props.onOpenEntry(entry.fullPath)}
            >
              <PierreEntryIcon
                pathValue={entry.fullPath}
                kind={entry.kind === "directory" ? "directory" : "file"}
                theme={props.theme}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
