import { FilesIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { WorkbenchSideBarView } from "~/workbenchView";

export type { WorkbenchSideBarView } from "~/workbenchView";

export const SIDE_BAR_MIN_WIDTH = 180;
export const SIDE_BAR_DEFAULT_WIDTH = 240;

function ActivityBarButton(props: {
  label: string;
  tooltip?: string;
  hint?: string | undefined;
  active: boolean;
  onPress: () => void;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.active}
            className={cn(
              "relative flex size-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
              props.active &&
                "text-foreground before:absolute before:inset-y-1.5 before:right-0 before:w-0.5 before:rounded-full before:bg-primary",
            )}
            onClick={props.onPress}
          />
        }
      >
        {props.children}
        {props.badge ? (
          <span className="absolute right-1 bottom-1 min-w-3.5 rounded-full bg-primary px-1 text-center text-4xs leading-3.5 font-semibold text-primary-foreground tabular-nums">
            {props.badge > 99 ? "99+" : props.badge}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="left">
        <div>{props.tooltip ?? props.label}</div>
        {props.hint ? <div className="text-muted-foreground">{props.hint}</div> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/** VS Code's activity bar: picks the side bar view; the active one toggles it. */
export function WorkbenchActivityBar(props: {
  view: WorkbenchSideBarView;
  sideBarVisible: boolean;
  changeCount: number;
  shortcutLabels?: {
    readonly explorer: string | null;
    readonly search: string | null;
    readonly scm: string | null;
    readonly toggle: string | null;
  };
  onSelect: (view: WorkbenchSideBarView) => void;
}) {
  const withKey = (label: string, key: string | null | undefined) =>
    key ? `${label} (${key})` : label;
  const toggleHint = props.shortcutLabels?.toggle;
  return (
    <nav
      aria-label="Views"
      className="flex w-9 shrink-0 flex-col items-center border-l border-border/60 bg-background py-0.5"
      data-workbench-activity-bar
    >
      <ActivityBarButton
        label="Explorer"
        tooltip={withKey("Explorer", props.shortcutLabels?.explorer)}
        hint={toggleHint ? `${toggleHint} hides or shows the side bar` : undefined}
        active={props.sideBarVisible && props.view === "explorer"}
        onPress={() => props.onSelect("explorer")}
      >
        <FilesIcon className="size-4.5" />
      </ActivityBarButton>
      <ActivityBarButton
        label="Search"
        tooltip={withKey("Search", props.shortcutLabels?.search)}
        hint={toggleHint ? `${toggleHint} hides or shows the side bar` : undefined}
        active={props.sideBarVisible && props.view === "search"}
        onPress={() => props.onSelect("search")}
      >
        <SearchIcon className="size-4.5" />
      </ActivityBarButton>
      <ActivityBarButton
        label="Source Control"
        tooltip={withKey("Source Control", props.shortcutLabels?.scm)}
        hint={toggleHint ? `${toggleHint} hides or shows the side bar` : undefined}
        active={props.sideBarVisible && props.view === "scm"}
        onPress={() => props.onSelect("scm")}
        badge={props.changeCount}
      >
        <GitBranchIcon className="size-4.5" />
      </ActivityBarButton>
    </nav>
  );
}

/** Drag handle on the side bar's inner (left) edge. */
export function SideBarResizeHandle(props: { width: number; onResize: (width: number) => void }) {
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const sideBar = handle.parentElement;
    const container = sideBar?.parentElement;
    if (!sideBar || !container) return;
    const startX = event.clientX;
    const startWidth = sideBar.getBoundingClientRect().width;
    const maxWidth = container.getBoundingClientRect().width * 0.4;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      // The side bar is on the right: dragging left widens it.
      const next = Math.round(startWidth - (moveEvent.clientX - startX));
      props.onResize(Math.max(SIDE_BAR_MIN_WIDTH, Math.min(maxWidth, next)));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side bar"
      aria-valuenow={props.width}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-100"
      onPointerDown={startResize}
      onDoubleClick={() => props.onResize(SIDE_BAR_DEFAULT_WIDTH)}
    />
  );
}
