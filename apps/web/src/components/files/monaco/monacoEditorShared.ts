import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { clampCodeFontSize, cssFontFamilies, DEFAULT_CODE_FONT_STACK } from "~/appearanceFonts";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";

import { type MonacoApi, loadMonacoRuntime, type MonacoRuntime } from "./monacoRuntime";

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

/**
 * VS Code keys that live in its workbench rather than its editor: ⌥Z toggles
 * word wrap (the app-wide setting) and ⇧⌘P opens the editor's command palette.
 */
export function useWorkbenchEditorKeys(
  monaco: MonacoApi,
  editors: ReadonlyArray<Monaco.editor.IStandaloneCodeEditor>,
): void {
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const updateClientSettings = useUpdateClientSettings();
  const toggleWordWrapRef = useRef(() => updateClientSettings({ wordWrap: !wordWrap }));
  useLayoutEffect(() => {
    toggleWordWrapRef.current = () => updateClientSettings({ wordWrap: !wordWrap });
  });
  useEffect(() => {
    const actions = editors.flatMap((editor) => [
      editor.addAction({
        id: "t3.toggleWordWrap",
        label: "View: Toggle Word Wrap",
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
        run: () => toggleWordWrapRef.current(),
      }),
      editor.addAction({
        id: "t3.showAllCommands",
        label: "Show All Commands",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP],
        run: (target) => target.trigger("keyboard", "editor.action.quickCommand", null),
      }),
    ]);
    return () => {
      for (const action of actions) action.dispose();
    };
  }, [editors, monaco]);
}
