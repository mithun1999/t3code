import { describe, expect, it } from "vite-plus/test";

import {
  buildSearchRegExp,
  compileSearchPathFilter,
  expandReplacement,
  previewReplacement,
  replaceSelectedMatches,
  type SearchPattern,
} from "./searchReplace";

const pattern = (query: string, options: Partial<SearchPattern> = {}): SearchPattern => ({
  query,
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  ...options,
});

const execAt = (source: string, flags: string, text: string) => {
  const match = new RegExp(source, flags).exec(text);
  if (!match) throw new Error("no match");
  return match;
};

describe("compileSearchPathFilter", () => {
  it("is null without patterns", () => {
    expect(compileSearchPathFilter("", " , ")).toBeNull();
  });

  it("matches VS Code include patterns in any folder unless anchored", () => {
    const filter = compileSearchPathFilter("*.ts, src/components", "")!;
    expect(filter("index.ts")).toBe(true);
    expect(filter("repo-a/src/app.ts")).toBe(true);
    expect(filter("repo-a/src/components/Button.tsx")).toBe(true);
    expect(filter("repo-a/README.md")).toBe(false);

    const anchored = compileSearchPathFilter("./src", "")!;
    expect(anchored("src/app.js")).toBe(true);
    expect(anchored("repo-a/src/app.js")).toBe(false);
  });

  it("excludes folders, braces and double stars", () => {
    const filter = compileSearchPathFilter("", "node_modules, **/*.{test,spec}.ts")!;
    expect(filter("node_modules/react/index.js")).toBe(false);
    expect(filter("repo-a/node_modules/x.js")).toBe(false);
    expect(filter("src/app.test.ts")).toBe(false);
    expect(filter("src/app.spec.ts")).toBe(false);
    expect(filter("src/app.ts")).toBe(true);
  });
});

describe("buildSearchRegExp", () => {
  it("escapes literal queries and honours case", () => {
    const literal = buildSearchRegExp(pattern("a.b(c)"))!;
    expect("xa.b(c)".match(literal)?.[0]).toBe("a.b(c)");
    expect("aXb(c)".match(literal)).toBeNull();
    expect("FOO".match(buildSearchRegExp(pattern("foo"))!)).not.toBeNull();
    expect("FOO".match(buildSearchRegExp(pattern("foo", { caseSensitive: true }))!)).toBeNull();
  });

  it("is null for a regex that does not compile", () => {
    expect(buildSearchRegExp(pattern("(", { useRegex: true }))).toBeNull();
  });
});

describe("expandReplacement", () => {
  it("keeps the text literal without regex", () => {
    expect(expandReplacement("$1 \\n", execAt("(a)", "", "a"), false)).toBe("$1 \\n");
  });

  it("expands groups, escapes and case operators", () => {
    const match = execAt("(?<first>\\w+) (\\w+)", "", "hello world");
    expect(expandReplacement("$2 $1 $$ $& $<first>", match, true)).toBe(
      "world hello $ hello world hello",
    );
    expect(expandReplacement("a\\nb\\tc\\\\", match, true)).toBe("a\nb\tc\\");
    expect(expandReplacement("\\u$1 \\U$2\\E!", match, true)).toBe("Hello WORLD!");
    expect(expandReplacement("$12", match, true)).toBe("hello2");
  });
});

describe("previewReplacement", () => {
  it("previews the match at an offset", () => {
    expect(
      previewReplacement(
        "const a = 1; const b = 2;",
        13,
        pattern("const (\\w)", { useRegex: true }),
        "let $1",
      ),
    ).toEqual({ matched: "const b", replacement: "let b" });
    expect(previewReplacement("foo", 1, pattern("foo"), "bar")).toBeNull();
  });
});

describe("replaceSelectedMatches", () => {
  it("replaces only the selected matches and keeps line endings", () => {
    const text = "foo foo\r\nbar foo\nfoo\n";
    const result = replaceSelectedMatches(
      text,
      pattern("foo"),
      "baz",
      new Map([
        [1, new Set([4])],
        [2, new Set([4])],
      ]),
    );
    expect(result).toEqual({ text: "foo baz\r\nbar baz\nfoo\n", replaced: 2, skipped: 0 });
  });

  it("respects whole words and skips matches that moved", () => {
    const result = replaceSelectedMatches(
      "cat concat cat",
      pattern("cat", { wholeWord: true }),
      "dog",
      new Map([[1, new Set([0, 7, 11, 3])]]),
    );
    expect(result).toEqual({ text: "dog concat dog", replaced: 2, skipped: 2 });
  });

  it("uses capture groups in regex mode", () => {
    const result = replaceSelectedMatches(
      "import a from 'a';",
      pattern("from '(\\w+)'", { useRegex: true }),
      'from "./$1"',
      new Map([[1, new Set([9])]]),
    );
    expect(result.text).toBe('import a from "./a";');
  });
});
