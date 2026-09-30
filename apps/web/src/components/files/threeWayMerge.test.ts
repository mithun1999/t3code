import { describe, expect, it } from "vite-plus/test";

import { mergeThreeWay } from "./threeWayMerge";

const base = [
  "import a;",
  "",
  "function one() {}",
  "",
  "function two() {}",
  "",
  "export {};",
  "",
].join("\n");

describe("mergeThreeWay", () => {
  it("keeps edits both sides made to different lines", () => {
    const ours = base.replace("function one() {}", "function one() { return 1; }");
    const theirs = base.replace("export {};", "export { one, two };");
    expect(mergeThreeWay(base, ours, theirs)).toEqual({
      clean: true,
      merged: ours.replace("export {};", "export { one, two };"),
    });
  });

  it("keeps an insertion on one side and a deletion on the other", () => {
    const ours = base.replace("import a;\n", "import a;\nimport b;\n");
    const theirs = base.replace("function two() {}\n\n", "");
    expect(mergeThreeWay(base, ours, theirs).merged).toBe(
      ours.replace("function two() {}\n\n", ""),
    );
  });

  it("takes an identical edit once", () => {
    const edited = base.replace("function two() {}", "function two() { return 2; }");
    expect(mergeThreeWay(base, edited, edited)).toEqual({ clean: true, merged: edited });
  });

  it("reports a conflict when both sides change the same line, keeping ours", () => {
    const ours = base.replace("function one() {}", "function one() { return 1; }");
    const theirs = base.replace("function one() {}", "function one() { return 'one'; }");
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ clean: false, merged: ours });
  });

  it("treats edits to adjacent lines as a conflict, as git does", () => {
    const ours = base.replace("import a;\n", "import alpha;\n");
    const theirs = base.replace("import a;\n\n", "import a;\n// note\n");
    expect(mergeThreeWay(base, ours, theirs).clean).toBe(false);
  });

  it("short-circuits when only one side changed", () => {
    const edited = `${base}more\n`;
    expect(mergeThreeWay(base, base, edited)).toEqual({ clean: true, merged: edited });
    expect(mergeThreeWay(base, edited, base)).toEqual({ clean: true, merged: edited });
  });

  it("handles a missing trailing newline and CRLF lines", () => {
    const crlfBase = "a\r\nb\r\nc\r\nd";
    const ours = "A\r\nb\r\nc\r\nd";
    const theirs = "a\r\nb\r\nc\r\nD";
    expect(mergeThreeWay(crlfBase, ours, theirs)).toEqual({
      clean: true,
      merged: "A\r\nb\r\nc\r\nD",
    });
  });
});
