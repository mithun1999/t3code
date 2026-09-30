import { describe, expect, it } from "vite-plus/test";

import { colorTokenName, colorTokenRules } from "./monacoRuntime";
import { languageConfigurationSource } from "./monacoLanguages";

describe("colorTokenName", () => {
  it("names a token by its colour and font style", () => {
    expect(colorTokenName(7, 0)).toBe("c7");
    expect(colorTokenName(7, 1)).toBe("c7.s1");
    expect(colorTokenName(12, 3)).toBe("c12.s3");
  });
});

describe("colorTokenRules", () => {
  it("maps every colour and font style back to the theme's colour", () => {
    const rules = colorTokenRules(["", "#ff0000", "#00FF0080"]);
    expect(rules.find((rule) => rule.token === "c1")).toEqual({
      token: "c1",
      foreground: "ff0000",
    });
    expect(rules.find((rule) => rule.token === "c1.s1")).toEqual({
      token: "c1.s1",
      foreground: "ff0000",
      fontStyle: "italic",
    });
    expect(rules.find((rule) => rule.token === "c2.s3")).toEqual({
      token: "c2.s3",
      foreground: "00FF0080",
      fontStyle: "italic bold",
    });
    expect(rules.some((rule) => rule.token.startsWith("c0"))).toBe(false);
    expect(rules).toHaveLength(2 * 16);
  });
});

describe("languageConfigurationSource", () => {
  it("borrows Monaco's rules for Shiki grammars, including dialects", () => {
    expect(languageConfigurationSource("tsx")).toEqual({ kind: "definition", name: "typescript" });
    expect(languageConfigurationSource("jsx")).toEqual({ kind: "definition", name: "javascript" });
    expect(languageConfigurationSource("python")).toEqual({ kind: "definition", name: "python" });
    expect(languageConfigurationSource("shellscript")).toEqual({
      kind: "definition",
      name: "shell",
    });
    expect(languageConfigurationSource("vue")).toEqual({ kind: "definition", name: "html" });
  });

  it("uses JSON rules for JSON flavours and generic rules otherwise", () => {
    expect(languageConfigurationSource("jsonc")).toEqual({ kind: "json" });
    expect(languageConfigurationSource("dotenv")).toEqual({ kind: "generic" });
  });
});
