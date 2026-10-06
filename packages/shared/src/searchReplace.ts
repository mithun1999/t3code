/**
 * VS Code's Search view semantics, shared by the server (which searches and
 * replaces) and the client (which previews replacements): file include and
 * exclude globs, the search pattern, whole-word matching and replacement
 * strings with capture groups.
 *
 * Searching runs line by line, so every match lies within one line. Hermes
 * runs this too: no ES2023 array methods.
 */

export interface SearchPattern {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}

export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

// --- Files to include and exclude -----------------------------------------

/** Splits a comma-separated pattern list, keeping commas inside `{a,b}`. */
function splitGlobList(input: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of input) {
    if (character === "{") depth += 1;
    if (character === "}") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      patterns.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  patterns.push(current);
  return patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
}

function escapeRegExpCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character;
}

function globToRegExpSource(glob: string): string {
  let source = "";
  let index = 0;
  let braceDepth = 0;
  while (index < glob.length) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        const atSegmentStart = index === 0 || glob[index - 1] === "/";
        const followedBySlash = glob[index + 2] === "/";
        if (atSegmentStart && followedBySlash) {
          // `**/` matches zero or more folders.
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (character === "," && braceDepth > 0) {
      source += "|";
    } else if (character === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
      } else {
        const body = glob
          .slice(index + 1, close)
          .replace(/^!/, "^")
          .replaceAll("\\", "\\\\");
        source += `[${body}]`;
        index = close;
      }
    } else {
      source += escapeRegExpCharacter(character);
    }
    index += 1;
  }
  return source;
}

/**
 * One VS Code pattern. `./src/app.ts` is anchored at the workspace root;
 * anything else may start in any folder (`*.ts`, `src/components`), and a
 * folder pattern also covers everything inside it.
 */
function compileGlob(pattern: string): RegExp {
  let glob = pattern.replaceAll("\\", "/");
  const anchored = glob.startsWith("./") || glob.startsWith("/");
  glob = glob.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const body = globToRegExpSource(glob);
  const prefix = anchored || glob.startsWith("**") ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${body}(?:/.*)?$`);
}

/**
 * VS Code's "files to include" and "files to exclude": comma-separated globs
 * matched against `/`-separated paths relative to the searched folder. Null
 * when neither filter is set.
 */
export function compileSearchPathFilter(
  includes: string | undefined,
  excludes: string | undefined,
): ((path: string) => boolean) | null {
  const include = splitGlobList(includes ?? "").map(compileGlob);
  const exclude = splitGlobList(excludes ?? "").map(compileGlob);
  if (include.length === 0 && exclude.length === 0) return null;
  return (path) => {
    const normalized = path.replaceAll("\\", "/");
    if (include.length > 0 && !include.some((glob) => glob.test(normalized))) return false;
    return !exclude.some((glob) => glob.test(normalized));
  };
}

// --- Matching -------------------------------------------------------------

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

function codePointAt(line: string, index: number): string | undefined {
  const codePoint = line.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previousCodeUnit = line.charCodeAt(index - 1);
  const previousIndex =
    previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? index - 2 : index - 1;
  return codePointAt(line, previousIndex);
}

/**
 * Matching VS Code, a match edge is a word boundary when it touches the line
 * edge, the neighbouring character is not a word character, or the match's
 * own edge character is not a word character.
 */
export function isWholeWordRange(line: string, range: SearchRange): boolean {
  if (range.end <= range.start) return false;
  const isWord = (character: string | undefined) =>
    character !== undefined && WORD_CHARACTER.test(character);
  const leftIsBoundary =
    range.start === 0 ||
    !isWord(codePointBefore(line, range.start)) ||
    !isWord(codePointAt(line, range.start));
  const rightIsBoundary =
    range.end >= line.length ||
    !isWord(codePointAt(line, range.end)) ||
    !isWord(codePointBefore(line, range.end));
  return leftIsBoundary && rightIsBoundary;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

/** The pattern as a global, per-line JavaScript regex, or null when it doesn't compile. */
export function buildSearchRegExp(pattern: SearchPattern): RegExp | null {
  if (pattern.query.length === 0) return null;
  const source = pattern.useRegex ? pattern.query : escapeRegExp(pattern.query);
  const flags = `gm${pattern.caseSensitive ? "" : "i"}`;
  for (const candidate of [`${flags}u`, flags]) {
    try {
      return new RegExp(source, candidate);
    } catch {
      // Unicode mode rejects some escapes plain mode accepts; try without it.
    }
  }
  return null;
}

/** Every match on one line, as the search reports them. */
export function findLineMatches(
  line: string,
  regex: RegExp,
  wholeWord: boolean,
): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (
      wholeWord &&
      !isWholeWordRange(line, { start: match.index, end: match.index + match[0].length })
    ) {
      continue;
    }
    matches.push(match);
  }
  return matches;
}

// --- Replacing ------------------------------------------------------------

type CaseOperation = "upper" | "lower" | null;

/**
 * VS Code's regex replace string: `$1`, `$&`, `$<name>` and `$$`, the
 * escapes `\n`, `\t` and `\\`, and the case operators `\u` and `\l` (next
 * character) and `\U` and `\L` (until `\E`). Without regex the replacement
 * is literal.
 */
export function expandReplacement(
  replacement: string,
  match: RegExpExecArray,
  useRegex: boolean,
): string {
  if (!useRegex) return replacement;
  let output = "";
  let span: CaseOperation = null;
  let next: CaseOperation = null;
  const append = (text: string) => {
    for (const character of text) {
      const operation = next ?? span;
      next = null;
      output +=
        operation === "upper"
          ? character.toUpperCase()
          : operation === "lower"
            ? character.toLowerCase()
            : character;
    }
  };
  let index = 0;
  while (index < replacement.length) {
    const character = replacement[index]!;
    const following = replacement[index + 1];
    if (character === "\\" && following !== undefined) {
      index += 2;
      if (following === "n") append("\n");
      else if (following === "t") append("\t");
      else if (following === "\\") append("\\");
      else if (following === "u") next = "upper";
      else if (following === "l") next = "lower";
      else if (following === "U") span = "upper";
      else if (following === "L") span = "lower";
      else if (following === "E") span = null;
      else append(`\\${following}`);
      continue;
    }
    if (character === "$" && following !== undefined) {
      if (following === "$") {
        append("$");
        index += 2;
        continue;
      }
      if (following === "&") {
        append(match[0]);
        index += 2;
        continue;
      }
      if (following === "<") {
        const close = replacement.indexOf(">", index + 2);
        const name = close === -1 ? "" : replacement.slice(index + 2, close);
        if (name && match.groups && name in match.groups) {
          append(match.groups[name] ?? "");
          index = close + 1;
          continue;
        }
      }
      const digits = /^\d{1,2}/.exec(replacement.slice(index + 1))?.[0];
      if (digits) {
        // `$12` is group 12 when it exists, else group 1 then a literal 2.
        const twoDigit = digits.length === 2 ? Number(digits) : Number.NaN;
        const group = twoDigit < match.length ? twoDigit : Number(digits[0]);
        if (group < match.length) {
          append(match[group] ?? "");
          index += 1 + String(group).length;
          continue;
        }
      }
    }
    append(character);
    index += 1;
  }
  return output;
}

/** What the match starting at `start` would become, for previews. */
export function previewReplacement(
  line: string,
  start: number,
  pattern: SearchPattern,
  replacement: string,
): { readonly matched: string; readonly replacement: string } | null {
  const regex = buildSearchRegExp(pattern);
  if (!regex) return null;
  const match = findLineMatches(line, regex, pattern.wholeWord).find(
    (candidate) => candidate.index === start,
  );
  return match
    ? { matched: match[0], replacement: expandReplacement(replacement, match, pattern.useRegex) }
    : null;
}

/**
 * Replaces the chosen matches in a file's text: `selection` maps 1-based line
 * numbers to the start offsets of the matches to replace on that line.
 * Matches that no longer start where the search saw them are left alone and
 * counted as skipped. Line endings are kept.
 */
export function replaceSelectedMatches(
  text: string,
  pattern: SearchPattern,
  replacement: string,
  selection: ReadonlyMap<number, ReadonlySet<number>>,
): { readonly text: string; readonly replaced: number; readonly skipped: number } {
  const regex = buildSearchRegExp(pattern);
  let wanted = 0;
  for (const starts of selection.values()) wanted += starts.size;
  if (!regex) return { text, replaced: 0, skipped: wanted };
  const lines = text.split("\n");
  let replaced = 0;
  for (const [lineNumber, starts] of selection) {
    const raw = lines[lineNumber - 1];
    if (raw === undefined) continue;
    const carriageReturn = raw.endsWith("\r");
    const line = carriageReturn ? raw.slice(0, -1) : raw;
    let rebuilt = "";
    let cursor = 0;
    for (const match of findLineMatches(line, regex, pattern.wholeWord)) {
      if (!starts.has(match.index)) continue;
      rebuilt += line.slice(cursor, match.index);
      rebuilt += expandReplacement(replacement, match, pattern.useRegex);
      cursor = match.index + match[0].length;
      replaced += 1;
    }
    if (cursor === 0) continue;
    lines[lineNumber - 1] = `${rebuilt}${line.slice(cursor)}${carriageReturn ? "\r" : ""}`;
  }
  return { text: replaced === 0 ? text : lines.join("\n"), replaced, skipped: wanted - replaced };
}
