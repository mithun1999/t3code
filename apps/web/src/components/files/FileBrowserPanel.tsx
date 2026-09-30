import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { FILE_TREE_TAG_NAME, type GitStatus } from "@pierre/trees";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, FilePlusIcon, FolderPlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useAtomCommand } from "~/state/use-atom-command";
import { workspaceIde } from "~/state/workspaceIde";
import { resolvePathLinkTarget } from "~/terminal-links";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { buildRootLabels, isRootPath, labelForRoot } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { treeDirectoryForRoot, useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";
import {
  duplicateName,
  isPlaceholderPath,
  isSelfOrDescendant,
  joinTreePath,
  leafName,
  NEW_ENTRY_PLACEHOLDER,
  parentTreePath,
  resolveTreePath,
  type RootedPath,
  stripTrailingSlash,
  treePathFor,
  typedEntryName,
} from "./workbench/explorerPaths";
import { explorerGitStatuses } from "./workbench/scmPresentation";
import type { ScmStatuses } from "./workbench/useScmStatuses";
import { useWorkspaceChanges } from "./workbench/useWorkspaceChanges";
import {
  commandFailureKind,
  confirmAction,
  reportCommandResult,
} from "./workbench/workbenchCommands";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** Entry currently open in the surface; revealed and selected in the tree. A directory is expanded. */
  selectedPath: string | null;
  /** Repo root that `selectedPath` is relative to, when it is not the workspace root. */
  selectedRoot?: string | undefined;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  // Multi-repo workspaces (#923): when set, list the union of these repo roots
  // and group the tree by repo. Omitted/single-entry keeps single-root behavior.
  repoRoots?: readonly string[] | undefined;
  onOpenFile: (
    relativePath: string,
    root?: string,
    options?: { readonly preview?: boolean },
  ) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
  /** Git status per repo, for VS Code-style colours and badges on changed files. */
  scm?: ScmStatuses | undefined;
  /** A file or folder was renamed or moved; open tabs under it should follow. */
  onEntryMoved?: (from: RootedPath, to: RootedPath) => void;
}

interface TreeEntryInfo {
  readonly relativePath: string;
  readonly root?: string;
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function ExplorerHeaderButton(props: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            onClick={props.onPress}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** VS Code's thin progress bar, shown only while a folder has nothing to show yet. */
function ExplorerProgressBar(props: { active: boolean }) {
  return (
    <div role={props.active ? "status" : undefined} className="relative h-0.5 shrink-0">
      <div
        aria-hidden
        data-loading={props.active}
        className="preview-loading-progress pointer-events-none absolute inset-0 origin-left rounded-r-full bg-primary"
      />
      {props.active ? <span className="sr-only">Loading files…</span> : null}
    </div>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath: selectedRelativePath,
  selectedRoot,
  selectedPathRevealId,
  repoRoots,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  scm,
  onEntryMoved,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  // Multi-repo workspaces (#923): each repo is a top-level node named by its
  // label, and every tree path below it is prefixed with that label so
  // same-named files across repos don't collide.
  const multiRepoRootsKey = repoRoots && repoRoots.length > 1 ? repoRoots.join("\0") : "";
  const { rootLabels, directoryRoots, searchRoots } = useMemo(() => {
    if (!multiRepoRootsKey)
      return { rootLabels: null, directoryRoots: undefined, searchRoots: undefined };
    const roots = multiRepoRootsKey.split("\0");
    const rootLabels = buildRootLabels(roots);
    return {
      rootLabels,
      directoryRoots: roots.map((root) => ({ root, label: rootLabels.get(root) ?? root })),
      searchRoots: roots,
    };
  }, [multiRepoRootsKey]);
  // Tree paths sit under their repo's label, so an open from outside the tree
  // (a chat link, the file picker) maps onto that key to be found and revealed.
  // A repo root linked by its absolute path selects that repo's top-level node.
  // The workspace root is the whole tree, so it selects nothing.
  const selectedLabel =
    rootLabels && selectedRoot ? labelForRoot(rootLabels, selectedRoot) : undefined;
  const selectedRootLabel =
    rootLabels && selectedRelativePath ? labelForRoot(rootLabels, selectedRelativePath) : undefined;
  const selectedPath =
    selectedRootLabel ??
    (selectedRelativePath && isRootPath([cwd], selectedRelativePath)
      ? null
      : selectedRelativePath && selectedLabel !== undefined
        ? `${selectedLabel}/${selectedRelativePath}`
        : selectedRelativePath);
  // Label to root, longest label first, for mapping tree paths back to repos.
  const labelSources = useMemo(
    () =>
      directoryRoots
        ? directoryRoots.toSorted((left, right) => right.label.length - left.label.length)
        : null,
    [directoryRoots],
  );
  const {
    entries: directoryEntries,
    load,
    refresh,
    rememberExpanded,
    initialExpandedPaths,
    ready,
    error,
    isPending,
  } = useDirectoryEntries(environmentId, cwd, directoryRoots);
  const watchedRoots = useMemo(() => searchRoots ?? [cwd], [cwd, searchRoots]);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd, query: query.slice(0, 256), roots: searchRoots },
    200,
  );
  const entries = useMemo(() => {
    const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
    if (query.trim() && !pathSearch.isPending) {
      for (const searchEntry of pathSearch.entries) {
        let entry = searchEntry;
        if (rootLabels) {
          const label = searchEntry.root ? labelForRoot(rootLabels, searchEntry.root) : undefined;
          if (label === undefined) continue;
          entry = { ...searchEntry, path: `${label}/${searchEntry.path}` };
        }
        if (!result.has(entry.path)) result.set(entry.path, entry);
        const segments = entry.path.split("/");
        for (let index = 1; index < segments.length; index++) {
          const path = segments.slice(0, index).join("/");
          if (!result.has(path))
            result.set(path, {
              path,
              kind: "directory",
              ...(entry.root ? { root: entry.root } : {}),
            });
        }
      }
    }
    return [...result.values()];
  }, [directoryEntries, pathSearch.entries, pathSearch.isPending, query, rootLabels]);

  // Map each tree path back to its repo-relative path and owning root so
  // opening a file resolves against the repo it lives in.
  const { treePaths, directoryPaths, entryKinds, entryInfo } = useMemo(() => {
    const treePaths: string[] = [];
    const directoryPaths: string[] = [];
    const entryKinds = new Map<string, ProjectEntry["kind"]>();
    const entryInfo = new Map<string, TreeEntryInfo>();
    for (const entry of entries) {
      const label = rootLabels && entry.root ? labelForRoot(rootLabels, entry.root) : undefined;
      const relativePath =
        label !== undefined && entry.path.startsWith(`${label}/`)
          ? entry.path.slice(label.length + 1)
          : entry.path;
      entryKinds.set(entry.path, entry.kind);
      entryInfo.set(entry.path, {
        relativePath,
        ...(entry.root ? { root: entry.root } : {}),
      });
      treePaths.push(treePath(entry));
      if (entry.kind === "directory") directoryPaths.push(treePath(entry));
    }
    return { treePaths, directoryPaths, entryKinds, entryInfo };
  }, [entries, rootLabels]);
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const entryInfoRef = useRef<ReadonlyMap<string, TreeEntryInfo>>(entryInfo);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  const createEntry = useAtomCommand(workspaceIde.createEntry, { reportFailure: false });
  const moveEntry = useAtomCommand(workspaceIde.moveEntry, { reportFailure: false });
  const copyEntry = useAtomCommand(workspaceIde.copyEntry, { reportFailure: false });
  const deleteEntries = useAtomCommand(workspaceIde.deleteEntries, { reportFailure: false });
  const resolvePath = useCallback(
    (treePath: string) => resolveTreePath(treePath, { cwd, labels: labelSources }),
    [cwd, labelSources],
  );
  /** The `root` onOpenFile expects: set only when the tree spans several repos. */
  const openRoot = (rooted: RootedPath) => (labelSources ? rooted.root : undefined);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const newEntryKindRef = useRef<"file" | "directory">("file");

  /** The folder a new file goes in: the one focused, the focused file's, or the top. */
  const defaultNewEntryDirectory = (): string => {
    const model = treeModelRef.current;
    const focused = model?.getFocusedPath() ?? model?.getSelectedPaths().at(-1) ?? null;
    if (focused) {
      const path = stripTrailingSlash(focused);
      if (focused.endsWith("/") || entryKindsRef.current.get(path) === "directory") return path;
      const parent = parentTreePath(path);
      if (parent || !labelSources) return parent;
    }
    return labelSources?.find((source) => source.root === repoRoots?.[0])?.label ?? "";
  };

  /** VS Code's inline "New File…" row: an empty name to type into. */
  const startNewEntry = async (kind: "file" | "directory", directory: string) => {
    const model = treeModelRef.current;
    if (!model) return;
    if (directory) {
      await load(directory);
      const folder = model.getItem(`${directory}/`);
      if (folder && "expand" in folder) folder.expand();
    }
    const placeholder = `${joinTreePath(directory, NEW_ENTRY_PLACEHOLDER)}${kind === "directory" ? "/" : ""}`;
    if (!model.getItem(placeholder)) model.add(placeholder);
    newEntryKindRef.current = kind;
    model.startRenaming(placeholder, { removeIfCanceled: true });
  };

  const handleRename = (event: {
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly isFolder: boolean;
  }) => {
    const model = treeModelRef.current;
    const { sourcePath, destinationPath, isFolder } = event;
    const canonical = (path: string) => (isFolder ? `${path}/` : path);
    // The tree moves the row to its new name right after this returns.
    const afterTreeMove = (update: () => void) => setTimeout(update, 0);
    if (isPlaceholderPath(sourcePath)) {
      const name = typedEntryName(destinationPath);
      const directory = parentTreePath(destinationPath);
      const cleanPath = joinTreePath(directory, name);
      const dropRow = () =>
        afterTreeMove(() =>
          model?.remove(canonical(destinationPath), isFolder ? { recursive: true } : undefined),
        );
      const target = name ? resolvePath(cleanPath) : null;
      if (!target?.relativePath) {
        dropRow();
        return;
      }
      if (cleanPath !== destinationPath) dropRow();
      void createEntry({
        environmentId,
        input: {
          cwd: target.root,
          relativePath: target.relativePath,
          kind: newEntryKindRef.current,
        },
      }).then((result) => {
        const created = reportCommandResult(
          result,
          isFolder ? "Couldn't create the folder" : "Couldn't create the file",
        );
        if (!created) {
          if (cleanPath === destinationPath) dropRow();
          return;
        }
        refresh([directory]);
        if (!isFolder) onOpenFile(target.relativePath, openRoot(target));
      });
      return;
    }
    const from = resolvePath(sourcePath);
    const to = resolvePath(destinationPath);
    if (!from?.relativePath || !to?.relativePath || from.root !== to.root) return;
    void moveEntry({
      environmentId,
      input: { cwd: from.root, fromPath: from.relativePath, toPath: to.relativePath },
    }).then((result) => {
      if (!reportCommandResult(result, "Couldn't rename")) {
        model?.move(canonical(destinationPath), canonical(sourcePath));
        return;
      }
      refresh([parentTreePath(sourcePath)]);
      onEntryMoved?.(from, to);
    });
  };
  const handleRenameRef = useRef(handleRename);

  const handleDrop = async (event: {
    readonly draggedPaths: readonly string[];
    readonly target: { readonly kind: "directory" | "root"; readonly directoryPath: string | null };
  }) => {
    const model = treeModelRef.current;
    if (!model) return;
    const directory =
      event.target.kind === "root" ? "" : stripTrailingSlash(event.target.directoryPath ?? "");
    const moves = event.draggedPaths.flatMap((draggedPath) => {
      const isFolder = draggedPath.endsWith("/");
      const sourcePath = stripTrailingSlash(draggedPath);
      const destinationPath = joinTreePath(directory, leafName(sourcePath));
      const from = resolvePath(sourcePath);
      const to = resolvePath(destinationPath);
      if (!from?.relativePath || !to?.relativePath) return [];
      const suffix = isFolder ? "/" : "";
      return [
        {
          from,
          to,
          sourcePath: `${sourcePath}${suffix}`,
          destinationPath: `${destinationPath}${suffix}`,
        },
      ];
    });
    if (moves.length === 0) return;
    const revert = (move: (typeof moves)[number]) => {
      if (model.getItem(move.destinationPath)) model.move(move.destinationPath, move.sourcePath);
    };
    const into = leafName(directory) || projectName;
    const confirmed = await confirmAction(
      moves.length === 1
        ? `Are you sure you want to move '${leafName(moves[0]!.sourcePath)}' into '${into}'?`
        : `Are you sure you want to move ${moves.length} files into '${into}'?`,
      "default",
    );
    if (!confirmed) {
      for (const move of moves) revert(move);
      return;
    }
    const touched = new Set([directory]);
    for (const move of moves) {
      const result = await moveEntry({
        environmentId,
        input: {
          cwd: move.from.root,
          fromPath: move.from.relativePath,
          toPath: move.to.relativePath,
        },
      });
      touched.add(parentTreePath(move.sourcePath));
      if (!reportCommandResult(result, `Couldn't move '${leafName(move.sourcePath)}'`)) {
        revert(move);
        continue;
      }
      onEntryMoved?.(move.from, move.to);
    }
    refresh(touched);
  };
  const handleDropRef = useRef(handleDrop);

  /** Deletes to the Trash, offering a permanent delete when that isn't possible. */
  const deleteTreeEntries = async (treePaths: readonly string[]) => {
    const targets = treePaths.flatMap((treePath) => {
      const rooted = resolvePath(treePath);
      return rooted?.relativePath ? [{ treePath: stripTrailingSlash(treePath), rooted }] : [];
    });
    if (targets.length === 0) return;
    const subject =
      targets.length === 1 ? `'${leafName(targets[0]!.treePath)}'` : `${targets.length} items`;
    const confirmed = await confirmAction(
      `Are you sure you want to delete ${subject}?\nYou can restore ${targets.length === 1 ? "it" : "them"} from the Trash.`,
    );
    if (!confirmed) return;
    const byRoot = new Map<string, string[]>();
    for (const { rooted } of targets) {
      byRoot.set(rooted.root, [...(byRoot.get(rooted.root) ?? []), rooted.relativePath]);
    }
    for (const [root, relativePaths] of byRoot) {
      let result = await deleteEntries({
        environmentId,
        input: { cwd: root, relativePaths, permanently: false },
      });
      if (commandFailureKind(result) === "trash_unavailable") {
        const permanently = await confirmAction(
          `Do you want to permanently delete ${subject}?\nThey can't be moved to the Trash. This can't be undone.`,
        );
        if (!permanently) continue;
        result = await deleteEntries({
          environmentId,
          input: { cwd: root, relativePaths, permanently: true },
        });
      }
      reportCommandResult(result, `Couldn't delete ${subject}`);
    }
    refresh(targets.map(({ treePath }) => parentTreePath(treePath)));
  };

  const duplicateTreeEntry = async (treePath: string) => {
    const path = stripTrailingSlash(treePath);
    const source = resolvePath(path);
    if (!source?.relativePath) return;
    const directory = parentTreePath(path);
    const siblings = new Set(
      directoryEntries
        .filter((entry) => parentTreePath(entry.path) === directory)
        .map((entry) => leafName(entry.path)),
    );
    const name = duplicateName(leafName(path), (candidate) => siblings.has(candidate));
    const sourceDirectory = parentTreePath(source.relativePath);
    const result = await copyEntry({
      environmentId,
      input: {
        cwd: source.root,
        fromPath: source.relativePath,
        toPath: joinTreePath(sourceDirectory, name),
      },
    });
    if (reportCommandResult(result, `Couldn't duplicate '${leafName(path)}'`)) refresh([directory]);
  };

  const copyText = async (text: string, title: string) => {
    try {
      await writeTextToClipboard(text);
      toastManager.add({ type: "success", title, description: text });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  /** Combines the file actions (open/reveal/open with) with the explorer's own actions. */
  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const treePath = stripTrailingSlash(item.path);
    const rooted = resolvePath(treePath);
    const isRepoNode = rooted !== null && rooted.relativePath === "";
    const isFolder = item.kind === "directory";
    const mention = serializeComposerFileLink(rooted?.relativePath || treePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    const fileTarget = {
      environmentId,
      filePath: rooted?.relativePath || treePath,
      workspaceRoot: rooted?.root ?? cwd,
    };
    const fileMenuItems = isRepoNode ? [] : fileContextMenu.buildItems(fileTarget);
    const newEntryDirectory = isFolder ? treePath : parentTreePath(treePath);
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "new-file", label: "New File…" },
          { id: "new-folder", label: "New Folder…" },
          ...fileMenuItems.map((entry, index) =>
            index === 0 ? { ...entry, separatorBefore: true } : entry,
          ),
          { id: "copy-path", label: "Copy Path", separatorBefore: true },
          ...(isRepoNode ? [] : [{ id: "copy-relative-path", label: "Copy Relative Path" }]),
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
          ...(isRepoNode
            ? []
            : [
                { id: "duplicate", label: "Duplicate", separatorBefore: true },
                { id: "rename", label: "Rename…" },
                { id: "delete", label: "Delete", destructive: true },
              ]),
        ],
        position,
      );
      if (clicked === null) return;
      // "Open with" submenu selections report the child id ("editor:<id>"),
      // which is not present in the top-level item list.
      const isFileMenuAction =
        fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
      if (isFileMenuAction) {
        await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
        return;
      }
      switch (clicked) {
        case "new-file":
        case "new-folder":
          context.close({ restoreFocus: false });
          await startNewEntry(clicked === "new-file" ? "file" : "directory", newEntryDirectory);
          return;
        case "rename":
          context.close({ restoreFocus: false });
          treeModelRef.current?.startRenaming(item.path);
          return;
        case "delete":
          await deleteTreeEntries([item.path]);
          return;
        case "duplicate":
          await duplicateTreeEntry(item.path);
          return;
        case "copy-path":
          if (rooted) {
            await copyText(
              rooted.relativePath
                ? resolvePathLinkTarget(rooted.relativePath, rooted.root)
                : rooted.root,
              "Path copied",
            );
          }
          return;
        case "copy-relative-path":
          if (rooted) await copyText(rooted.relativePath, "Relative path copied");
          return;
        case "copy-mention":
          await copyText(mention, "Mention copied");
          return;
        case "add-to-chat": {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  const deleteTreeEntriesRef = useRef(deleteTreeEntries);
  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
    showEntryContextMenuRef.current = showEntryContextMenu;
    handleRenameRef.current = handleRename;
    handleDropRef.current = handleDrop;
    deleteTreeEntriesRef.current = deleteTreeEntries;
  });

  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows drag into the chat composer as mentions, and onto folders to move
    // them, which asks first as VS Code does.
    dragAndDrop: {
      canDrop: ({ draggedPaths, target }) => {
        if (target.kind === "root" && labelSources) return false;
        const directory =
          target.kind === "root" ? "" : stripTrailingSlash(target.directoryPath ?? "");
        const targetRoot = target.kind === "root" ? cwd : resolvePath(directory)?.root;
        return draggedPaths.every((draggedPath) => {
          const source = resolvePath(draggedPath);
          return (
            source !== null &&
            source.relativePath !== "" &&
            source.root === targetRoot &&
            !isPlaceholderPath(draggedPath) &&
            parentTreePath(draggedPath) !== directory &&
            !isSelfOrDescendant(draggedPath, directory)
          );
        });
      },
      onDropComplete: (event) => {
        void handleDropRef.current(event);
      },
    },
    renaming: {
      // Repo folders in a multi-repo workspace are the repos themselves.
      canRename: (item) => resolvePath(item.path)?.relativePath !== "",
      onRename: (event) => handleRenameRef.current(event),
      onError: (message) =>
        toastManager.add({ type: "error", title: "Couldn't rename", description: message }),
    },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (!selectedPath || entryKindsRef.current.get(selectedPath) !== "file") {
        return;
      }
      treeSelectionPathRef.current = selectedPath;
      const info = entryInfoRef.current.get(selectedPath);
      if (info) {
        onOpenFile(info.relativePath, info.root);
      }
    },
    paths: [],
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(model, directoryPaths, expanded);
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const expandedPathsRef = useRef(new Set<string>());
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          expandedPathsRef.current.delete(path);
        }
      }
      // Reopening the panel restores these folders as they were.
      rememberExpanded([...expandedPathsRef.current]);
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, load, model, rememberExpanded]);

  // Colour changed files as VS Code does, and dim ignored ones.
  const gitStatusByTreePath = useMemo(() => {
    const result = new Map<string, GitStatus>();
    for (const repo of scm?.repos ?? []) {
      if (!repo.status?.isRepo) continue;
      for (const [relativePath, status] of explorerGitStatuses(repo.status, repo.root)) {
        const path = treePathFor({ root: repo.root, relativePath }, labelSources);
        if (path !== null) result.set(path, status);
      }
    }
    return result;
  }, [labelSources, scm?.repos]);
  useEffect(() => {
    model.setGitStatus([
      ...entries
        .filter((entry) => entry.ignored && !gitStatusByTreePath.has(entry.path))
        .map((entry) => ({ path: treePath(entry), status: "ignored" as const })),
      ...[...gitStatusByTreePath].map(([path, status]) => ({ path, status })),
    ]);
  }, [entries, gitStatusByTreePath, model]);
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void (async () => {
      const segments = selectedPath.split("/");
      for (let index = 0; index < segments.length && !controller.signal.aborted; index++) {
        await load(segments.slice(0, index).join("/"));
      }
    })();
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });
  // The server watches each root, so files an agent or another app creates,
  // renames or deletes show up without a refresh.
  useWorkspaceChanges(environmentId, watchedRoots, (root, event) => {
    if (event.overflow) {
      refresh();
      return;
    }
    const folders = event.directories.flatMap((directory) => {
      const folder = treeDirectoryForRoot(directoryRoots, root, directory);
      return folder === null ? [] : [folder];
    });
    if (folders.length > 0) refresh(folders);
  });

  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    entryInfoRef.current = entryInfo;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths, { initialExpandedPaths });
      return;
    }
    // Renames, moves and new entries already changed the tree; skip what it has.
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths).filter((update) =>
      update.type === "add"
        ? model.getItem(update.path) === null
        : update.type === "remove"
          ? model.getItem(update.path) !== null
          : true,
    );
    if (updates.length > 0) model.batch(updates);
  }, [ready, entryInfo, entryKinds, initialExpandedPaths, model, treePaths]);

  useEffect(() => {
    if (expandAll && !query.trim()) setAllDirectoriesExpanded(model, directoryPaths, true);
  }, [directoryPaths, expandAll, model, query]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    // An unloaded entry has no row to reveal yet; folders do, and chat links can
    // point at them.
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    // Directory rows are registered with a trailing slash (see treePath).
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash, so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  // A single click opens a preview tab; a double click keeps it open (VS Code).
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const handleDoubleClick = (event: MouseEvent) => {
      const row = event
        .composedPath()
        .find(
          (node): node is Element => node instanceof Element && node.hasAttribute("data-item-path"),
        );
      const path = row?.getAttribute("data-item-path");
      if (!path || path.endsWith("/")) return;
      const info = entryInfoRef.current.get(path);
      if (info && entryKindsRef.current.get(path) === "file") {
        onOpenFileRef.current(info.relativePath, info.root, { preview: false });
      }
    };
    panel.addEventListener("dblclick", handleDoubleClick);
    return () => panel.removeEventListener("dblclick", handleDoubleClick);
  }, []);

  // VS Code's keys on the focused row: F2 renames, ⌘⌫ or Delete deletes.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const origin = event.composedPath()[0];
      if (origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement) return;
      if (!(event.target instanceof Element) || !event.target.matches(FILE_TREE_TAG_NAME)) return;
      if (event.key === "F2") {
        const focused = model.getFocusedPath();
        if (focused && resolvePath(focused)?.relativePath) {
          event.preventDefault();
          model.startRenaming(focused);
        }
        return;
      }
      if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
        const selected = model.getSelectedPaths();
        const paths =
          selected.length > 0 ? selected : [model.getFocusedPath()].filter((path) => path !== null);
        if (paths.length === 0) return;
        event.preventDefault();
        void deleteTreeEntriesRef.current(paths);
      }
    };
    panel.addEventListener("keydown", handleKeyDown);
    return () => panel.removeEventListener("keydown", handleKeyDown);
  }, [model, resolvePath]);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        <ExplorerHeaderButton
          label="New File…"
          onPress={() => void startNewEntry("file", defaultNewEntryDirectory())}
        >
          <FilePlusIcon className="size-3.5" />
        </ExplorerHeaderButton>
        <ExplorerHeaderButton
          label="New Folder…"
          onPress={() => void startNewEntry("directory", defaultNewEntryDirectory())}
        >
          <FolderPlusIcon className="size-3.5" />
        </ExplorerHeaderButton>
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        {directoryPaths.length > 0 ? (
          <ExplorerHeaderButton
            label={
              expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
            }
            onPress={toggleAllDirectories}
          >
            {allDirectoriesExpanded ? (
              <ChevronsDownUpIcon className="size-3.5" />
            ) : (
              <ChevronsUpDownIcon className="size-3.5" />
            )}
          </ExplorerHeaderButton>
        ) : null}
      </div>
      <ExplorerProgressBar active={isPending || pathSearch.isPending} />
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      <FileTree
        model={model}
        aria-label={`${projectName} files`}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
    </div>
  );
}
