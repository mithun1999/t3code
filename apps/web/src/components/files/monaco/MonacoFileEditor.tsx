import type * as Monaco from "monaco-editor/editor/editor.api.js";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "~/components/ui/spinner";
import type { DraftId } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { resolvePathLinkTarget } from "~/terminal-links";

import { fileContentRevision } from "../fileContentRevision";
import { setProjectFileQueryData } from "../projectFilesQueryState";
import { type FileSaveHooks, useFileSaveCoordinator } from "../useFileSaveCoordinator";
import { DiskConflictBanner } from "./DiskConflictBanner";
import {
  acquireFileModel,
  type CachedFileModel,
  rememberLocalRevision,
  releaseFileModel,
} from "./monacoModels";
import { fontOptions, useMonacoRuntime, useWorkbenchEditorKeys } from "./monacoEditorShared";
import type { MonacoRuntime } from "./monacoRuntime";
import { type DiskFile, useDiskSync } from "./useDiskSync";
import { useMonacoReviewComments } from "./useMonacoReviewComments";

export interface MonacoFileEditorProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Owning repo root, forwarded to onPendingChange so the surface id matches. */
  readonly root?: string | undefined;
  readonly contents: string;
  /** The file as last read from disk, for merging others' changes and safe saves. */
  readonly disk: DiskFile | null;
  /** Re-reads the file, e.g. after a save found it changed on disk. */
  readonly onRefreshDisk: () => void;
  readonly resolvedTheme: "light" | "dark";
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
  readonly onPendingChange: (relativePath: string, pending: boolean, root?: string) => void;
}

/** Below this width the minimap costs more room than it saves. */
const MINIMAP_MIN_EDITOR_WIDTH = 560;

/** VS Code's defaults where the standalone editor differs from them. */
const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  bracketPairColorization: { enabled: true },
  fixedOverflowWidgets: true,
  // Holds the review comment "+", as VS Code's does breakpoints.
  glyphMargin: true,
  guides: { bracketPairs: "active", indentation: true },
  minimap: { enabled: true },
  padding: { top: 4 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  smoothScrolling: true,
  stickyScroll: { enabled: true },
};

/**
 * Editors already disposed, with where they were scrolled to. Their models
 * must not be touched again, but the model keeps the view state for next time.
 */
const disposedEditors = new WeakMap<
  Monaco.editor.IStandaloneCodeEditor,
  Monaco.editor.ICodeEditorViewState | null
>();

export function MonacoFileEditor(props: MonacoFileEditorProps) {
  const { runtime, loadError } = useMonacoRuntime();

  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
        The editor could not load: {loadError}
      </div>
    );
  }
  if (!runtime) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  return <MonacoFileEditorSurface runtime={runtime} {...props} />;
}

function MonacoFileEditorSurface({
  runtime,
  environmentId,
  cwd,
  relativePath,
  composerDraftTarget,
  root,
  contents,
  disk,
  onRefreshDisk,
  resolvedTheme,
  revealLine,
  revealRequestId,
  wordWrap,
  onPendingChange,
}: MonacoFileEditorProps & { readonly runtime: MonacoRuntime }) {
  const { monaco } = runtime;
  const containerRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [entry, setEntry] = useState<CachedFileModel | null>(null);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const saveHooksRef = useRef<FileSaveHooks | null>(null);
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    root,
    onPendingChange,
    hooks: saveHooksRef,
  });
  const contentsRef = useRef(contents);
  useLayoutEffect(() => {
    contentsRef.current = contents;
  });
  const initialOptionsRef = useRef({ resolvedTheme, wordWrap, fontFamilyCode, fontSizeCode });
  const absolutePath = useMemo(() => resolvePathLinkTarget(relativePath, cwd), [cwd, relativePath]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = initialOptionsRef.current;
    runtime.applyAppearance(initial.resolvedTheme, container);
    const instance = monaco.editor.create(container, {
      ...EDITOR_OPTIONS,
      ...fontOptions(initial.fontFamilyCode, initial.fontSizeCode),
      model: null,
      wordWrap: initial.wordWrap ? "on" : "off",
    });
    setEditor(instance);
    return () => {
      disposedEditors.set(instance, instance.saveViewState());
      instance.dispose();
      setEditor(null);
    };
  }, [monaco, runtime]);

  // Open the file's model, keeping the one from an earlier tab so undo survives.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    let acquired: CachedFileModel | null = null;
    void runtime.prepareLanguage(relativePath).then((language) => {
      if (cancelled) return;
      acquired = acquireFileModel(monaco, {
        key: `${environmentId}:${absolutePath}`,
        path: absolutePath,
        language,
        contents: contentsRef.current,
      });
      editor.setModel(acquired.model);
      if (acquired.viewState) editor.restoreViewState(acquired.viewState);
      setEntry(acquired);
    });
    return () => {
      cancelled = true;
      if (acquired) {
        // On unmount the editor is disposed first; keep the view state it had.
        if (disposedEditors.has(editor)) {
          releaseFileModel(acquired, disposedEditors.get(editor) ?? acquired.viewState);
        } else {
          const viewState = editor.saveViewState();
          editor.setModel(null);
          releaseFileModel(acquired, viewState);
        }
      }
      setEntry(null);
    };
  }, [absolutePath, editor, environmentId, monaco, relativePath, runtime]);

  // Typing autosaves, like the classic editor.
  const applyingExternalRef = useRef(false);
  useEffect(() => {
    if (!entry) return;
    const { model } = entry;
    const subscription = model.onDidChangeContent(() => {
      if (applyingExternalRef.current) return;
      const value = model.getValue();
      rememberLocalRevision(entry, fileContentRevision(value));
      setProjectFileQueryData(environmentId, cwd, relativePath, value);
      saveCoordinator.change(value);
    });
    return () => subscription.dispose();
  }, [cwd, entry, environmentId, relativePath, saveCoordinator]);

  const saveLocal = useCallback(
    (value: string) => {
      if (entry) rememberLocalRevision(entry, fileContentRevision(value));
      setProjectFileQueryData(environmentId, cwd, relativePath, value);
      saveCoordinator.change(value);
    },
    [cwd, entry, environmentId, relativePath, saveCoordinator],
  );
  // An agent (or anyone else) changed the file: merge it in as one undoable
  // edit, keeping unsaved typing; clashing edits pause saving and ask.
  const { conflict, keepMine, useDiskVersion } = useDiskSync({
    entry,
    disk,
    saveHooksRef,
    applyingExternalRef,
    saveLocal,
    refreshDisk: onRefreshDisk,
  });

  // The side panel is often narrow; show the minimap only when there is room.
  useEffect(() => {
    if (!editor) return;
    const fitMinimap = () => {
      const enabled = editor.getLayoutInfo().width >= MINIMAP_MIN_EDITOR_WIDTH;
      if (editor.getOption(monaco.editor.EditorOption.minimap).enabled !== enabled) {
        editor.updateOptions({ minimap: { enabled } });
      }
    };
    fitMinimap();
    const subscription = editor.onDidLayoutChange(fitMinimap);
    return () => subscription.dispose();
  }, [editor, monaco]);

  const keyedEditors = useMemo(() => (editor ? [editor] : []), [editor]);
  useWorkbenchEditorKeys(monaco, keyedEditors);

  // Cmd+S saves now rather than after the autosave pause.
  useEffect(() => {
    if (!editor) return;
    const action = editor.addAction({
      id: "t3.saveFile",
      label: "Save",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveCoordinator.flush(),
    });
    return () => action.dispose();
  }, [editor, monaco, saveCoordinator]);

  useEffect(() => {
    const container = containerRef.current;
    if (!editor || !container) return;
    runtime.applyAppearance(resolvedTheme, container);
    // Switching between two light or two dark app themes changes the panel colour.
    const observer = new MutationObserver(() => runtime.applyAppearance(resolvedTheme, container));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, [editor, resolvedTheme, runtime]);

  useEffect(() => {
    editor?.updateOptions({
      ...fontOptions(fontFamilyCode, fontSizeCode),
      wordWrap: wordWrap ? "on" : "off",
    });
  }, [editor, fontFamilyCode, fontSizeCode, wordWrap]);

  useEffect(() => {
    if (!editor || !entry || revealLine === null) return;
    const line = Math.min(Math.max(1, revealLine), entry.model.getLineCount());
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
    const highlight = editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "t3-monaco-reveal-line" },
      },
    ]);
    const timer = window.setTimeout(() => highlight.clear(), 2000);
    return () => {
      window.clearTimeout(timer);
      highlight.clear();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Opening the same line again must reveal it again.
  }, [editor, entry, monaco, revealLine, revealRequestId]);

  const commentPortals = useMonacoReviewComments({
    monaco,
    editor,
    model: entry?.model ?? null,
    composerDraftTarget,
    relativePath,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {conflict ? <DiskConflictBanner onKeepMine={keepMine} onUseDisk={useDiskVersion} /> : null}
      <div className="relative flex min-h-0 flex-1" data-monaco-file-editor>
        <div ref={containerRef} className="min-h-0 min-w-0 flex-1" />
        {commentPortals}
      </div>
    </div>
  );
}
