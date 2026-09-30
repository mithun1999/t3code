import { useAtomValue } from "@effect/atom-react";
import { extractLineFromQuery } from "@t3tools/shared/fuzzyScorer";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { type CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import {
  buildFilePickerRows,
  type FilePickerRow,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "./ProjectFilePicker.logic";
import { readRecentFiles } from "./recentFiles";
import { useProjectFilePickerQuery } from "./projectFilesQueryState";

interface ProjectFilePickerProps {
  readonly setOpen: (open: boolean) => void;
}

function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly indices: ReadonlyArray<number>;
  readonly value: string;
}) {
  if (!props.active) return props.value;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of props.indices) {
    if (start < index) parts.push(props.value.slice(start, index));
    parts.push(
      <strong className="font-semibold text-foreground" key={index}>
        {props.value[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < props.value.length) parts.push(props.value.slice(start));

  return <span className="text-muted-foreground">{parts}</span>;
}

function getEmptyStateMessage(query: string, error: string | null, isPending: boolean): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending) return isSearching ? "Searching workspace files…" : "Indexing workspace files…";
  return isSearching ? "No matching files." : "No files found.";
}

function EmptyProjectFilePicker() {
  return (
    <CommandPaletteContent
      aria-label="File picker"
      escapeLabel="Back"
      footerActionLabel="Open file"
      inputProps={{ disabled: true, placeholder: "Search files…" }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        Open a project to search its files.
      </div>
    </CommandPaletteContent>
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const { target } = props;
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  // "app.ts:42" searches for app.ts and opens it at line 42, as in VS Code.
  const lineTarget = extractLineFromQuery(query);
  const fileQuery = lineTarget?.filter ?? query;
  const result = useProjectFilePickerQuery(
    target.environmentId,
    target.cwd,
    fileQuery,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    { ranking: "vscode" },
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Read once per opening, like VS Code's editor history.
  const [recentPaths] = useState(() => readRecentFiles(target.environmentId, target.cwd));
  const rows = useMemo(
    () =>
      buildFilePickerRows({
        query: result.matchedQuery,
        recentPaths,
        entries: result.entries,
      }),
    [recentPaths, result.entries, result.matchedQuery],
  );
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  const line = lineTarget?.line;
  const toItem = useCallback(
    (row: FilePickerRow): CommandPaletteActionItem => ({
      kind: "action",
      value: `file:${row.path}`,
      searchTerms: [row.name, row.path],
      title: (
        <HighlightedFuzzyText
          active={hasMatchedQuery}
          value={row.name}
          indices={row.nameMatchIndices}
        />
      ),
      ...(row.folder
        ? {
            description: (
              <HighlightedFuzzyText
                active={hasMatchedQuery}
                value={row.folder}
                indices={row.folderMatchIndices}
              />
            ),
          }
        : {}),
      icon: <PierreEntryIcon pathValue={row.path} kind="file" theme={resolvedTheme} />,
      run: async () => {
        useRightPanelStore.getState().openFile(target.threadRef, row.path, line);
      },
    }),
    [hasMatchedQuery, line, resolvedTheme, target.threadRef],
  );
  const groups = useMemo(
    () =>
      [
        { value: "recently-opened", label: "Recently opened", items: rows.recent.map(toItem) },
        { value: "project-files", label: target.projectName, items: rows.files.map(toItem) },
      ].filter((group) => group.items.length > 0),
    [rows, target.projectName, toItem],
  );

  const emptyStateMessage = getEmptyStateMessage(fileQuery, result.error, result.isPending);

  return (
    <CommandPaletteContent
      aria-label="File picker"
      autoHighlight="always"
      escapeLabel="Back"
      footerActionLabel="Open file"
      inputProps={{ placeholder: "Search files by name (append :line to go to a line)…" }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="project-file-picker"
      value={query}
    >
      <CommandPaletteResults
        groups={groups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          props.setOpen(false);
          void item.run();
        }}
        emptyStateMessage={emptyStateMessage}
      />
    </CommandPaletteContent>
  );
}

export function ProjectFilePicker(props: ProjectFilePickerProps) {
  const target = useActiveProjectTarget();

  if (!target) {
    return <EmptyProjectFilePicker />;
  }

  return <OpenProjectFilePicker setOpen={props.setOpen} target={target} />;
}
