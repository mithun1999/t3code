import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useEffect, useState } from "react";

import { clampCodeFontSize, cssFontFamilies, DEFAULT_CODE_FONT_STACK } from "~/appearanceFonts";

import { loadMonacoRuntime, type MonacoRuntime } from "./monacoRuntime";

/** The app's code font, with VS Code's line height and ligatures. */
export function fontOptions(family: string, size: number): Monaco.editor.IEditorOptions {
  const fontSize = clampCodeFontSize(size);
  const custom = cssFontFamilies(family);
  return {
    fontFamily: custom ? `${custom}, ${DEFAULT_CODE_FONT_STACK}` : DEFAULT_CODE_FONT_STACK,
    fontSize,
    lineHeight: Math.round(fontSize * 1.5),
    fontLigatures: true,
  };
}

/** Monaco, loaded on first use. */
export function useMonacoRuntime(): {
  readonly runtime: MonacoRuntime | null;
  readonly loadError: string | null;
} {
  const [runtime, setRuntime] = useState<MonacoRuntime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMonacoRuntime().then(
      (loaded) => {
        if (!cancelled) setRuntime(loaded);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return { runtime, loadError };
}
