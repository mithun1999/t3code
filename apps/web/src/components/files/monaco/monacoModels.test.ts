import { describe, expect, it } from "vite-plus/test";

import { minimalReplacement } from "./monacoModels";

function apply(current: string, next: string): string {
  const replacement = minimalReplacement(current, next);
  if (!replacement) return current;
  return current.slice(0, replacement.start) + replacement.text + current.slice(replacement.end);
}

describe("minimalReplacement", () => {
  it("returns nothing when the contents match", () => {
    expect(minimalReplacement("same\n", "same\n")).toBeNull();
  });

  it("replaces only the lines an agent changed", () => {
    const current = "import a;\n\nconst x = 1;\nconst y = 2;\n";
    const next = "import a;\n\nconst x = 10;\nconst y = 2;\n";
    expect(minimalReplacement(current, next)).toEqual({ start: 22, end: 22, text: "0" });
    expect(apply(current, next)).toBe(next);
  });

  it("handles insertions, deletions and rewrites at either end", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["abc", "xabc"],
      ["abc", "abcx"],
      ["abc", ""],
      ["", "abc"],
      ["aaaa", "aa"],
      ["line\r\n", "line\r\nnext\r\n"],
      ["one two three", "one 2 three"],
    ];
    for (const [current, next] of cases) expect(apply(current, next)).toBe(next);
  });

  it("does not overlap the shared prefix and suffix on repeated text", () => {
    const replacement = minimalReplacement("aaa", "aaaa");
    expect(replacement).not.toBeNull();
    if (!replacement) return;
    expect(replacement.start).toBeLessThanOrEqual(replacement.end);
    expect(apply("aaa", "aaaa")).toBe("aaaa");
  });
});
