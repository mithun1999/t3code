import type { ScmStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { explorerGitStatuses, rootWithinRepo, scmChangeCount } from "./scmPresentation";

function status(overrides: Partial<ScmStatusResult>): ScmStatusResult {
  return {
    isRepo: true,
    repoRoot: "/repo",
    branch: "main",
    hasCommits: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    merge: [],
    staged: [],
    changes: [],
    truncated: false,
    ...overrides,
  };
}

describe("explorerGitStatuses", () => {
  it("shows the working-tree status over the staged one", () => {
    const result = explorerGitStatuses(
      status({
        staged: [
          { path: "src/a.ts", status: "added" },
          { path: "src/b.ts", status: "modified" },
        ],
        changes: [
          { path: "src/a.ts", status: "modified" },
          { path: "notes.md", status: "untracked" },
        ],
      }),
      "/repo",
    );
    expect(Object.fromEntries(result)).toEqual({
      "src/a.ts": "modified",
      "src/b.ts": "modified",
      "notes.md": "untracked",
    });
  });

  it("keeps only changes below a root inside the repo, relative to that root", () => {
    const result = explorerGitStatuses(
      status({
        changes: [
          { path: "packages/app/src/a.ts", status: "modified" },
          { path: "packages/other/b.ts", status: "modified" },
        ],
      }),
      "/repo/packages/app",
    );
    expect(Object.fromEntries(result)).toEqual({ "src/a.ts": "modified" });
  });
});

describe("rootWithinRepo", () => {
  it("finds a root's place inside its repository", () => {
    expect(rootWithinRepo("/repo", "/repo/")).toBe("");
    expect(rootWithinRepo("/repo", "/repo/packages/app")).toBe("packages/app");
    expect(rootWithinRepo("/repo", "/repository")).toBeNull();
  });
});

describe("scmChangeCount", () => {
  it("counts every group, as the activity bar badge does", () => {
    expect(scmChangeCount(null)).toBe(0);
    expect(
      scmChangeCount(
        status({
          merge: [{ path: "a", status: "conflicted" }],
          staged: [{ path: "b", status: "added" }],
          changes: [{ path: "c", status: "modified" }],
        }),
      ),
    ).toBe(3);
  });
});
