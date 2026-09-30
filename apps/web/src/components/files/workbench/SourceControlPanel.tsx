import type { EnvironmentId, ScmChange, ScmStatusResult } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  GitBranchIcon,
  MinusIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { workspaceIde } from "~/state/workspaceIde";

import {
  SCM_STATUS_CLASS,
  SCM_STATUS_LETTER,
  SCM_STATUS_TITLE,
  scmChangeCount,
  splitChangePath,
} from "./scmPresentation";
import type { ScmRepoState, ScmStatuses } from "./useScmStatuses";
import { commandFailureMessage, confirmAction, reportCommandResult } from "./workbenchCommands";

export type ScmCompare = "working-tree" | "staged";

export interface ScmChangeTarget {
  /** The repository's top-level folder; `path` is relative to it. */
  readonly repoRoot: string;
  readonly path: string;
  readonly compare: ScmCompare;
}

type ChangeGroup = "merge" | "staged" | "changes";

interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly scm: ScmStatuses;
  /** Display name per repo root; shown as sections when there are several. */
  readonly repoLabels: ReadonlyMap<string, string>;
  /** The diff open in the editor, highlighted in its list. */
  readonly activeChange: ScmChangeTarget | null;
  readonly onOpenChange: (target: ScmChangeTarget) => void;
  readonly onOpenFile: (repoRoot: string, path: string) => void;
}

/** Commit messages survive switching panels, as VS Code's input box does. */
const draftMessages = new Map<string, string>();

function IconAction(props: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-micro"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onPress();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function SourceControlPanel(props: SourceControlPanelProps) {
  const multiRepo = props.scm.repos.length > 1;
  const pending = props.scm.repos.some((repo) => repo.isPending);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-source-control-panel>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-3 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9"
        data-surface-subheader
      >
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          Source Control
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Refresh"
                onClick={() => props.scm.refresh()}
              />
            }
          >
            <RefreshIcon refreshing={pending} />
          </TooltipTrigger>
          <TooltipPopup>Refresh</TooltipPopup>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {props.scm.repos.map((repo) => (
          <RepositorySection
            key={repo.root}
            {...props}
            repo={repo}
            label={props.repoLabels.get(repo.root) ?? repo.root}
            showHeader={multiRepo}
          />
        ))}
      </div>
    </div>
  );
}

function RepositorySection(
  props: SourceControlPanelProps & {
    readonly repo: ScmRepoState;
    readonly label: string;
    readonly showHeader: boolean;
  },
) {
  const { environmentId, repo } = props;
  const status = repo.status;
  const repoRoot = status?.repoRoot ?? repo.root;
  const [collapsed, setCollapsed] = useState(false);
  const [message, setMessage] = useState(() => draftMessages.get(repo.root) ?? "");
  const [committing, setCommitting] = useState(false);
  const stage = useAtomCommand(workspaceIde.stage, { reportFailure: false });
  const unstage = useAtomCommand(workspaceIde.unstage, { reportFailure: false });
  const discard = useAtomCommand(workspaceIde.discard, { reportFailure: false });
  const deleteEntries = useAtomCommand(workspaceIde.deleteEntries, { reportFailure: false });
  const commit = useAtomCommand(workspaceIde.commit, { reportFailure: false });

  const updateMessage = (next: string) => {
    setMessage(next);
    if (next) draftMessages.set(repo.root, next);
    else draftMessages.delete(repo.root);
  };

  const afterCommand = () => props.scm.refresh(repo.root);

  const runPaths = async (
    command: typeof stage,
    paths: readonly string[],
    failureTitle: string,
  ) => {
    if (paths.length === 0) return;
    const result = await command({
      environmentId,
      input: { cwd: repoRoot, paths: [...new Set(paths)] },
    });
    reportCommandResult(result, failureTitle);
    afterCommand();
  };

  const stageChanges = (changes: readonly ScmChange[]) =>
    runPaths(
      stage,
      changes.map((change) => change.path),
      "Couldn't stage changes",
    );
  // A staged rename lives at two paths; unstaging must name both.
  const unstageChanges = (changes: readonly ScmChange[]) =>
    runPaths(
      unstage,
      changes.flatMap((change) =>
        change.originalPath ? [change.path, change.originalPath] : [change.path],
      ),
      "Couldn't unstage changes",
    );

  /** Discards edits to tracked files and moves new files to the Trash, after asking. */
  const discardChanges = async (changes: readonly ScmChange[]) => {
    if (changes.length === 0) return;
    const untracked = changes.filter((change) => change.status === "untracked");
    const tracked = changes.filter((change) => change.status !== "untracked");
    const only = changes.length === 1 ? splitChangePath(changes[0]!.path).name : null;
    const question =
      only !== null
        ? untracked.length === 1
          ? `Are you sure you want to delete '${only}'?\nIt's a new file, so it will be moved to the Trash.`
          : `Are you sure you want to discard changes in '${only}'?\nThis can't be undone.`
        : `Are you sure you want to discard all changes in ${changes.length} files?\nEdits to tracked files can't be undone; new files are moved to the Trash.`;
    if (!(await confirmAction(question))) return;
    if (tracked.length > 0) {
      await runPaths(
        discard,
        tracked.map((change) => change.path),
        "Couldn't discard changes",
      );
    }
    if (untracked.length > 0) {
      const result = await deleteEntries({
        environmentId,
        input: {
          cwd: repoRoot,
          relativePaths: untracked.map((change) => change.path),
          permanently: false,
        },
      });
      reportCommandResult(result, "Couldn't delete new files");
      afterCommand();
    }
  };

  const runCommit = async (options: { readonly amend?: boolean } = {}) => {
    if (!status || committing) return;
    const text = message.trim();
    if (!text) {
      toastManager.add({ type: "info", title: "Type a commit message first" });
      return;
    }
    let stageAll = false;
    if (status.staged.length === 0 && !options.amend) {
      if (status.changes.length === 0) {
        toastManager.add({ type: "info", title: "There are no changes to commit" });
        return;
      }
      stageAll = await confirmAction(
        "There are no staged changes to commit. Would you like to stage all your changes and commit them directly?",
        "default",
      );
      if (!stageAll) return;
    }
    setCommitting(true);
    const result = await commit({
      environmentId,
      input: {
        cwd: repoRoot,
        message: text,
        ...(options.amend ? { amend: true } : {}),
        ...(stageAll ? { stageAll: true } : {}),
      },
    });
    setCommitting(false);
    afterCommand();
    if (result._tag === "Success") {
      updateMessage("");
      toastManager.add({
        type: "success",
        title: `Committed ${result.value.sha.slice(0, 7)}`,
        description: result.value.subject,
      });
      return;
    }
    const failure = commandFailureMessage(result);
    if (failure) toastManager.add({ type: "error", title: "Commit failed", description: failure });
  };

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void runCommit();
    }
  };

  const branch = status?.branch ?? (status?.hasCommits ? "detached HEAD" : null);
  const changeCount = scmChangeCount(status);

  return (
    <section className="border-b border-border/40 last:border-b-0" data-scm-repo={repo.root}>
      {props.showHeader ? (
        <button
          type="button"
          className="flex h-7 w-full items-center gap-1 px-1.5 text-left text-xs font-medium hover:bg-accent/60"
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{props.label}</span>
          {branch ? <BranchBadge status={status} branch={branch} /> : null}
          {changeCount > 0 ? (
            <span className="ml-auto rounded-full bg-muted px-1.5 text-3xs text-muted-foreground tabular-nums">
              {changeCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {collapsed ? null : !status ? (
        repo.error ? (
          <p className="px-3 py-2 text-xs text-destructive">{repo.error}</p>
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">Reading git status…</p>
        )
      ) : !status.isRepo ? (
        <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          This folder isn't a git repository.
        </p>
      ) : (
        <div className="pb-1">
          {!props.showHeader && branch ? (
            <div className="flex items-center gap-1 px-3 pt-2 text-xs text-muted-foreground">
              <BranchBadge status={status} branch={branch} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5 px-3 pt-2 pb-1">
            <Textarea
              size="sm"
              value={message}
              placeholder={`Message (⌘Enter to commit${status.branch ? ` on "${status.branch}"` : ""})`}
              aria-label="Commit message"
              onChange={(event) => updateMessage(event.target.value)}
              onKeyDown={onMessageKeyDown}
            />
            <Group aria-label="Commit" className="w-full">
              <Button
                type="button"
                size="compact"
                className="min-w-0 flex-1"
                disabled={committing}
                onClick={() => void runCommit()}
              >
                <CheckIcon />
                {committing ? "Committing…" : "Commit"}
              </Button>
              <GroupSeparator />
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="compact"
                      aria-label="More commit actions"
                      disabled={committing}
                    />
                  }
                >
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => void runCommit()}>Commit</MenuItem>
                  <MenuItem
                    disabled={!status.hasCommits}
                    onClick={() => void runCommit({ amend: true })}
                  >
                    Commit (Amend)
                  </MenuItem>
                  <MenuItem
                    disabled={status.changes.length === 0}
                    onClick={() => void stageChanges(status.changes)}
                  >
                    Stage All Changes
                  </MenuItem>
                  <MenuItem
                    disabled={status.staged.length === 0}
                    onClick={() => void unstageChanges(status.staged)}
                  >
                    Unstage All Changes
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </Group>
          </div>
          {status.merge.length > 0 ? (
            <ChangeList
              {...props}
              title="Merge Changes"
              group="merge"
              repoRoot={repoRoot}
              changes={status.merge}
              onStage={stageChanges}
            />
          ) : null}
          {status.staged.length > 0 ? (
            <ChangeList
              {...props}
              title="Staged Changes"
              group="staged"
              repoRoot={repoRoot}
              changes={status.staged}
              onUnstage={unstageChanges}
            />
          ) : null}
          <ChangeList
            {...props}
            title="Changes"
            group="changes"
            repoRoot={repoRoot}
            changes={status.changes}
            onStage={stageChanges}
            onDiscard={discardChanges}
          />
          {status.truncated ? (
            <p className="px-3 py-1 text-2xs text-muted-foreground">
              Too many changes to list them all.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function BranchBadge(props: { status: ScmStatusResult | null; branch: string }) {
  const { status } = props;
  return (
    <span className="flex min-w-0 items-center gap-1 text-2xs font-normal text-muted-foreground">
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="truncate">{props.branch}</span>
      {status && status.upstream && (status.ahead > 0 || status.behind > 0) ? (
        <span
          className="flex shrink-0 items-center gap-0.5 tabular-nums"
          aria-label={`${status.behind} behind, ${status.ahead} ahead of ${status.upstream}`}
        >
          {status.behind > 0 ? (
            <>
              {status.behind}
              <ArrowDownIcon className="size-3" />
            </>
          ) : null}
          {status.ahead > 0 ? (
            <>
              {status.ahead}
              <ArrowUpIcon className="size-3" />
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** VS Code's buttons for a group header, or for one row when `changes` is that row. */
function ChangeActions(props: {
  readonly changes: readonly ScmChange[];
  readonly all: boolean;
  readonly onStage?: ((changes: readonly ScmChange[]) => Promise<void>) | undefined;
  readonly onUnstage?: ((changes: readonly ScmChange[]) => Promise<void>) | undefined;
  readonly onDiscard?: ((changes: readonly ScmChange[]) => Promise<void>) | undefined;
}) {
  const { changes, all, onStage, onUnstage, onDiscard } = props;
  if (changes.length === 0) return null;
  return (
    <>
      {onDiscard ? (
        <IconAction
          label={all ? "Discard All Changes" : "Discard Changes"}
          onPress={() => void onDiscard(changes)}
        >
          <Undo2Icon />
        </IconAction>
      ) : null}
      {onStage ? (
        <IconAction
          label={all ? "Stage All Changes" : "Stage Changes"}
          onPress={() => void onStage(changes)}
        >
          <PlusIcon />
        </IconAction>
      ) : null}
      {onUnstage ? (
        <IconAction
          label={all ? "Unstage All Changes" : "Unstage Changes"}
          onPress={() => void onUnstage(changes)}
        >
          <MinusIcon />
        </IconAction>
      ) : null}
    </>
  );
}

function ChangeList(
  props: SourceControlPanelProps & {
    readonly title: string;
    readonly group: ChangeGroup;
    readonly repoRoot: string;
    readonly changes: readonly ScmChange[];
    readonly onStage?: (changes: readonly ScmChange[]) => Promise<void>;
    readonly onUnstage?: (changes: readonly ScmChange[]) => Promise<void>;
    readonly onDiscard?: (changes: readonly ScmChange[]) => Promise<void>;
  },
) {
  const [collapsed, setCollapsed] = useState(false);
  const { resolvedTheme } = useTheme();
  const compare: ScmCompare = props.group === "staged" ? "staged" : "working-tree";
  const handlers = {
    onStage: props.onStage,
    onUnstage: props.onUnstage,
    onDiscard: props.onDiscard,
  };
  return (
    <div role="group" aria-label={props.title} data-scm-group={props.group}>
      <div
        className="group/header flex h-6 cursor-pointer items-center gap-1 pr-2 pl-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase select-none hover:bg-accent/50"
        onClick={() => setCollapsed((current) => !current)}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{props.title}</span>
        <span className="hidden items-center gap-0.5 group-hover/header:flex">
          <ChangeActions changes={props.changes} all {...handlers} />
        </span>
        <span className="rounded-full bg-muted px-1.5 text-3xs font-normal tabular-nums">
          {props.changes.length}
        </span>
      </div>
      {collapsed
        ? null
        : props.changes.map((change) => {
            const { name, directory } = splitChangePath(change.path);
            const active =
              props.activeChange?.repoRoot === props.repoRoot &&
              props.activeChange.path === change.path &&
              props.activeChange.compare === compare;
            const open = () =>
              props.onOpenChange({ repoRoot: props.repoRoot, path: change.path, compare });
            return (
              <div
                key={`${change.path}\0${change.originalPath ?? ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${change.path}, ${SCM_STATUS_TITLE[change.status]}`}
                data-scm-change={change.path}
                className={cn(
                  "group/row flex h-[22px] cursor-pointer items-center gap-1.5 pr-2 pl-5 text-xs outline-none hover:bg-accent/50 focus-visible:bg-accent/70",
                  active && "bg-accent",
                )}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open();
                  }
                }}
              >
                <PierreEntryIcon
                  pathValue={change.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3.5 shrink-0"
                />
                <span
                  className={cn(
                    "shrink truncate",
                    change.status === "deleted" && "line-through opacity-80",
                    SCM_STATUS_CLASS[change.status],
                  )}
                >
                  {name}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                  {change.originalPath ? `${change.originalPath} → ` : ""}
                  {directory}
                </span>
                <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
                  {change.status === "deleted" ? null : (
                    <IconAction
                      label="Open File"
                      onPress={() => props.onOpenFile(props.repoRoot, change.path)}
                    >
                      <FileIcon />
                    </IconAction>
                  )}
                  <ChangeActions changes={[change]} all={false} {...handlers} />
                </span>
                <span
                  className={cn(
                    "w-3 shrink-0 text-center text-2xs font-medium",
                    SCM_STATUS_CLASS[change.status],
                  )}
                >
                  {SCM_STATUS_LETTER[change.status]}
                </span>
              </div>
            );
          })}
    </div>
  );
}
