import { describe, expect, it } from "vite-plus/test";

import {
  compareItemsByFuzzyScore,
  extractLineFromQuery,
  prepareQuery,
  scoreFuzzy,
  scoreItemFuzzy,
  type ScorableItem,
} from "./fuzzyScorer.ts";

function fileItem(path: string): ScorableItem {
  const slash = path.lastIndexOf("/");
  return {
    label: path.slice(slash + 1),
    description: slash < 0 ? undefined : path.slice(0, slash),
    path: `/work/${path}`,
  };
}

function rank(paths: readonly string[], query: string): string[] {
  const prepared = prepareQuery(query);
  return paths
    .map((path) => {
      const item = fileItem(path);
      return { path, item, score: scoreItemFuzzy(item, prepared, true) };
    })
    .filter((entry) => entry.score.score > 0)
    .toSorted((left, right) =>
      compareItemsByFuzzyScore(left.item, right.item, left.score, right.score, prepared),
    )
    .map((entry) => entry.path);
}

describe("scoreFuzzy", () => {
  it("matches characters in order, anywhere, but not out of order", () => {
    const target = "HeLlo-World";
    for (const query of ["HelLo-World", "HelloWorld", "hw", "hlw", "hellow"]) {
      expect(scoreFuzzy(target, query, query.toLowerCase(), true)[0]).toBeGreaterThan(0);
    }
    for (const query of ["worldhello", "nope", "wh"]) {
      expect(scoreFuzzy(target, query, query.toLowerCase(), true)[0]).toBe(0);
    }
  });

  it("requires a contiguous run when non-contiguous matches are off", () => {
    expect(scoreFuzzy("HeLlo-World", "hw", "hw", false)[0]).toBe(0);
    expect(scoreFuzzy("HeLlo-World", "lo-w", "lo-w", false)[0]).toBeGreaterThan(0);
  });

  it("reports the matched positions", () => {
    expect(scoreFuzzy("HeLlo-World", "hw", "hw", true)[1]).toEqual([0, 6]);
  });
});

describe("compareItemsByFuzzyScore", () => {
  it("puts file names starting with the query first, shorter ones before longer", () => {
    expect(rank(["src/mywindow.ts", "src/windowActions.ts", "lib/window.ts"], "window")).toEqual([
      "lib/window.ts",
      "src/windowActions.ts",
      "src/mywindow.ts",
    ]);
  });

  it("ranks name matches above matches that need the folder", () => {
    expect(rank(["config/test/t1.js", "config/test.js"], "test")).toEqual([
      "config/test.js",
      "config/test/t1.js",
    ]);
  });

  it("follows the folder when the query has a path separator", () => {
    expect(rank(["lib/app.ts", "src/app.ts", "src/other/app.tsx"], "src/app")).toEqual([
      "src/app.ts",
      "src/other/app.tsx",
    ]);
  });

  it("requires every space-separated piece to match", () => {
    expect(rank(["src/app.test.ts", "src/app.ts", "test/other.ts"], "app test")).toEqual([
      "src/app.test.ts",
    ]);
  });

  it("puts an exact full path first", () => {
    expect(rank(["src/index.ts", "index.ts"], "/work/src/index.ts")[0]).toBe("src/index.ts");
  });
});

describe("extractLineFromQuery", () => {
  it("reads VS Code's line suffixes", () => {
    expect(extractLineFromQuery("app.ts:42")).toEqual({ filter: "app.ts", line: 42 });
    expect(extractLineFromQuery("app.ts:42:7")).toEqual({ filter: "app.ts", line: 42, column: 7 });
    expect(extractLineFromQuery("app.ts#12")).toEqual({ filter: "app.ts", line: 12 });
    expect(extractLineFromQuery("app.ts(3)")).toEqual({ filter: "app.ts", line: 3 });
    expect(extractLineFromQuery("app.ts:")).toEqual({ filter: "app.ts", line: 1 });
    expect(extractLineFromQuery("app.ts")).toBeNull();
  });
});
