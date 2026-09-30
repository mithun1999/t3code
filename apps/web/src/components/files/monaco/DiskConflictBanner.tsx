import { TriangleAlertIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/** VS Code's "the file on disk is newer" choice, for edits that can't be merged. */
export function DiskConflictBanner(props: {
  readonly onKeepMine: () => void;
  readonly onUseDisk: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-xs text-warning-foreground"
      data-disk-conflict
    >
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        This file changed on disk where you have unsaved edits. Saving is paused until you choose.
      </span>
      <Button type="button" size="xs" variant="outline" onClick={props.onUseDisk}>
        Use the version on disk
      </Button>
      <Button type="button" size="xs" variant="warning-outline" onClick={props.onKeepMine}>
        Keep mine
      </Button>
    </div>
  );
}
