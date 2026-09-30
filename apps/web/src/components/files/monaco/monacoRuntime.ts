import type * as Monaco from "monaco-editor/editor/editor.api.js";
import type { StateStack } from "shiki/textmate";

import { resolveDiffThemeName } from "~/lib/diffRendering";

import { loadLanguageConfiguration } from "./monacoLanguages";

export type MonacoApi = typeof Monaco;
type Appearance = "light" | "dark";

export interface MonacoRuntime {
  readonly monaco: MonacoApi;
  /** Language id for a file, with its grammar and editing rules registered. */
  prepareLanguage(fileName: string): Promise<string>;
  /** Colours the editor like the app: the code theme for `appearance`, on `surface`'s background. */
  applyAppearance(appearance: Appearance, surface: HTMLElement): void;
}

let runtimePromise: Promise<MonacoRuntime> | null = null;

/** Loads Monaco on first use, so the app does not pay for it until a file opens. */
export function loadMonacoRuntime(): Promise<MonacoRuntime> {
  runtimePromise ??= createMonacoRuntime().catch((error: unknown) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

// TextMate's encoded token metadata (vscode-textmate's EncodedTokenMetadata).
const FONT_STYLE_MASK = 0b0000_0000_0000_0000_0111_1000_0000_0000;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0b0000_0000_1111_1111_1000_0000_0000_0000;
const FOREGROUND_OFFSET = 15;
const FONT_STYLE_NAMES = ["italic", "bold", "underline", "strikethrough"] as const;
const TOKENIZE_MAX_LINE_LENGTH = 20_000;
const TOKENIZE_TIME_LIMIT_MS = 500;

/**
 * Tokens name the colour Shiki resolved, not a TextMate scope, so every
 * VS Code theme selector (descendants, specificity) applies exactly as Shiki
 * computes it. The Monaco theme maps each name back to its colour.
 */
export function colorTokenName(colorIndex: number, fontStyle: number): string {
  return fontStyle > 0 ? `c${colorIndex}.s${fontStyle}` : `c${colorIndex}`;
}

function fontStyleName(fontStyle: number): string {
  return FONT_STYLE_NAMES.filter((_, bit) => (fontStyle & (1 << bit)) !== 0).join(" ");
}

export function colorTokenRules(colorMap: ReadonlyArray<string>): Monaco.editor.ITokenThemeRule[] {
  const rules: Monaco.editor.ITokenThemeRule[] = [];
  colorMap.forEach((color, colorIndex) => {
    if (!color) return;
    const foreground = color.replace(/^#/, "");
    rules.push({ token: colorTokenName(colorIndex, 0), foreground });
    for (let fontStyle = 1; fontStyle < 1 << FONT_STYLE_NAMES.length; fontStyle += 1) {
      rules.push({
        token: colorTokenName(colorIndex, fontStyle),
        foreground,
        fontStyle: fontStyleName(fontStyle),
      });
    }
  });
  return rules;
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("#")) return undefined;
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    return `#${[...hex].map((character) => character + character).join("")}`;
  }
  return hex.length === 6 || hex.length === 8 ? value : undefined;
}

/** The first opaque background at or above `element`, as #rrggbb. */
export function resolveSurfaceColor(element: HTMLElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const background = getComputedStyle(current).backgroundColor;
    if (!background || background === "transparent") continue;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    if (alpha < 250) continue;
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

const EDITOR_STYLES = `
.monaco-editor .t3-monaco-comment-add { cursor: pointer; }
.monaco-editor .t3-monaco-comment-add::before {
  content: "+";
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin: 3px auto 0;
  border-radius: 4px;
  background: var(--primary);
  color: var(--primary-foreground);
  font: 600 12px/1 var(--font-sans);
}
.monaco-editor .t3-monaco-comment-range {
  background: color-mix(in srgb, var(--primary) 9%, transparent);
}
.monaco-editor .t3-monaco-reveal-line {
  background: color-mix(in srgb, var(--primary) 18%, transparent);
}
.monaco-editor .t3-monaco-comment-zone {
  position: absolute;
  font-family: var(--font-sans);
  white-space: normal;
}
`;

function installEditorStyles(): void {
  if (document.querySelector("style[data-t3-monaco]")) return;
  const style = document.createElement("style");
  style.dataset.t3Monaco = "";
  style.textContent = EDITOR_STYLES;
  document.head.append(style);
}

async function createMonacoRuntime(): Promise<MonacoRuntime> {
  const [monaco, { default: EditorWorker }, shiki, { INITIAL }, pierre] = await Promise.all([
    import("monaco-editor/editor/editor.api.js"),
    import("monaco-editor/editor/editor.worker.js?worker"),
    import("shiki"),
    import("shiki/textmate"),
    import("@pierre/diffs"),
  ]);
  // Find, folding, multi-cursor, sticky scroll, the command palette and the rest.
  await import("monaco-editor/features/register.all.js");
  (globalThis as { MonacoEnvironment?: Monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  installEditorStyles();

  // A private highlighter: Shiki resolves token colours against the registry's
  // current theme, and the app's shared one switches theme per render.
  const highlighter = await shiki.createHighlighter({
    themes: [],
    langs: [],
    engine: shiki.createOnigurumaEngine(import("shiki/wasm")),
  });
  const themeNames: Record<Appearance, string> = {
    dark: resolveDiffThemeName("dark"),
    light: resolveDiffThemeName("light"),
  };
  for (const themeName of Object.values(themeNames)) {
    const resolved = await pierre.getResolvedOrResolveTheme(themeName);
    await highlighter.loadTheme(resolved);
  }

  let colorMap: ReadonlyArray<string> = [];
  let activeAppearance: Appearance | null = null;
  let activeSurface: string | null = null;
  const tokenizedLanguages = new Set<string>();
  const preparedLanguages = new Map<string, Promise<string>>();

  class TokenizerState implements Monaco.languages.IState {
    constructor(readonly ruleStack: StateStack) {}
    clone(): TokenizerState {
      return this;
    }
    equals(other: Monaco.languages.IState): boolean {
      return other instanceof TokenizerState && other.ruleStack === this.ruleStack;
    }
  }

  const registerTokenizer = (language: string) => {
    const grammar = highlighter.getLanguage(language);
    monaco.languages.setTokensProvider(language, {
      getInitialState: () => new TokenizerState(INITIAL),
      tokenize: (line: string, state: Monaco.languages.IState) => {
        const current = state as TokenizerState;
        if (line.length >= TOKENIZE_MAX_LINE_LENGTH) {
          return { endState: current, tokens: [{ startIndex: 0, scopes: "" }] };
        }
        const result = grammar.tokenizeLine2(line, current.ruleStack, TOKENIZE_TIME_LIMIT_MS);
        const tokens: Monaco.languages.IToken[] = [];
        for (let index = 0; index < result.tokens.length; index += 2) {
          const metadata = result.tokens[index + 1] ?? 0;
          const colorIndex = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
          const fontStyle = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
          tokens.push({
            startIndex: result.tokens[index] ?? 0,
            scopes: colorTokenName(colorIndex, fontStyle),
          });
        }
        return { endState: new TokenizerState(result.ruleStack), tokens };
      },
    });
  };

  const prepareLanguage = (fileName: string): Promise<string> => {
    const detected = pierre.getFiletypeFromFileName(fileName);
    if (!detected || detected === "text" || detected === "ansi")
      return Promise.resolve("plaintext");
    const cached = preparedLanguages.get(detected);
    if (cached) return cached;
    const prepared = (async () => {
      try {
        const resolved = await pierre.getResolvedOrResolveLanguage(detected);
        await highlighter.loadLanguage(...resolved.data);
      } catch {
        return "plaintext";
      }
      const known = monaco.languages.getLanguages();
      if (
        !known.some(
          (language: Monaco.languages.ILanguageExtensionPoint) => language.id === detected,
        )
      ) {
        monaco.languages.register({ id: detected });
      }
      monaco.languages.setLanguageConfiguration(
        detected,
        await loadLanguageConfiguration(detected),
      );
      registerTokenizer(detected);
      tokenizedLanguages.add(detected);
      return detected;
    })();
    preparedLanguages.set(detected, prepared);
    return prepared;
  };

  const applyAppearance = (appearance: Appearance, surface: HTMLElement) => {
    const surfaceColor = resolveSurfaceColor(surface);
    if (appearance === activeAppearance && surfaceColor === activeSurface) return;
    const themeName = themeNames[appearance];
    const theme = highlighter.getTheme(themeName);
    if (appearance !== activeAppearance) {
      colorMap = highlighter.setTheme(themeName).colorMap;
    }
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(theme.colors ?? {})) {
      const color = normalizeHexColor(value);
      if (color) colors[key] = color;
    }
    if (surfaceColor) {
      // Sit on the panel like the rest of the app, not on the theme's own canvas.
      for (const key of [
        "editor.background",
        "editorGutter.background",
        "minimap.background",
        "editorStickyScroll.background",
        "editorStickyScrollGutter.background",
      ]) {
        colors[key] = surfaceColor;
      }
    }
    const monacoThemeName = `t3-${appearance}`;
    monaco.editor.defineTheme(monacoThemeName, {
      base: appearance === "dark" ? "vs-dark" : "vs",
      inherit: false,
      rules: [
        {
          token: "",
          ...(theme.fg ? { foreground: theme.fg.replace(/^#/, "") } : {}),
        },
        ...colorTokenRules(colorMap),
      ],
      colors,
    });
    monaco.editor.setTheme(monacoThemeName);
    if (appearance !== activeAppearance) {
      // Token names index the colour map, which differs per theme; retokenize.
      for (const language of tokenizedLanguages) registerTokenizer(language);
    }
    activeAppearance = appearance;
    activeSurface = surfaceColor;
  };

  return { monaco, prepareLanguage, applyAppearance };
}
