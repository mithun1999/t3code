import type * as Monaco from "monaco-editor/editor/editor.api.js";

import type { MonacoApi } from "./monacoRuntime";

/** Files kept open in memory after their tab closes, keeping undo history. */
const MAX_CACHED_MODELS = 24;
const MAX_REMEMBERED_REVISIONS = 64;

export interface CachedFileModel {
  readonly key: string;
  readonly model: Monaco.editor.ITextModel;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  /**
   * Revisions this editor wrote to the file query. The query echoes them back
   * a render late, so they must not be mistaken for someone else's change.
   */
  readonly localRevisions: Set<string>;
  /**
   * The disk contents and revision the model's edits are based on. Kept with
   * the model so a reopened tab still knows what it last agreed with.
   */
  synced: { readonly contents: string; readonly revision?: string | undefined } | null;
  lastUsedAt: number;
}

const cache = new Map<string, CachedFileModel>();

/** The model for a file, reusing the one from a closed tab so undo survives. */
export function acquireFileModel(
  monaco: MonacoApi,
  input: {
    readonly key: string;
    readonly path: string;
    readonly language: string;
    readonly contents: string;
  },
): CachedFileModel {
  const cached = cache.get(input.key);
  if (cached && !cached.model.isDisposed()) {
    if (cached.model.getLanguageId() !== input.language) {
      monaco.editor.setModelLanguage(cached.model, input.language);
    }
    cached.lastUsedAt = Date.now();
    return cached;
  }
  const uri = monaco.Uri.file(input.path);
  // Another environment can hold the same path; the newest file wins.
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    for (const [key, entry] of cache) {
      if (entry.model === existing) cache.delete(key);
    }
    existing.dispose();
  }
  const entry: CachedFileModel = {
    key: input.key,
    model: monaco.editor.createModel(input.contents, input.language, uri),
    viewState: null,
    localRevisions: new Set(),
    synced: null,
    lastUsedAt: Date.now(),
  };
  cache.set(input.key, entry);
  return entry;
}

/** Keeps the model and where the user was, then drops the oldest closed files. */
export function releaseFileModel(
  entry: CachedFileModel,
  viewState: Monaco.editor.ICodeEditorViewState | null,
): void {
  entry.viewState = viewState;
  entry.lastUsedAt = Date.now();
  const closed = [...cache.values()]
    .filter((candidate) => !candidate.model.isAttachedToEditor())
    .toSorted((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const stale of closed.slice(0, Math.max(0, cache.size - MAX_CACHED_MODELS))) {
    cache.delete(stale.key);
    stale.model.dispose();
  }
}

export function rememberLocalRevision(entry: CachedFileModel, revision: string): void {
  entry.localRevisions.delete(revision);
  entry.localRevisions.add(revision);
  if (entry.localRevisions.size > MAX_REMEMBERED_REVISIONS) {
    const oldest = entry.localRevisions.values().next().value;
    if (oldest !== undefined) entry.localRevisions.delete(oldest);
  }
}

/** Records the disk state the model's edits are now based on. */
export function markSynced(entry: CachedFileModel, synced: CachedFileModel["synced"]): void {
  entry.synced = synced;
}

/**
 * The single edit that turns `current` into `next`, touching only what
 * changed so the cursor, selections and folds elsewhere stay put.
 */
export function minimalReplacement(
  current: string,
  next: string,
): { readonly start: number; readonly end: number; readonly text: string } | null {
  if (current === next) return null;
  const limit = Math.min(current.length, next.length);
  let prefix = 0;
  while (prefix < limit && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    end: current.length - suffix,
    text: next.slice(prefix, next.length - suffix),
  };
}

/** Applies someone else's change (an agent edit) as one undoable step. */
export function applyExternalContents(model: Monaco.editor.ITextModel, contents: string): void {
  const replacement = minimalReplacement(model.getValue(), contents);
  if (!replacement) return;
  const start = model.getPositionAt(replacement.start);
  const end = model.getPositionAt(replacement.end);
  const range = {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
  model.pushStackElement();
  model.pushEditOperations([], [{ range, text: replacement.text }], () => null);
  model.pushStackElement();
}
