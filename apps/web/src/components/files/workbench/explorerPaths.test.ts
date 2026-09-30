import { describe, expect, it } from "vite-plus/test";

import {
  duplicateName,
  isSelfOrDescendant,
  NEW_ENTRY_PLACEHOLDER,
  parentTreePath,
  resolveTreePath,
  treePathFor,
  typedEntryName,
} from "./explorerPaths";

const labels = [
  { label: "web/app", root: "/repos/web/app" },
  { label: "api", root: "/repos/api" },
];

describe("resolveTreePath", () => {
  it("maps a single-repo tree path to the workspace root", () => {
    expect(resolveTreePath("src/index.ts", { cwd: "/repo", labels: null })).toEqual({
      root: "/repo",
      relativePath: "src/index.ts",
    });
    expect(resolveTreePath("src/", { cwd: "/repo", labels: null })).toEqual({
      root: "/repo",
      relativePath: "src",
    });
  });

  it("maps a multi-repo tree path to its repo, a bare label to the repo itself", () => {
    const input = { cwd: "/repos", labels };
    expect(resolveTreePath("web/app/src/a.ts", input)).toEqual({
      root: "/repos/web/app",
      relativePath: "src/a.ts",
    });
    expect(resolveTreePath("api/", input)).toEqual({ root: "/repos/api", relativePath: "" });
    expect(resolveTreePath("web", input)).toBeNull();
  });

  it("round-trips through treePathFor", () => {
    expect(treePathFor({ root: "/repos/api", relativePath: "main.py" }, labels)).toBe(
      "api/main.py",
    );
    expect(treePathFor({ root: "/repos/api", relativePath: "" }, labels)).toBe("api");
    expect(treePathFor({ root: "/elsewhere", relativePath: "x" }, labels)).toBeNull();
    expect(treePathFor({ root: "/repo", relativePath: "x/y" }, null)).toBe("x/y");
  });
});

describe("new entry names", () => {
  it("strips the invisible placeholder the name was typed over", () => {
    expect(typedEntryName(`src/${NEW_ENTRY_PLACEHOLDER}`)).toBe("");
    expect(typedEntryName(`src/${NEW_ENTRY_PLACEHOLDER}index.ts`)).toBe("index.ts");
    expect(typedEntryName("src/index.ts")).toBe("index.ts");
    expect(parentTreePath(`src/${NEW_ENTRY_PLACEHOLDER}/`)).toBe("src");
  });
});

describe("duplicateName", () => {
  it("names copies as VS Code does", () => {
    expect(duplicateName("index.ts", () => false)).toBe("index copy.ts");
    const taken = new Set(["index copy.ts", "index copy 2.ts"]);
    expect(duplicateName("index.ts", (name) => taken.has(name))).toBe("index copy 3.ts");
    expect(duplicateName("Makefile", () => false)).toBe("Makefile copy");
    expect(duplicateName(".env", () => false)).toBe(".env copy");
  });
});

describe("isSelfOrDescendant", () => {
  it("refuses to move a folder into itself", () => {
    expect(isSelfOrDescendant("src/", "src")).toBe(true);
    expect(isSelfOrDescendant("src", "src/lib")).toBe(true);
    expect(isSelfOrDescendant("src", "srcs")).toBe(false);
    expect(isSelfOrDescendant("src/a.ts", "lib")).toBe(false);
  });
});
