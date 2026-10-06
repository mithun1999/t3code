import type { EnvironmentId, ProjectContentMatch } from "@t3tools/contracts";
import {
  buildSearchRegExp,
  expandReplacement,
  findLineMatches,
} from "@t3tools/shared/searchReplace";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyMinusIcon,
  EllipsisIcon,
  ListXIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { isMacPlatform } from "~/lib/utils";
import { useProjectContentSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { workspaceIde } from "~/state/workspaceIde";

import { splitChangePath } from "./scmPresentation";
import { confirmAction, reportCommandResult } from "./workbenchCommands";

/** Asks the view to take the keyboard, optionally with the replace field open. */
export interface SearchViewRequest {
  readonly id: number;
  readonly replace: boolean;
  readonly query?: string | undefined;
}

interface SearchPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly request: SearchViewRequest | null;
  readonly onOpenMatch: (path: string, lineNumber: number) => void;
}

interface SearchViewState {
  readonly query: string;
  readonly replace: string;
  readonly showReplace: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
  readonly showDetails: boolean;
  readonly includes: string;
  readonly excludes: string;
}

const EMPTY_STATE: SearchViewState = {
  query: "",
  replace: "",
  showReplace: false,
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  showDetails: false,
  includes: "",
  excludes: "",
};

/** The search survives switching views and tabs, as VS Code's does. */
const savedStates = new Map<string, SearchViewState>();

/** Rows render in windows that grow as the list scrolls, so thousands of results stay smooth. */
const ROW_WINDOW = 400;

interface SearchRow {
  readonly key: string;
  readonly path: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly start: number;
  readonly end: number;
}

interface FileGroup {
  readonly path: string;
  readonly rows: readonly SearchRow[];
}

function groupResults(
  matches: ReadonlyArray<ProjectContentMatch>,
  dismissed: ReadonlySet<string>,
): FileGroup[] {
  const groups = new Map<string, SearchRow[]>();
  for (const match of matches) {
    if (dismissed.has(`file\0${match.path}`)) continue;
    for (const range of match.matchRanges) {
      const key = `${match.path}\0${match.lineNumber}\0${range.start}`;
      if (dismissed.has(key)) continue;
      const rows = groups.get(match.path) ?? [];
      rows.push({
        key,
        path: match.path,
        lineNumber: match.lineNumber,
        line: match.lineContent,
        start: range.start,
        end: range.end,
      });
      groups.set(match.path, rows);
    }
  }
  return [...groups].map(([path, rows]) => ({ path, rows }));
}

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function IconAction(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
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

function OptionToggle(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            pressed={props.active}
            size="xs"
            variant="segmented"
            onClick={props.onToggle}
          />
        }
      >
        <span className="font-mono text-2xs">{props.children}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Moves focus between the result rows with the arrow keys, like a tree. */
function moveRowFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...(container?.querySelectorAll<HTMLElement>("[data-search-focusable]") ?? [])];
  if (rows.length === 0) return;
  event.preventDefault();
  const current = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? Math.min(rows.length - 1, current + 1)
      : current <= 0
        ? 0
        : current - 1;
  rows[next]?.focus();
}

/** VS Code's Search view: find across the workspace, and replace. */
export function SearchPanel(props: SearchPanelProps) {
  const { environmentId, cwd, request, onOpenMatch } = props;
  const { resolvedTheme } = useTheme();
  const stateKey = `${environmentId}\0${cwd}`;
  const [state, setState] = useState<SearchViewState>(
    () => savedStates.get(stateKey) ?? EMPTY_STATE,
  );
  const update = (patch: Partial<SearchViewState>) =>
    setState((current) => ({ ...current, ...patch }));
  useEffect(() => {
    savedStates.set(stateKey, state);
  }, [stateKey, state]);

  // A ⇧⌘F or ⇧⌘H request: open the replace field or fill in the query.
  const [handledRequestId, setHandledRequestId] = useState(request?.id ?? 0);
  if (request && request.id !== handledRequestId) {
    setHandledRequestId(request.id);
    if (request.replace || request.query) {
      setState((current) => ({
        ...current,
        ...(request.replace ? { showReplace: true } : {}),
        ...(request.query ? { query: request.query } : {}),
      }));
    }
  }
  const queryInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!request) return;
    requestAnimationFrame(() => {
      const input = request.replace ? replaceInputRef.current : queryInputRef.current;
      input?.focus();
      input?.select();
    });
  }, [request]);

  const search = useProjectContentSearch({
    environmentId,
    cwd,
    query: state.query,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    useRegex: state.useRegex,
    includes: state.includes,
    excludes: state.excludes,
    thorough: true,
  });

  // Dismissed results and folded files belong to one search; a new one clears them.
  const searchKey = JSON.stringify([
    state.query,
    state.caseSensitive,
    state.wholeWord,
    state.useRegex,
    state.includes,
    state.excludes,
  ]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [resultsKey, setResultsKey] = useState(searchKey);
  if (resultsKey !== searchKey) {
    setResultsKey(searchKey);
    setDismissed(new Set());
    setCollapsed(new Set());
  }

  const groups = useMemo(
    () => groupResults(search.matches, dismissed),
    [search.matches, dismissed],
  );
  const resultCount = groups.reduce((count, group) => count + group.rows.length, 0);

  const replaceActive = state.showReplace;
  const previewRegex = useMemo(
    () =>
      replaceActive && state.replace.length > 0
        ? buildSearchRegExp({
            query: state.query,
            caseSensitive: state.caseSensitive,
            wholeWord: state.wholeWord,
            useRegex: state.useRegex,
          })
        : null,
    [
      replaceActive,
      state.replace,
      state.query,
      state.caseSensitive,
      state.wholeWord,
      state.useRegex,
    ],
  );
  const replacementFor = (row: SearchRow): string | null => {
    if (!previewRegex) return null;
    const match = findLineMatches(row.line, previewRegex, state.wholeWord).find(
      (candidate) => candidate.index === row.start,
    );
    return match ? expandReplacement(state.replace, match, state.useRegex) : state.replace;
  };

  const [visibleRows, setVisibleRows] = useState(ROW_WINDOW);
  const observeLoadMore = useCallback((sentinel: HTMLElement | null) => {
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleRows((current) => current + ROW_WINDOW);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const replaceInFiles = useAtomCommand(workspaceIde.replaceInFiles, { reportFailure: false });
  const [replacing, setReplacing] = useState(false);
  const canReplace = replaceActive && !replacing && !search.isPending && resultCount > 0;
  const runReplace = async (targets: readonly FileGroup[], announce: boolean) => {
    const files = targets
      .map((group) => ({
        relativePath: group.path,
        matches: group.rows.map((row) => ({ lineNumber: row.lineNumber, start: row.start })),
      }))
      .filter((file) => file.matches.length > 0);
    if (files.length === 0 || !canReplace) return;
    setReplacing(true);
    try {
      const result = await replaceInFiles({
        environmentId,
        input: {
          cwd,
          query: state.query,
          caseSensitive: state.caseSensitive,
          wholeWord: state.wholeWord,
          useRegex: state.useRegex,
          replacement: state.replace,
          files,
        },
      });
      if (!reportCommandResult(result, "Couldn't replace") || result._tag !== "Success") return;
      const { replacedMatches, changedFiles, skippedMatches, failedFiles } = result.value;
      const problems = [
        skippedMatches > 0
          ? `${plural(skippedMatches, "match")} changed since the search and ${skippedMatches === 1 ? "was" : "were"} left alone.`
          : null,
        ...failedFiles.map((file) => `${file.relativePath}: ${file.message}`),
      ].filter((line): line is string => line !== null);
      if (problems.length > 0) {
        toastManager.add({
          type: "warning",
          title: `Replaced ${plural(replacedMatches, "occurrence")}`,
          description: problems.join("\n"),
        });
      } else if (announce) {
        toastManager.add({
          type: "success",
          title: `Replaced ${plural(replacedMatches, "occurrence")} across ${plural(changedFiles, "file")}`,
        });
      }
    } finally {
      setReplacing(false);
      search.refresh();
    }
  };
  const replaceAll = async () => {
    if (!canReplace) return;
    const fileCount = groups.length;
    const confirmed = await confirmAction(
      `Replace ${plural(resultCount, "occurrence")} across ${plural(fileCount, "file")} with '${state.replace}'?`,
      "default",
    );
    if (confirmed) await runReplace(groups, true);
  };

  const dismiss = (key: string) => setDismissed((current) => new Set(current).add(key));
  const allCollapsed = groups.length > 0 && groups.every((group) => collapsed.has(group.path));
  // Each file header and row counts toward the rendered window.
  const windowed = useMemo(() => {
    let budget = visibleRows;
    const shown: Array<{ readonly group: FileGroup; readonly rows: readonly SearchRow[] }> = [];
    for (const group of groups) {
      if (budget <= 0) break;
      const rows = collapsed.has(group.path) ? [] : group.rows.slice(0, budget - 1);
      budget -= 1 + rows.length;
      shown.push({ group, rows });
    }
    return shown;
  }, [collapsed, groups, visibleRows]);
  const resultsRef = useRef<HTMLDivElement>(null);
  const isMac = isMacPlatform(navigator.platform);

  const summary = search.isPending ? (
    <span className="flex items-center gap-1.5">
      <Spinner size="xs" /> Searching…
    </span>
  ) : search.error ? (
    <span className="text-destructive">{search.error}</span>
  ) : search.invalidRegex ? (
    <span className="text-destructive">This isn't a valid regular expression.</span>
  ) : search.hasQuery ? (
    resultCount === 0 ? (
      "No results found. Files ignored by git aren't searched."
    ) : (
      `${plural(resultCount, "result")} in ${plural(groups.length, "file")}`
    )
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-search-panel>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-0.5 border-b border-border/60 px-3 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9"
        data-surface-subheader
      >
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          Search
        </span>
        <IconAction label="Refresh" onPress={() => search.refresh()} disabled={!search.hasQuery}>
          <RefreshIcon refreshing={search.isPending} />
        </IconAction>
        <IconAction
          label="Clear Search Results"
          onPress={() => {
            update({ query: "" });
            queryInputRef.current?.focus();
          }}
          disabled={state.query.length === 0}
        >
          <ListXIcon />
        </IconAction>
        <IconAction
          label={allCollapsed ? "Expand All" : "Collapse All"}
          onPress={() =>
            setCollapsed(allCollapsed ? new Set() : new Set(groups.map((group) => group.path)))
          }
          disabled={groups.length === 0}
        >
          <CopyMinusIcon />
        </IconAction>
      </div>

      <div className="flex shrink-0 gap-0.5 px-2 pt-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Toggle Replace"
                aria-expanded={state.showReplace}
                className="flex w-4 shrink-0 items-start justify-center rounded-sm pt-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                onClick={() => update({ showReplace: !state.showReplace })}
              />
            }
          >
            {state.showReplace ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup>Toggle Replace</TooltipPopup>
        </Tooltip>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <InputGroup className="h-7">
            <InputGroupInput
              ref={queryInputRef}
              data-search-query
              size="sm"
              aria-label="Search"
              placeholder="Search"
              spellCheck={false}
              value={state.query}
              onChange={(event) => update({ query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  search.refresh();
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  resultsRef.current
                    ?.querySelector<HTMLElement>("[data-search-focusable]")
                    ?.focus();
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <OptionToggle
                label="Match Case"
                active={state.caseSensitive}
                onToggle={() => update({ caseSensitive: !state.caseSensitive })}
              >
                Aa
              </OptionToggle>
              <OptionToggle
                label="Match Whole Word"
                active={state.wholeWord}
                onToggle={() => update({ wholeWord: !state.wholeWord })}
              >
                <span className="underline decoration-1 underline-offset-2">ab</span>
              </OptionToggle>
              <OptionToggle
                label="Use Regular Expression"
                active={state.useRegex}
                onToggle={() => update({ useRegex: !state.useRegex })}
              >
                .*
              </OptionToggle>
            </InputGroupAddon>
          </InputGroup>
          {state.showReplace ? (
            <div className="flex items-center gap-0.5">
              <Input
                ref={replaceInputRef}
                data-search-replace
                size="compact"
                aria-label="Replace"
                placeholder="Replace"
                spellCheck={false}
                value={state.replace}
                onChange={(event) => update({ replace: event.target.value })}
                onKeyDown={(event) => {
                  const replaceAllKeys =
                    event.key === "Enter" &&
                    event.altKey &&
                    (isMac ? event.metaKey : event.ctrlKey);
                  if (replaceAllKeys) {
                    event.preventDefault();
                    void replaceAll();
                  }
                }}
              />
              <IconAction
                label={`Replace All (${isMac ? "⌥⌘Enter" : "Ctrl+Alt+Enter"})`}
                onPress={() => void replaceAll()}
                disabled={!canReplace}
              >
                {replacing ? <Spinner size="xs" /> : <ReplaceAllIcon />}
              </IconAction>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 justify-end px-2">
        <IconAction
          label="Toggle Search Details"
          onPress={() => update({ showDetails: !state.showDetails })}
        >
          <EllipsisIcon />
        </IconAction>
      </div>
      {state.showDetails ? (
        <div className="flex shrink-0 flex-col gap-1 px-2 pb-1 pl-6">
          <label className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
            files to include
            <Input
              size="compact"
              placeholder="e.g. *.ts, src/**/include"
              spellCheck={false}
              value={state.includes}
              onChange={(event) => update({ includes: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
            files to exclude
            <Input
              size="compact"
              placeholder="e.g. *.test.ts, node_modules"
              spellCheck={false}
              value={state.excludes}
              onChange={(event) => update({ excludes: event.target.value })}
            />
          </label>
        </div>
      ) : null}

      {summary ? (
        <div className="shrink-0 px-3 pt-0.5 pb-1.5 pl-6 text-2xs text-muted-foreground">
          {summary}
          {search.truncated && !search.isPending && resultCount > 0 ? (
            <p className="pt-1">
              The results only contain some of the matches. Be more specific to narrow them down.
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        ref={resultsRef}
        role="tree"
        aria-label="Search results"
        className="min-h-0 flex-1 overflow-y-auto pb-4"
        onKeyDown={(event) => moveRowFocus(event, resultsRef.current)}
      >
        {windowed.map(({ group, rows }) => {
          const { name, directory } = splitChangePath(group.path);
          const isCollapsed = collapsed.has(group.path);
          const toggle = () =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(group.path)) next.delete(group.path);
              else next.add(group.path);
              return next;
            });
          return (
            <div key={group.path} role="group" data-search-file={group.path}>
              <div
                role="treeitem"
                aria-expanded={!isCollapsed}
                aria-label={`${group.path}, ${plural(group.rows.length, "result")}`}
                tabIndex={0}
                data-search-focusable
                className="group/file flex h-[22px] cursor-pointer items-center gap-1 pr-2 pl-1.5 text-xs outline-none hover:bg-accent/50 focus-visible:bg-accent/70"
                onClick={toggle}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle();
                  }
                }}
              >
                {isCollapsed ? (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <PierreEntryIcon
                  pathValue={group.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3.5 shrink-0"
                />
                <span className="shrink truncate">{name}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                  {directory}
                </span>
                <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/file:flex group-hover/file:flex">
                  {replaceActive ? (
                    <IconAction
                      label="Replace All"
                      onPress={() => void runReplace([group], false)}
                      disabled={!canReplace}
                    >
                      <ReplaceAllIcon />
                    </IconAction>
                  ) : null}
                  <IconAction label="Dismiss" onPress={() => dismiss(`file\0${group.path}`)}>
                    <XIcon />
                  </IconAction>
                </span>
                <span className="rounded-full bg-muted px-1.5 text-3xs tabular-nums text-muted-foreground">
                  {group.rows.length}
                </span>
              </div>
              {rows.map((row) => {
                const replacement = replacementFor(row);
                const lead = row.line.slice(Math.max(0, row.start - 40), row.start);
                const trimmedLead = lead.trimStart();
                const cut = row.start > 40 && trimmedLead.length === lead.length;
                const matched = row.line.slice(row.start, row.end);
                const open = () => onOpenMatch(row.path, row.lineNumber);
                return (
                  <div
                    key={row.key}
                    role="treeitem"
                    tabIndex={0}
                    aria-label={`${matched} at line ${row.lineNumber}`}
                    data-search-focusable
                    data-search-match={`${row.path}:${row.lineNumber}:${row.start}`}
                    className="group/row flex h-[22px] cursor-pointer items-center gap-1 pr-2 pl-9 text-xs outline-none hover:bg-accent/50 focus-visible:bg-accent/70"
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        open();
                      } else if (event.key === "Delete" || event.key === "Backspace") {
                        event.preventDefault();
                        dismiss(row.key);
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate whitespace-pre">
                      {cut ? "…" : ""}
                      {trimmedLead}
                      {replacement === null ? (
                        <mark className="rounded-xs bg-warning/30 text-foreground">{matched}</mark>
                      ) : (
                        <>
                          <del className="rounded-xs bg-diff-deletion/30 text-foreground">
                            {matched}
                          </del>
                          <ins className="rounded-xs bg-diff-addition/30 text-foreground no-underline">
                            {replacement}
                          </ins>
                        </>
                      )}
                      {row.line.slice(row.end, row.end + 200)}
                    </span>
                    <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
                      {replaceActive ? (
                        <IconAction
                          label="Replace"
                          onPress={() => void runReplace([{ path: row.path, rows: [row] }], false)}
                          disabled={!canReplace}
                        >
                          <ReplaceIcon />
                        </IconAction>
                      ) : null}
                      <IconAction label="Dismiss" onPress={() => dismiss(row.key)}>
                        <XIcon />
                      </IconAction>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {resultCount + groups.length > visibleRows ? (
          <div ref={observeLoadMore} className="h-8" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}
