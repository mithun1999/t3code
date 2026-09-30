/**
 * VS Code's quick-open fuzzy scorer, so ⌘P ranks files the way VS Code does.
 *
 * Ported from microsoft/vscode `src/vs/base/common/fuzzyScorer.ts` and the
 * helpers it uses (`filters.ts`, `comparers.ts`, `quickInput.ts`), MIT licensed:
 * Copyright (c) Microsoft Corporation. Paths use "/" on every platform here.
 */

// Scoring

/** A score and the matched character positions in the target. */
export type FuzzyScore = readonly [score: number, positions: readonly number[]];

const NO_MATCH = 0;
const NO_SCORE: FuzzyScore = [NO_MATCH, []];

export function scoreFuzzy(
  target: string,
  query: string,
  queryLower: string,
  allowNonContiguousMatches: boolean,
): FuzzyScore {
  if (!target || !query) return NO_SCORE;
  const targetLength = target.length;
  const queryLength = query.length;
  if (targetLength < queryLength) return NO_SCORE;
  const targetLower = target.toLowerCase();
  return doScoreFuzzy(
    query,
    queryLower,
    queryLength,
    target,
    targetLower,
    targetLength,
    allowNonContiguousMatches,
  );
}

function doScoreFuzzy(
  query: string,
  queryLower: string,
  queryLength: number,
  target: string,
  targetLower: string,
  targetLength: number,
  allowNonContiguousMatches: boolean,
): FuzzyScore {
  const scores: number[] = [];
  const matches: number[] = [];

  // Build the scorer matrix: rows are query characters, columns target characters.
  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const queryIndexOffset = queryIndex * targetLength;
    const queryIndexPreviousOffset = queryIndexOffset - targetLength;
    const queryIndexGtNull = queryIndex > 0;
    const queryCharAtIndex = query[queryIndex]!;
    const queryLowerCharAtIndex = queryLower[queryIndex]!;

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const targetIndexGtNull = targetIndex > 0;
      const currentIndex = queryIndexOffset + targetIndex;
      const leftIndex = currentIndex - 1;
      const diagIndex = queryIndexPreviousOffset + targetIndex - 1;

      const leftScore = targetIndexGtNull ? scores[leftIndex]! : 0;
      const diagScore = queryIndexGtNull && targetIndexGtNull ? scores[diagIndex]! : 0;
      const matchesSequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[diagIndex]! : 0;

      // Past the first query character, only score when the previous query
      // character scored too, so the query always matches in order.
      const score =
        !diagScore && queryIndexGtNull
          ? 0
          : computeCharScore(
              queryCharAtIndex,
              queryLowerCharAtIndex,
              target,
              targetLower,
              targetIndex,
              matchesSequenceLength,
            );

      const isValidScore = score && diagScore + score >= leftScore;
      if (
        isValidScore &&
        (allowNonContiguousMatches ||
          queryIndexGtNull ||
          targetLower.startsWith(queryLower, targetIndex))
      ) {
        // Match: the sequence grows from the diagonal.
        matches[currentIndex] = matchesSequenceLength + 1;
        scores[currentIndex] = diagScore + score;
      } else {
        // No match: carry the left score over.
        matches[currentIndex] = NO_MATCH;
        scores[currentIndex] = leftScore;
      }
    }
  }

  // Walk back from the bottom right to recover the matched positions.
  const positions: number[] = [];
  let queryIndex = queryLength - 1;
  let targetIndex = targetLength - 1;
  while (queryIndex >= 0 && targetIndex >= 0) {
    const currentIndex = queryIndex * targetLength + targetIndex;
    if (matches[currentIndex] === NO_MATCH) {
      targetIndex--;
    } else {
      // At most one position per query character, so unshift stays cheap.
      positions.unshift(targetIndex);
      queryIndex--;
      targetIndex--;
    }
  }

  return [scores[queryLength * targetLength - 1]!, positions];
}

function computeCharScore(
  queryCharAtIndex: string,
  queryLowerCharAtIndex: string,
  target: string,
  targetLower: string,
  targetIndex: number,
  matchesSequenceLength: number,
): number {
  if (!considerAsEqual(queryLowerCharAtIndex, targetLower[targetIndex]!)) return 0;

  // Character match.
  let score = 1;
  // Consecutive match.
  if (matchesSequenceLength > 0) score += matchesSequenceLength * 5;
  // Same case.
  if (queryCharAtIndex === target[targetIndex]) score += 1;

  if (targetIndex === 0) {
    // Start of the target.
    score += 8;
  } else {
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus) {
      // After a separator.
      score += separatorBonus;
    } else if (isUpper(target.charCodeAt(targetIndex)) && matchesSequenceLength === 0) {
      // An upper-case letter inside a word (camelCase), outside a run: NPE → NullPointerException.
      score += 2;
    }
  }
  return score;
}

function considerAsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  // Path separators match regardless of platform.
  if (a === "/" || a === "\\") return b === "/" || b === "\\";
  return false;
}

function scoreSeparatorAtPos(charCode: number): number {
  switch (charCode) {
    case 47: // "/"
    case 92: // "\\"
      // Path separators score above other separators.
      return 5;
    case 95: // "_"
    case 45: // "-"
    case 46: // "."
    case 32: // " "
    case 39: // "'"
    case 34: // '"'
    case 58: // ":"
      return 4;
    default:
      return 0;
  }
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

// Items: a label (file name), a description (its folder) and a path

export interface FuzzyMatch {
  readonly start: number;
  readonly end: number;
}

export interface ItemScore {
  /** 0 when the item doesn't match. */
  readonly score: number;
  readonly labelMatch?: readonly FuzzyMatch[];
  readonly descriptionMatch?: readonly FuzzyMatch[];
}

export interface ScorableItem {
  /** What the item is called, e.g. the file name. */
  readonly label: string;
  /** Where it is, e.g. the folder path. */
  readonly description?: string | undefined;
  /** Its full path, for exact-path matches. */
  readonly path?: string | undefined;
}

const NO_ITEM_SCORE: ItemScore = { score: 0 };
const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;

interface PreparedQueryPiece {
  readonly original: string;
  readonly originalLowercase: string;
  readonly pathNormalized: string;
  readonly normalized: string;
  readonly normalizedLowercase: string;
  /** The piece was typed in quotes, so it must match contiguously. */
  readonly expectContiguousMatch: boolean;
}

export interface PreparedQuery extends PreparedQueryPiece {
  /** The space-separated pieces, when there are several; each must match. */
  readonly values: readonly PreparedQueryPiece[] | undefined;
  readonly containsPathSeparator: boolean;
}

function normalizeQuery(original: string) {
  // Accept "\\" as a path separator too.
  const pathNormalized = original.replaceAll("\\", "/");
  // Quotes mark exact matches, "*" is a wildcard and whitespace separates
  // pieces; none of them take part in matching.
  const normalized = pathNormalized.replaceAll("*", "").replace(/\s|"/g, "");
  return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
}

function queryExpectsExactMatch(query: string): boolean {
  return query.length > 1 && query.startsWith('"') && query.endsWith('"');
}

export function prepareQuery(original: string): PreparedQuery {
  const { pathNormalized, normalized, normalizedLowercase } = normalizeQuery(original);
  let values: PreparedQueryPiece[] | undefined;
  const pieces = original.split(" ");
  if (pieces.length > 1) {
    for (const piece of pieces) {
      const normalizedPiece = normalizeQuery(piece);
      if (!normalizedPiece.normalized) continue;
      values ??= [];
      values.push({
        original: piece,
        originalLowercase: piece.toLowerCase(),
        ...normalizedPiece,
        expectContiguousMatch: queryExpectsExactMatch(piece),
      });
    }
  }
  return {
    original,
    originalLowercase: original.toLowerCase(),
    pathNormalized,
    normalized,
    normalizedLowercase,
    values,
    containsPathSeparator: pathNormalized.includes("/"),
    expectContiguousMatch: queryExpectsExactMatch(original),
  };
}

export function scoreItemFuzzy(
  item: ScorableItem,
  query: PreparedQuery,
  allowNonContiguousMatches: boolean,
): ItemScore {
  if (!item.label || !query.normalized) return NO_ITEM_SCORE;
  // A query with a path separator is about the path, not just the name.
  const preferLabelMatches = !item.path || !query.containsPathSeparator;

  // The exact full path is the best match there is.
  if (item.path && query.pathNormalized.toLowerCase() === item.path.toLowerCase()) {
    return {
      score: PATH_IDENTITY_SCORE,
      labelMatch: [{ start: 0, end: item.label.length }],
      ...(item.description
        ? { descriptionMatch: [{ start: 0, end: item.description.length }] }
        : {}),
    };
  }

  if (query.values && query.values.length > 1) {
    return scoreItemFuzzyMultiple(
      item,
      query.values,
      preferLabelMatches,
      allowNonContiguousMatches,
    );
  }
  return scoreItemFuzzySingle(item, query, preferLabelMatches, allowNonContiguousMatches);
}

function scoreItemFuzzyMultiple(
  item: ScorableItem,
  pieces: readonly PreparedQueryPiece[],
  preferLabelMatches: boolean,
  allowNonContiguousMatches: boolean,
): ItemScore {
  let totalScore = 0;
  const labelMatches: FuzzyMatch[] = [];
  const descriptionMatches: FuzzyMatch[] = [];
  for (const piece of pieces) {
    const { score, labelMatch, descriptionMatch } = scoreItemFuzzySingle(
      item,
      piece,
      preferLabelMatches,
      allowNonContiguousMatches,
    );
    // Every piece must match.
    if (score === NO_MATCH) return NO_ITEM_SCORE;
    totalScore += score;
    if (labelMatch) labelMatches.push(...labelMatch);
    if (descriptionMatch) descriptionMatches.push(...descriptionMatch);
  }
  return {
    score: totalScore,
    labelMatch: normalizeMatches(labelMatches),
    descriptionMatch: normalizeMatches(descriptionMatches),
  };
}

function scoreItemFuzzySingle(
  item: ScorableItem,
  query: PreparedQueryPiece,
  preferLabelMatches: boolean,
  allowNonContiguousMatches: boolean,
): ItemScore {
  const { label, description, path } = item;
  const nonContiguous = allowNonContiguousMatches && !query.expectContiguousMatch;

  if (preferLabelMatches || !description) {
    const [labelScore, labelPositions] = scoreFuzzy(
      label,
      query.normalized,
      query.normalizedLowercase,
      nonContiguous,
    );
    if (labelScore) {
      // A name that starts with the query beats one that merely contains it,
      // and a shorter such name beats a longer one ("window.ts" before
      // "windowActions.ts" for "window").
      const labelPrefixMatch = label.toLowerCase().startsWith(query.normalizedLowercase);
      const baseScore = labelPrefixMatch
        ? LABEL_PREFIX_SCORE_THRESHOLD + Math.round((query.normalized.length / label.length) * 100)
        : LABEL_SCORE_THRESHOLD;
      return {
        score: baseScore + labelScore,
        labelMatch: labelPrefixMatch
          ? [{ start: 0, end: query.normalized.length }]
          : createMatches(labelPositions),
      };
    }
  }

  if (description) {
    const descriptionPrefix = path ? `${description}/` : description;
    const descriptionPrefixLength = descriptionPrefix.length;
    const [score, positions] = scoreFuzzy(
      `${descriptionPrefix}${label}`,
      query.normalized,
      query.normalizedLowercase,
      nonContiguous,
    );
    if (score) {
      const labelMatch: FuzzyMatch[] = [];
      const descriptionMatch: FuzzyMatch[] = [];
      // Split the matches back onto the description and the label.
      for (const match of createMatches(positions)) {
        if (match.start < descriptionPrefixLength && match.end > descriptionPrefixLength) {
          labelMatch.push({ start: 0, end: match.end - descriptionPrefixLength });
          descriptionMatch.push({ start: match.start, end: descriptionPrefixLength });
        } else if (match.start >= descriptionPrefixLength) {
          labelMatch.push({
            start: match.start - descriptionPrefixLength,
            end: match.end - descriptionPrefixLength,
          });
        } else {
          descriptionMatch.push(match);
        }
      }
      return { score, labelMatch, descriptionMatch };
    }
  }

  return NO_ITEM_SCORE;
}

function createMatches(positions: readonly number[]): FuzzyMatch[] {
  const matches: Array<{ start: number; end: number }> = [];
  let last: { start: number; end: number } | undefined;
  for (const position of positions) {
    if (last && last.end === position) {
      last.end += 1;
    } else {
      last = { start: position, end: position + 1 };
      matches.push(last);
    }
  }
  return matches;
}

function normalizeMatches(matches: readonly FuzzyMatch[]): FuzzyMatch[] {
  const sorted = [...matches].sort((left, right) => left.start - right.start);
  const normalized: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | undefined;
  for (const match of sorted) {
    // Merge overlapping or touching matches.
    if (!current || !(current.end >= match.start && current.start <= match.end)) {
      current = { start: match.start, end: match.end };
      normalized.push(current);
    } else {
      current.start = Math.min(current.start, match.start);
      current.end = Math.max(current.end, match.end);
    }
  }
  return normalized;
}

// Ordering

/**
 * Orders two matching items as VS Code's quick open does: an exact path first,
 * then name matches (prefix matches, then shorter and more compact ones),
 * then by score, then by how compact the match is, then by length and name.
 */
export function compareItemsByFuzzyScore(
  itemA: ScorableItem,
  itemB: ScorableItem,
  scoreA: ItemScore,
  scoreB: ItemScore,
  query: PreparedQuery,
): number {
  const a = scoreA.score;
  const b = scoreB.score;

  // 1. Exact path matches come first.
  if ((a === PATH_IDENTITY_SCORE || b === PATH_IDENTITY_SCORE) && a !== b) {
    return a === PATH_IDENTITY_SCORE ? -1 : 1;
  }

  // 2. Matches on the name beat matches that need the folder too.
  if (a > LABEL_SCORE_THRESHOLD || b > LABEL_SCORE_THRESHOLD) {
    if (a !== b) return a > b ? -1 : 1;
    // Prefer compact matches in the name, unless both are prefix matches.
    if (a < LABEL_PREFIX_SCORE_THRESHOLD && b < LABEL_PREFIX_SCORE_THRESHOLD) {
      const byLength = compareByMatchLength(scoreA.labelMatch, scoreB.labelMatch);
      if (byLength !== 0) return byLength;
    }
    // Prefer shorter names.
    if (itemA.label.length !== itemB.label.length) {
      return itemA.label.length - itemB.label.length;
    }
  }

  // 3. By score.
  if (a !== b) return a > b ? -1 : 1;

  // 4. Same score: a match in the name beats one only in the folder.
  const aHasLabelMatches = (scoreA.labelMatch?.length ?? 0) > 0;
  const bHasLabelMatches = (scoreB.labelMatch?.length ?? 0) > 0;
  if (aHasLabelMatches && !bHasLabelMatches) return -1;
  if (bHasLabelMatches && !aHasLabelMatches) return 1;

  // 5. Same score: prefer the more compact match across folder and name.
  const aDistance = matchDistance(itemA, scoreA);
  const bDistance = matchDistance(itemB, scoreB);
  if (aDistance && bDistance && aDistance !== bDistance) return bDistance > aDistance ? -1 : 1;

  // 6. Fall back to lengths and names.
  return fallbackCompare(itemA, itemB, query);
}

function matchDistance(item: ScorableItem, score: ItemScore): number {
  let matchStart = -1;
  let matchEnd = -1;
  if (score.descriptionMatch?.length) {
    matchStart = score.descriptionMatch[0]!.start;
  } else if (score.labelMatch?.length) {
    matchStart = score.labelMatch[0]!.start;
  }
  if (score.labelMatch?.length) {
    matchEnd = score.labelMatch[score.labelMatch.length - 1]!.end;
    if (score.descriptionMatch?.length && item.description) {
      matchEnd += item.description.length;
    }
  } else if (score.descriptionMatch?.length) {
    matchEnd = score.descriptionMatch[score.descriptionMatch.length - 1]!.end;
  }
  return matchEnd - matchStart;
}

function compareByMatchLength(
  matchesA: readonly FuzzyMatch[] | undefined,
  matchesB: readonly FuzzyMatch[] | undefined,
): number {
  if (!matchesA?.length && !matchesB?.length) return 0;
  if (!matchesB?.length) return -1;
  if (!matchesA?.length) return 1;
  const lengthA = matchesA[matchesA.length - 1]!.end - matchesA[0]!.start;
  const lengthB = matchesB[matchesB.length - 1]!.end - matchesB[0]!.start;
  return lengthA === lengthB ? 0 : lengthB < lengthA ? 1 : -1;
}

function fallbackCompare(itemA: ScorableItem, itemB: ScorableItem, query: PreparedQuery): number {
  const labelA = itemA.label;
  const labelB = itemB.label;
  const descriptionA = itemA.description;
  const descriptionB = itemB.description;
  // Shorter name and folder together first.
  const lengthA = labelA.length + (descriptionA?.length ?? 0);
  const lengthB = labelB.length + (descriptionB?.length ?? 0);
  if (lengthA !== lengthB) return lengthA - lengthB;
  // Then the shorter path.
  const pathA = itemA.path;
  const pathB = itemB.path;
  if (pathA && pathB && pathA.length !== pathB.length) return pathA.length - pathB.length;
  // Then by name, folder and path.
  if (labelA !== labelB) return compareAnything(labelA, labelB, query.normalized);
  if (descriptionA && descriptionB && descriptionA !== descriptionB) {
    return compareAnything(descriptionA, descriptionB, query.normalized);
  }
  if (pathA && pathB && pathA !== pathB) return compareAnything(pathA, pathB, query.normalized);
  return 0;
}

let fileNameCollator: Intl.Collator | undefined;

function compareAnything(one: string, other: string, lookFor: string): number {
  const oneLower = one.toLowerCase();
  const otherLower = other.toLowerCase();
  // Prefix matches first, shorter ones before longer.
  const onePrefix = oneLower.startsWith(lookFor);
  const otherPrefix = otherLower.startsWith(lookFor);
  if (onePrefix !== otherPrefix) return onePrefix ? -1 : 1;
  if (onePrefix && otherPrefix && oneLower.length !== otherLower.length) {
    return oneLower.length < otherLower.length ? -1 : 1;
  }
  // Then suffix matches.
  const oneSuffix = oneLower.endsWith(lookFor);
  const otherSuffix = otherLower.endsWith(lookFor);
  if (oneSuffix !== otherSuffix) return oneSuffix ? -1 : 1;
  // Then as file names, numbers in order.
  fileNameCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const byFileName = fileNameCollator.compare(oneLower, otherLower);
  if (byFileName !== 0) return byFileName;
  return oneLower.localeCompare(otherLower);
}

// "file.ts:42" and friends

export interface QueryLineTarget {
  /** The query without its line suffix. */
  readonly filter: string;
  readonly line: number;
  readonly column?: number;
}

const LINE_COLON_PATTERN = /\s?[#:(](?:line )?(\d*)(?:[#:,](\d*))?\)?:?\s*$/;

/**
 * VS Code's line suffixes on a quick-open query: `file.ts:42`, `file.ts:42:7`,
 * `file.ts#42`, `file.ts(42)` and `file.ts:line 42`. A bare `file.ts:` means
 * line 1.
 */
export function extractLineFromQuery(query: string): QueryLineTarget | null {
  const match = LINE_COLON_PATTERN.exec(query);
  if (!match) return null;
  const line = Number.parseInt(match[1] ?? "", 10);
  const column = Number.parseInt(match[2] ?? "", 10);
  const filter = query.slice(0, match.index);
  if (Number.isFinite(line)) {
    return Number.isFinite(column) ? { filter, line, column } : { filter, line };
  }
  return match[1] === "" ? { filter, line: 1 } : null;
}
