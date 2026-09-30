import { diffArrays } from "diff";

/** A run of base lines, `[baseStart, baseEnd)`, that one side replaced with `lines`. */
interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly lines: readonly string[];
}

export interface ThreeWayMergeResult {
  /** False when both sides changed the same lines differently. */
  readonly clean: boolean;
  /** The merge; where it isn't clean, the conflicting lines keep `ours`. */
  readonly merged: string;
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function hunks(base: readonly string[], side: readonly string[]): Hunk[] {
  const result: Hunk[] = [];
  let baseIndex = 0;
  let current: { baseStart: number; baseEnd: number; lines: string[] } | null = null;
  for (const change of diffArrays([...base], [...side])) {
    if (!change.added && !change.removed) {
      if (current) result.push(current);
      current = null;
      baseIndex += change.count;
      continue;
    }
    current ??= { baseStart: baseIndex, baseEnd: baseIndex, lines: [] };
    if (change.removed) {
      baseIndex += change.count;
      current.baseEnd = baseIndex;
    } else {
      current.lines.push(...change.value);
    }
  }
  if (current) result.push(current);
  return result;
}

/** One side's version of `base[start, end)`, from its hunks inside that range. */
function sideRegion(
  base: readonly string[],
  start: number,
  end: number,
  sideHunks: readonly Hunk[],
): string[] {
  const lines: string[] = [];
  let cursor = start;
  for (const hunk of sideHunks) {
    lines.push(...base.slice(cursor, hunk.baseStart), ...hunk.lines);
    cursor = hunk.baseEnd;
  }
  lines.push(...base.slice(cursor, end));
  return lines;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * Line-based three-way merge (diff3): keeps both sides' edits to `base`.
 * Edits touching the same or adjacent lines conflict unless they agree, as in git.
 */
export function mergeThreeWay(base: string, ours: string, theirs: string): ThreeWayMergeResult {
  if (ours === theirs || theirs === base) return { clean: true, merged: ours };
  if (ours === base) return { clean: true, merged: theirs };
  const baseLines = splitLines(base);
  const ourHunks = hunks(baseLines, splitLines(ours));
  const theirHunks = hunks(baseLines, splitLines(theirs));
  const merged: string[] = [];
  let clean = true;
  let position = 0;
  let ourIndex = 0;
  let theirIndex = 0;
  while (ourIndex < ourHunks.length || theirIndex < theirHunks.length) {
    const start = Math.min(
      ourHunks[ourIndex]?.baseStart ?? Number.POSITIVE_INFINITY,
      theirHunks[theirIndex]?.baseStart ?? Number.POSITIVE_INFINITY,
    );
    let end = start;
    const ourGroup: Hunk[] = [];
    const theirGroup: Hunk[] = [];
    // Grow the region until no hunk on either side starts inside or right after it.
    for (let grew = true; grew;) {
      grew = false;
      for (; ourIndex < ourHunks.length && ourHunks[ourIndex]!.baseStart <= end; ourIndex++) {
        ourGroup.push(ourHunks[ourIndex]!);
        end = Math.max(end, ourHunks[ourIndex]!.baseEnd);
        grew = true;
      }
      for (
        ;
        theirIndex < theirHunks.length && theirHunks[theirIndex]!.baseStart <= end;
        theirIndex++
      ) {
        theirGroup.push(theirHunks[theirIndex]!);
        end = Math.max(end, theirHunks[theirIndex]!.baseEnd);
        grew = true;
      }
    }
    merged.push(...baseLines.slice(position, start));
    const ourRegion = sideRegion(baseLines, start, end, ourGroup);
    if (theirGroup.length === 0) {
      merged.push(...ourRegion);
    } else {
      const theirRegion = sideRegion(baseLines, start, end, theirGroup);
      if (ourGroup.length === 0) merged.push(...theirRegion);
      else {
        if (!sameLines(ourRegion, theirRegion)) clean = false;
        merged.push(...ourRegion);
      }
    }
    position = end;
  }
  merged.push(...baseLines.slice(position));
  return { clean, merged: merged.join("") };
}
