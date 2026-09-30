import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS, upgradeSupersededDefaultKeybindings } from "./keybindings.ts";

describe("upgradeSupersededDefaultKeybindings", () => {
  it("moves rules that are exactly the earlier default to today's default", () => {
    const saved = [
      { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      { key: "mod+j", command: "terminal.toggle" },
    ] as const;
    const upgraded = upgradeSupersededDefaultKeybindings(saved);
    expect(upgraded).toEqual([
      DEFAULT_KEYBINDINGS.find((rule) => rule.command === "diff.toggle"),
      { key: "mod+j", command: "terminal.toggle" },
    ]);
    expect(upgraded[0]?.when).toContain("!codeEditorFocus");
  });

  it("keeps rules the user changed, and returns the same list when nothing moved", () => {
    const customised = [
      { key: "mod+shift+d", command: "diff.toggle", when: "!terminalFocus" },
      { key: "mod+d", command: "commandPalette.toggle", when: "!terminalFocus" },
    ] as const;
    expect(upgradeSupersededDefaultKeybindings(customised)).toBe(customised);
  });
});
