import type { ProjectEntry } from "@t3tools/contracts";
import {
  compareItemsByFuzzyScore,
  type FuzzyMatch,
  type ItemScore,
  prepareQuery,
  type ScorableItem,
  scoreItemFuzzy,
} from "@t3tools/shared/fuzzyScorer";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

export const PROJECT_FILE_PICKER_RESULT_LIMIT = 200;

export interface ProjectFilePickerMatch {
  readonly name: string;
  readonly nameMatchIndices: ReadonlyArray<number>;
  readonly path: string;
  readonly pathMatchIndices: ReadonlyArray<number>;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * First ordered subsequence of `query` inside `value`, as highlight indices.
 * Returns null when `value` does not contain the subsequence at all — the
 * entry still renders (the server matched it), just without highlights.
 */
function findMatchIndices(value: string, query: string): number[] | null {
  if (!query) return [];

  const normalizedValue = value.toLowerCase();
  const indices: number[] = [];
  let queryIndex = 0;

  for (let valueIndex = 0; valueIndex < normalizedValue.length; valueIndex += 1) {
    if (normalizedValue[valueIndex] !== query[queryIndex]) continue;
    indices.push(valueIndex);
    queryIndex += 1;
    if (queryIndex === query.length) return indices;
  }

  return null;
}

/**
 * Maps server search results to picker rows. Server ordering is preserved —
 * ranking already happened there; this pass only filters to files and
 * computes highlight positions with the same query normalization the server
 * applied.
 */
export function getProjectFilePickerMatches(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
  limit = PROJECT_FILE_PICKER_RESULT_LIMIT,
): ProjectFilePickerMatch[] {
  if (limit <= 0) return [];

  const query = normalizeSearchQuery(rawQuery, {
    trimLeadingPattern: /^[@./]+/,
  }).replaceAll(/\s/g, "");
  const matches: ProjectFilePickerMatch[] = [];

  for (const entry of entries) {
    if (entry.kind !== "file") continue;

    const name = fileName(entry.path);
    const nameMatchIndices = findMatchIndices(name, query);
    const pathMatchIndices = findMatchIndices(entry.path, query);
    matches.push({
      name,
      nameMatchIndices: nameMatchIndices ?? [],
      path: entry.path,
      pathMatchIndices: pathMatchIndices ?? [],
    });
    if (matches.length >= limit) break;
  }

  return matches;
}

/** A ⌘P row as VS Code shows it: the file name, then its folder. */
export interface FilePickerRow {
  readonly path: string;
  readonly name: string;
  readonly nameMatchIndices: ReadonlyArray<number>;
  readonly folder: string;
  readonly folderMatchIndices: ReadonlyArray<number>;
}

export interface FilePickerRows {
  /** Recently opened files that match, VS Code's "recently opened" group. */
  readonly recent: ReadonlyArray<FilePickerRow>;
  /** The rest of the matches, in the server's (VS Code) order. */
  readonly files: ReadonlyArray<FilePickerRow>;
}

function pickerItem(path: string): ScorableItem {
  const slash = path.lastIndexOf("/");
  return {
    label: path.slice(slash + 1),
    description: slash < 0 ? undefined : path.slice(0, slash),
  };
}

function matchIndices(matches: ReadonlyArray<FuzzyMatch> | undefined): number[] {
  return (matches ?? []).flatMap((match) =>
    Array.from({ length: match.end - match.start }, (_, offset) => match.start + offset),
  );
}

function pickerRow(path: string, item: ScorableItem, score: ItemScore | null): FilePickerRow {
  return {
    path,
    name: item.label,
    nameMatchIndices: matchIndices(score?.labelMatch),
    folder: item.description ?? "",
    folderMatchIndices: matchIndices(score?.descriptionMatch),
  };
}

/**
 * VS Code's ⌘P list: recently opened files that match come first, ordered by
 * VS Code's scorer (newest first with no query), then every other match.
 */
export function buildFilePickerRows(input: {
  readonly query: string;
  readonly recentPaths: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly limit?: number;
}): FilePickerRows {
  const limit = input.limit ?? PROJECT_FILE_PICKER_RESULT_LIMIT;
  const trimmed = input.query.trim();
  const query = trimmed ? prepareQuery(trimmed) : null;
  const scoreOf = (item: ScorableItem) => (query ? scoreItemFuzzy(item, query, true) : null);

  const recentScored = input.recentPaths.flatMap((path) => {
    const item = pickerItem(path);
    const score = scoreOf(item);
    return score && score.score === 0 ? [] : [{ path, item, score }];
  });
  if (query) {
    recentScored.sort((left, right) =>
      compareItemsByFuzzyScore(left.item, right.item, left.score!, right.score!, query),
    );
  }
  const recent = recentScored
    .slice(0, limit)
    .map(({ path, item, score }) => pickerRow(path, item, score));
  const shown = new Set(recent.map((row) => row.path));
  const files = input.entries
    .filter((entry) => entry.kind === "file" && !shown.has(entry.path))
    .slice(0, Math.max(0, limit - recent.length))
    .map((entry) => {
      const item = pickerItem(entry.path);
      return pickerRow(entry.path, item, scoreOf(item));
    });
  return { recent, files };
}
