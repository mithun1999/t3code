import { FilesIcon, GitBranchIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export type WorkbenchSideBarView = "explorer" | "scm";

export const SIDE_BAR_MIN_WIDTH = 180;
export const SIDE_BAR_DEFAULT_WIDTH = 300;

function ActivityBarButton(props: {
  label: string;
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
                "text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
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
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** VS Code's activity bar: picks the side bar view; the active one toggles it. */
export function WorkbenchActivityBar(props: {
  view: WorkbenchSideBarView;
  sideBarVisible: boolean;
  changeCount: number;
  onSelect: (view: WorkbenchSideBarView) => void;
}) {
  return (
    <nav
      aria-label="Views"
      className="flex w-9 shrink-0 flex-col items-center border-r border-border/60 bg-background py-0.5"
      data-workbench-activity-bar
    >
      <ActivityBarButton
        label="Explorer"
        active={props.sideBarVisible && props.view === "explorer"}
        onPress={() => props.onSelect("explorer")}
      >
        <FilesIcon className="size-4.5" />
      </ActivityBarButton>
      <ActivityBarButton
        label="Source Control"
        active={props.sideBarVisible && props.view === "scm"}
        onPress={() => props.onSelect("scm")}
        badge={props.changeCount}
      >
        <GitBranchIcon className="size-4.5" />
      </ActivityBarButton>
    </nav>
  );
}

/** Drag handle on the side bar's edge. */
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
      const next = Math.round(startWidth + moveEvent.clientX - startX);
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
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-100"
      onPointerDown={startResize}
      onDoubleClick={() => props.onResize(SIDE_BAR_DEFAULT_WIDTH)}
    />
  );
}
