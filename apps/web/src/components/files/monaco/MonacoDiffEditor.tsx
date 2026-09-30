import type * as Monaco from "monaco-editor/editor/editor.api.js";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "~/components/ui/spinner";
import { useClientSettings } from "~/hooks/useSettings";
import { resolvePathLinkTarget } from "~/terminal-links";

import { fileContentRevision } from "../fileContentRevision";
import { setProjectFileQueryData } from "../projectFilesQueryState";
import { type FileSaveHooks, useFileSaveCoordinator } from "../useFileSaveCoordinator";
import { DiskConflictBanner } from "./DiskConflictBanner";
import { fontOptions, useMonacoRuntime, useWorkbenchEditorKeys } from "./monacoEditorShared";
import {
  acquireFileModel,
  applyExternalContents,
  type CachedFileModel,
  rememberLocalRevision,
  releaseFileModel,
} from "./monacoModels";
import type { MonacoRuntime } from "./monacoRuntime";
import { type DiskFile, useDiskSync } from "./useDiskSync";

export interface MonacoDiffEditorProps {
  readonly environmentId: EnvironmentId;
  /** Repository root the path is relative to. */
  readonly cwd: string;
  readonly relativePath: string;
  /** Which version the left side shows, for its model's identity. */
  readonly originalRevision: "HEAD" | "index";
  readonly originalContents: string;
  readonly modifiedContents: string;
  /** The working-tree file as last read from disk, when the right side is editable. */
  readonly disk: DiskFile | null;
  readonly onRefreshDisk: () => void;
  /** The right side is the working-tree file: edits and reverts save to disk. */
  readonly editable: boolean;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly sideBySide: boolean;
  readonly collapseUnchanged: boolean;
  /** Owning root as the file surface knows it, for pending-save state. */
  readonly root?: string | undefined;
  readonly onPendingChange: (relativePath: string, pending: boolean, root?: string) => void;
  readonly onEditorChange?: (editor: Monaco.editor.IStandaloneDiffEditor | null) => void;
}

/** VS Code's diff editor defaults, plus revert arrows between the sides. */
const DIFF_EDITOR_OPTIONS: Monaco.editor.IStandaloneDiffEditorConstructionOptions = {
  automaticLayout: true,
  diffAlgorithm: "advanced",
  experimental: { showMoves: true },
  fixedOverflowWidgets: true,
  ignoreTrimWhitespace: false,
  minimap: { enabled: false },
  originalEditable: false,
  padding: { top: 4 },
  renderOverviewRuler: true,
  renderSideBySideInlineBreakpoint: 640,
  scrollBeyondLastLine: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  smoothScrolling: true,
  stickyScroll: { enabled: true },
  useInlineViewWhenSpaceIsLimited: true,
};

/** Diff editors already disposed, whose models must not be touched again. */
const disposedEditors = new WeakSet<Monaco.editor.IStandaloneDiffEditor>();

export function MonacoDiffEditor(props: MonacoDiffEditorProps) {
  const { runtime, loadError } = useMonacoRuntime();
  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
        The diff editor could not load: {loadError}
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
  return <MonacoDiffEditorSurface runtime={runtime} {...props} />;
}

function MonacoDiffEditorSurface({
  runtime,
  environmentId,
  cwd,
  relativePath,
  originalRevision,
  originalContents,
  modifiedContents,
  disk,
  onRefreshDisk,
  editable,
  resolvedTheme,
  wordWrap,
  sideBySide,
  collapseUnchanged,
  root,
  onPendingChange,
  onEditorChange,
}: MonacoDiffEditorProps & { readonly runtime: MonacoRuntime }) {
  const { monaco } = runtime;
  const containerRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const [models, setModels] = useState<{
    readonly original: Monaco.editor.ITextModel;
    readonly modified: Monaco.editor.ITextModel;
    readonly file: CachedFileModel | null;
  } | null>(null);
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
  const contentsRef = useRef({ originalContents, modifiedContents });
  useLayoutEffect(() => {
    contentsRef.current = { originalContents, modifiedContents };
  });
  const initialOptionsRef = useRef({
    resolvedTheme,
    wordWrap,
    fontFamilyCode,
    fontSizeCode,
    sideBySide,
    collapseUnchanged,
    editable,
  });
  const absolutePath = useMemo(() => resolvePathLinkTarget(relativePath, cwd), [cwd, relativePath]);
  const onEditorChangeRef = useRef(onEditorChange);
  useLayoutEffect(() => {
    onEditorChangeRef.current = onEditorChange;
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = initialOptionsRef.current;
    runtime.applyAppearance(initial.resolvedTheme, container);
    const instance = monaco.editor.createDiffEditor(container, {
      ...DIFF_EDITOR_OPTIONS,
      ...fontOptions(initial.fontFamilyCode, initial.fontSizeCode),
      renderSideBySide: initial.sideBySide,
      hideUnchangedRegions: { enabled: initial.collapseUnchanged },
      readOnly: !initial.editable,
      renderMarginRevertIcon: initial.editable,
      wordWrap: initial.wordWrap ? "on" : "off",
    });
    setEditor(instance);
    onEditorChangeRef.current?.(instance);
    return () => {
      onEditorChangeRef.current?.(null);
      disposedEditors.add(instance);
      instance.dispose();
      setEditor(null);
    };
  }, [monaco, runtime]);

  // The right side of a working-tree diff is the file's own model, so its
  // undo history and unsaved edits are shared with the file's editor tab.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    let attached: {
      original: Monaco.editor.ITextModel;
      modified: Monaco.editor.ITextModel;
      file: CachedFileModel | null;
    } | null = null;
    void runtime.prepareLanguage(relativePath).then((language) => {
      if (cancelled) return;
      const { originalContents: original, modifiedContents: modified } = contentsRef.current;
      const originalModel = monaco.editor.createModel(
        original,
        language,
        monaco.Uri.from({ scheme: "t3-git", path: absolutePath, query: originalRevision }),
      );
      const file = editable
        ? acquireFileModel(monaco, {
            key: `${environmentId}:${absolutePath}`,
            path: absolutePath,
            language,
            contents: modified,
          })
        : null;
      const modifiedModel =
        file?.model ??
        monaco.editor.createModel(
          modified,
          language,
          monaco.Uri.from({ scheme: "t3-git", path: absolutePath, query: "modified" }),
        );
      editor.setModel({ original: originalModel, modified: modifiedModel });
      attached = { original: originalModel, modified: modifiedModel, file };
      setModels(attached);
      // Open at the first change, as VS Code does.
      const listener = editor.onDidUpdateDiff(() => {
        listener.dispose();
        if (!cancelled) editor.revealFirstDiff();
      });
    });
    return () => {
      cancelled = true;
      if (attached) {
        // On unmount the editor goes first; a disposed diff editor throws on setModel.
        if (!disposedEditors.has(editor)) editor.setModel(null);
        attached.original.dispose();
        if (attached.file) releaseFileModel(attached.file, attached.file.viewState);
        else attached.modified.dispose();
      }
      setModels(null);
    };
  }, [
    absolutePath,
    editable,
    editor,
    environmentId,
    monaco,
    originalRevision,
    relativePath,
    runtime,
  ]);

  // The index or HEAD moved (a stage, a commit): update the left side in place.
  useEffect(() => {
    if (!models || models.original.getValue() === originalContents) return;
    applyExternalContents(models.original, originalContents);
  }, [models, originalContents]);

  // Edits and revert arrows autosave the working-tree file.
  const applyingExternalRef = useRef(false);
  useEffect(() => {
    const file = models?.file;
    if (!file) return;
    const subscription = file.model.onDidChangeContent(() => {
      if (applyingExternalRef.current) return;
      const value = file.model.getValue();
      rememberLocalRevision(file, fileContentRevision(value));
      setProjectFileQueryData(environmentId, cwd, relativePath, value);
      saveCoordinator.change(value);
    });
    return () => subscription.dispose();
  }, [cwd, environmentId, models, relativePath, saveCoordinator]);

  // A staged version moved: replace the read-only right side in place.
  useEffect(() => {
    if (!models || models.file || models.modified.getValue() === modifiedContents) return;
    applyExternalContents(models.modified, modifiedContents);
  }, [models, modifiedContents]);

  // An agent changed the working-tree file: merge it in, as the file editor does.
  const saveLocal = useCallback(
    (value: string) => {
      const file = models?.file;
      if (file) rememberLocalRevision(file, fileContentRevision(value));
      setProjectFileQueryData(environmentId, cwd, relativePath, value);
      saveCoordinator.change(value);
    },
    [cwd, environmentId, models, relativePath, saveCoordinator],
  );
  const { conflict, keepMine, useDiskVersion } = useDiskSync({
    entry: models?.file ?? null,
    disk,
    saveHooksRef,
    applyingExternalRef,
    saveLocal,
    refreshDisk: onRefreshDisk,
  });

  const keyedEditors = useMemo(
    () => (editor ? [editor.getOriginalEditor(), editor.getModifiedEditor()] : []),
    [editor],
  );
  useWorkbenchEditorKeys(monaco, keyedEditors);

  useEffect(() => {
    if (!editor) return;
    const modifiedEditor = editor.getModifiedEditor();
    const actions = [
      modifiedEditor.addAction({
        id: "t3.saveFile",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => saveCoordinator.flush(),
      }),
      modifiedEditor.addAction({
        id: "t3.diff.nextChange",
        label: "Go to Next Change",
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F5],
        run: () => editor.goToDiff("next"),
      }),
      modifiedEditor.addAction({
        id: "t3.diff.previousChange",
        label: "Go to Previous Change",
        keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.F5],
        run: () => editor.goToDiff("previous"),
      }),
    ];
    return () => {
      for (const action of actions) action.dispose();
    };
  }, [editor, monaco, saveCoordinator]);

  useEffect(() => {
    const container = containerRef.current;
    if (!editor || !container) return;
    runtime.applyAppearance(resolvedTheme, container);
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
      renderSideBySide: sideBySide,
      hideUnchangedRegions: { enabled: collapseUnchanged },
      readOnly: !editable,
      renderMarginRevertIcon: editable,
    });
  }, [collapseUnchanged, editable, editor, fontFamilyCode, fontSizeCode, sideBySide, wordWrap]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {conflict ? <DiskConflictBanner onKeepMine={keepMine} onUseDisk={useDiskVersion} /> : null}
      <div className="relative flex min-h-0 flex-1" data-monaco-diff-editor>
        <div ref={containerRef} className="min-h-0 min-w-0 flex-1" />
      </div>
    </div>
  );
}
