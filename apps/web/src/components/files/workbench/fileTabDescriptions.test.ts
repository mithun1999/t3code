import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { fileTabDescriptions } from "./fileTabDescriptions";

function file(relativePath: string, root?: string): RightPanelSurface {
  return {
    id: `file:${root ? `${root}::` : ""}${relativePath}`,
    kind: "file",
    relativePath,
    ...(root ? { root } : {}),
    revealLine: null,
    revealRequestId: 0,
  };
}

describe("fileTabDescriptions", () => {
  it("names the repo when the same file is open from two repos", () => {
    const tabs = [
      file("hello.py", "/work/repo-a"),
      file("hello.py", "/work/repo-b"),
      file("go.mod"),
    ];
    expect(Object.fromEntries(fileTabDescriptions(tabs))).toEqual({
      "file:/work/repo-a::hello.py": "repo-a",
      "file:/work/repo-b::hello.py": "repo-b",
    });
  });

  it("uses the shortest folder path that tells them apart", () => {
    const tabs = [file("src/app/index.ts"), file("src/lib/index.ts"), file("test/lib/index.ts")];
    expect(Object.fromEntries(fileTabDescriptions(tabs))).toEqual({
      "file:src/app/index.ts": "app",
      "file:src/lib/index.ts": "src/lib",
      "file:test/lib/index.ts": "test/lib",
    });
  });

  it("leaves a file at the top level without a description", () => {
    const tabs = [file("index.ts"), file("src/index.ts")];
    expect(Object.fromEntries(fileTabDescriptions(tabs))).toEqual({
      "file:src/index.ts": "src",
    });
  });
});
