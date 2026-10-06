import { describe, expect, it } from "vite-plus/test";

import { findMissingFileCandidates, missingFileLookupPath } from "./missingFileCandidates";

describe("missingFileLookupPath", () => {
  it("normalizes relative paths and rejects ones that can't be looked up", () => {
    expect(missingFileLookupPath("./app/utils/hostApp.ts")).toBe("app/utils/hostApp.ts");
    expect(missingFileLookupPath("app\\utils\\hostApp.ts")).toBe("app/utils/hostApp.ts");
    expect(missingFileLookupPath("/Users/me/app.ts")).toBeNull();
    expect(missingFileLookupPath("C:/repo/app.ts")).toBeNull();
    expect(missingFileLookupPath("../app.ts")).toBeNull();
    expect(missingFileLookupPath("")).toBeNull();
  });
});

describe("findMissingFileCandidates", () => {
  it("finds files ending with the path on segment boundaries, shortest first", () => {
    expect(
      findMissingFileCandidates(
        [
          "popups/apps/popups-editor/app/utils/hostApp.ts",
          "popups/apps/popups-editor/myapp/utils/hostApp.ts",
          "js-client/app/utils/hostApp.ts",
          "app/utils/hostApp.ts.bak",
          "app/utils/hostApp.ts",
        ],
        "app/utils/hostApp.ts",
      ),
    ).toEqual(["js-client/app/utils/hostApp.ts", "popups/apps/popups-editor/app/utils/hostApp.ts"]);
  });

  it("finds nothing when no file ends with the path", () => {
    expect(findMissingFileCandidates(["src/hostApp.ts"], "app/utils/hostApp.ts")).toEqual([]);
  });
});
