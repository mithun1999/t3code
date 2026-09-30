import type * as Monaco from "monaco-editor/editor/editor.api.js";
import type { EnvironmentId, ScmChange, ThreadId } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Columns2Icon,
  FileIcon,
  FoldVerticalIcon,
  MinusIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Spinner } from "~/components/ui/spinner";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import type { FileSurfaceCompare } from "~/rightPanelStore";
import { workspaceIde } from "~/state/workspaceIde";

import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceAction } from "../fileSurfaceChrome";
import { MonacoDiffEditor } from "../monaco/MonacoDiffEditor";
import { useProjectFileQuery } from "../projectFilesQueryState";
import { SCM_STATUS_CLASS, SCM_STATUS_LETTER, splitChangePath } from "./scmPresentation";
import type { ScmCompare } from "./SourceControlPanel";
import type { ScmStatuses } from "./useScmStatuses";
import { changeTouchesFile, useWorkspaceChanges } from "./useWorkspaceChanges";
import { confirmAction, reportCommandResult } from "./workbenchCommands";

const SIDE_BY_SIDE_STORAGE_KEY = "t3code.scmDiffSideBySide";
const COLLAPSE_UNCHANGED_STORAGE_KEY = "t3code.scmDiffCollapseUnchanged";

interface ScmDiffViewProps {
  readonly environmentId: EnvironmentId;
  /** Repository root the path is relative to. */
  readonly repoRoot: string;
  readonly path: string;
  /** Unstaged or staged changes, or what a turn of `threadId` changed. */
  readonly compare: FileSurfaceCompare;
  readonly threadId: ThreadId;
  readonly scm: ScmStatuses;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
  /** Root as the file surface knows it, for pending-save state. */
  readonly surfaceRoot?: string | undefined;
  readonly onPendingChange: (relativePath: string, pending: boolean, root?: string) => void;
  readonly onOpenFile: (repoRoot: string, path: string) => void;
}

function findChange(
  scm: ScmStatuses,
  repoRoot: string,
  path: string,
  compare: ScmCompare,
): ScmChange | null {
  for (const repo of scm.repos) {
    const status = repo.status;
    if (!status || (status.repoRoot ?? repo.root) !== repoRoot) continue;
    const list = compare === "staged" ? status.staged : [...status.changes, ...status.merge];
    return list.find((change) => change.path === path) ?? null;
  }
  return null;
}

/** The turn a "turn:<n>" comparison is about, or null for git changes. */
function turnCountOf(compare: FileSurfaceCompare): number | null {
  return compare.startsWith("turn:") ? Number(compare.slice("turn:".length)) : null;
}

/**
 * A changed file as VS Code's source control shows it: the index (or HEAD for
 * staged changes) on the left, the working tree (or index) on the right. A
 * turn's changes compare the file as the turn found it with how it left it.
 */
export function ScmDiffView(props: ScmDiffViewProps) {
  const { environmentId, repoRoot, path, compare, threadId } = props;
  const turnCount = turnCountOf(compare);
  const scmCompare: ScmCompare | null = turnCount === null ? (compare as ScmCompare) : null;
  const change = scmCompare ? findChange(props.scm, repoRoot, path, scmCompare) : null;
  const originalPath = compare === "staged" ? (change?.originalPath ?? path) : path;
  const turnInput = (revision: "turn-before" | "turn-after") => ({
    cwd: repoRoot,
    relativePath: path,
    revision,
    threadId,
    turnCount: turnCount ?? 0,
  });
  const original = useEnvironmentQuery(
    workspaceIde.scmReadFile({
      environmentId,
      input:
        turnCount !== null
          ? turnInput("turn-before")
          : {
              cwd: repoRoot,
              relativePath: originalPath,
              revision: compare === "staged" ? "HEAD" : "index",
            },
    }),
  );
  // The right side read from git: the index for staged changes, or the turn's end.
  const stagedModified = useEnvironmentQuery(
    compare === "staged"
      ? workspaceIde.scmReadFile({
          environmentId,
          input: { cwd: repoRoot, relativePath: path, revision: "index" },
        })
      : turnCount !== null
        ? workspaceIde.scmReadFile({ environmentId, input: turnInput("turn-after") })
        : null,
  );
  const deletedOnDisk = compare === "working-tree" && change?.status === "deleted";
  const workingFile = useProjectFileQuery(
    environmentId,
    repoRoot,
    path,
    compare === "working-tree" && !deletedOnDisk,
  );
  const [sideBySide, setSideBySide] = useLocalStorage(
    SIDE_BY_SIDE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [collapseUnchanged, setCollapseUnchanged] = useLocalStorage(
    COLLAPSE_UNCHANGED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const stage = useAtomCommand(workspaceIde.stage, { reportFailure: false });
  const unstage = useAtomCommand(workspaceIde.unstage, { reportFailure: false });
  const discard = useAtomCommand(workspaceIde.discard, { reportFailure: false });

  // Staging or committing moves the index and HEAD; an agent moves the file.
  // A turn's checkpoints never change.
  useWorkspaceChanges(environmentId, turnCount === null ? [repoRoot] : [], (_root, event) => {
    if (event.gitChanged || event.overflow) {
      original.refresh();
      stagedModified.refresh();
    }
    if (compare === "working-tree" && changeTouchesFile(event, path)) workingFile.refresh();
  });

  const originalContents = original.data?.exists ? original.data.contents : "";
  const modifiedContents =
    compare !== "working-tree"
      ? stagedModified.data?.exists
        ? stagedModified.data.contents
        : ""
      : deletedOnDisk
        ? ""
        : (workingFile.data?.contents ?? null);
  const binary =
    original.data?.binary === true ||
    stagedModified.data?.binary === true ||
    (workingFile.error !== null && workingFile.data === null && !deletedOnDisk);
  const tooLarge =
    original.data?.truncated === true ||
    stagedModified.data?.truncated === true ||
    workingFile.data?.truncated === true;
  const loading =
    original.data === null ||
    (compare !== "working-tree" ? stagedModified.data === null : modifiedContents === null);
  const editable = compare === "working-tree" && !deletedOnDisk && !tooLarge;
  const { name, directory } = splitChangePath(path);

  const runPaths = async (command: typeof stage, paths: readonly string[], title: string) => {
    const result = await command({ environmentId, input: { cwd: repoRoot, paths: [...paths] } });
    reportCommandResult(result, title);
    props.scm.refresh();
  };
  const discardFile = async () => {
    if (
      !(await confirmAction(
        `Are you sure you want to discard changes in '${name}'?\nThis can't be undone.`,
      ))
    )
      return;
    await runPaths(discard, [path], "Couldn't discard changes");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-scm-diff-view={`${compare}:${path}`}>
      <div
        className={cn(FILE_SURFACE_SUBHEADER_CLASS, "@container/diff-header")}
        data-surface-subheader
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs">
          <PierreEntryIcon
            pathValue={path}
            kind="file"
            theme={props.resolvedTheme}
            className="size-3.5 shrink-0"
          />
          <span className="min-w-0 truncate font-medium">{name}</span>
          <span className="hidden shrink-0 text-muted-foreground @md/diff-header:inline">
            (
            {turnCount !== null
              ? `Turn ${turnCount}`
              : compare === "staged"
                ? "Index"
                : "Working Tree"}
            )
          </span>
          {change ? (
            <span className={`shrink-0 text-2xs font-medium ${SCM_STATUS_CLASS[change.status]}`}>
              {SCM_STATUS_LETTER[change.status]}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-2xs text-muted-foreground">{directory}</span>
        </div>
        <FileSurfaceAction
          label="Previous Change (⇧⌥F5)"
          onPress={() => editor?.goToDiff("previous")}
        >
          <ArrowUpIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction label="Next Change (⌥F5)" onPress={() => editor?.goToDiff("next")}>
          <ArrowDownIcon className="size-3.5" />
        </FileSurfaceAction>
        {/* Layout toggles give way first when the panel is narrow. */}
        <span className="hidden @lg/diff-header:contents">
          <FileSurfaceAction
            label={sideBySide ? "Show inline diff" : "Show side-by-side diff"}
            pressed={sideBySide}
            onPress={() => setSideBySide(!sideBySide)}
          >
            <Columns2Icon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label={collapseUnchanged ? "Show unchanged regions" : "Collapse unchanged regions"}
            pressed={collapseUnchanged}
            onPress={() => setCollapseUnchanged(!collapseUnchanged)}
          >
            <FoldVerticalIcon className="size-3.5" />
          </FileSurfaceAction>
        </span>
        {deletedOnDisk ? null : (
          <FileSurfaceAction label="Open File" onPress={() => props.onOpenFile(repoRoot, path)}>
            <FileIcon className="size-3.5" />
          </FileSurfaceAction>
        )}
        {turnCount !== null ? null : compare === "staged" ? (
          <FileSurfaceAction
            label="Unstage Changes"
            onPress={() =>
              void runPaths(
                unstage,
                change?.originalPath ? [path, change.originalPath] : [path],
                "Couldn't unstage changes",
              )
            }
          >
            <MinusIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : (
          <>
            {change && change.status !== "untracked" ? (
              <FileSurfaceAction label="Discard Changes" onPress={() => void discardFile()}>
                <Undo2Icon className="size-3.5" />
              </FileSurfaceAction>
            ) : null}
            <FileSurfaceAction
              label="Stage Changes"
              onPress={() => void runPaths(stage, [path], "Couldn't stage changes")}
            >
              <PlusIcon className="size-3.5" />
            </FileSurfaceAction>
          </>
        )}
      </div>
      {original.error && original.data === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
          {original.error}
        </div>
      ) : binary ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          This file is binary or can't be read as text, so there is no diff to show.
        </div>
      ) : loading || modifiedContents === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner size="lg" />
        </div>
      ) : (
        <MonacoDiffEditor
          key={`${repoRoot}:${path}:${compare}`}
          environmentId={environmentId}
          cwd={repoRoot}
          relativePath={path}
          originalRevision={
            turnCount !== null ? `turn-${turnCount}` : compare === "staged" ? "HEAD" : "index"
          }
          originalContents={originalContents}
          modifiedContents={modifiedContents}
          disk={editable ? workingFile.diskData : null}
          onRefreshDisk={workingFile.refresh}
          editable={editable}
          resolvedTheme={props.resolvedTheme}
          wordWrap={props.wordWrap}
          sideBySide={sideBySide}
          collapseUnchanged={collapseUnchanged}
          root={props.surfaceRoot}
          onPendingChange={props.onPendingChange}
          onEditorChange={setEditor}
        />
      )}
    </div>
  );
}
