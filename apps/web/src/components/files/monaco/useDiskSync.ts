import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { fileContentRevision } from "../fileContentRevision";
import { mergeThreeWay } from "../threeWayMerge";
import type { FileSaveHooks } from "../useFileSaveCoordinator";
import { applyExternalContents, type CachedFileModel, markSynced } from "./monacoModels";

export interface DiskFile {
  readonly contents: string;
  readonly revision?: string | undefined;
}

export interface DiskConflict {
  /** What is on disk now, which the unsaved edits clash with. */
  readonly diskContents: string;
}

/**
 * Keeps an open file's model and the file on disk in step, so neither side's
 * edits are lost:
 * - someone else's change (an agent's) is merged into the model as one
 *   undoable step, keeping unsaved typing on other lines;
 * - saves name the disk revision they were based on, and a save that would
 *   overwrite a newer file is refused and merged instead;
 * - edits to the same lines on both sides stop autosave and ask, as VS Code does.
 */
export function useDiskSync(input: {
  readonly entry: CachedFileModel | null;
  readonly disk: DiskFile | null;
  readonly saveHooksRef: RefObject<FileSaveHooks | null>;
  readonly applyingExternalRef: RefObject<boolean>;
  /** Records `contents` as this editor's own and saves it. */
  readonly saveLocal: (contents: string) => void;
  /** Re-reads the file from disk. */
  readonly refreshDisk: () => void;
}): {
  readonly conflict: DiskConflict | null;
  readonly keepMine: () => void;
  readonly useDiskVersion: () => void;
} {
  const { entry, disk, saveHooksRef, applyingExternalRef, saveLocal, refreshDisk } = input;
  const entryRef = useRef(entry);
  useLayoutEffect(() => {
    entryRef.current = entry;
  });
  const conflictRef = useRef<DiskConflict | null>(null);
  const [conflict, setConflict] = useState<DiskConflict | null>(null);
  const refreshDiskRef = useRef(refreshDisk);
  useLayoutEffect(() => {
    refreshDiskRef.current = refreshDisk;
  });

  useLayoutEffect(() => {
    saveHooksRef.current = {
      expectedRevision: () => entryRef.current?.synced?.revision,
      isBlocked: () => conflictRef.current !== null,
      onSaved: (contents, revision) => {
        const current = entryRef.current;
        if (current) markSynced(current, { contents, revision });
      },
      // Re-reading the file brings its change here, to be merged and saved again.
      onConflict: () => refreshDiskRef.current(),
    };
    return () => {
      saveHooksRef.current = null;
    };
  }, [saveHooksRef]);

  const applyExternal = useCallback(
    (contents: string) => {
      if (!entry) return;
      applyingExternalRef.current = true;
      try {
        applyExternalContents(entry.model, contents);
      } finally {
        applyingExternalRef.current = false;
      }
    },
    [applyingExternalRef, entry],
  );

  useEffect(() => {
    if (!entry || !disk) return;
    const synced = entry.synced;
    // A new model was just made from the file.
    if (synced === null) {
      markSynced(entry, disk);
      return;
    }
    markSynced(entry, disk);
    if (synced.contents === disk.contents) return;
    const ours = entry.model.getValue();
    // This editor's own save coming back, or the two already agree.
    if (entry.localRevisions.has(fileContentRevision(disk.contents)) || ours === disk.contents) {
      return;
    }
    if (conflictRef.current) {
      conflictRef.current = { diskContents: disk.contents };
      setConflict(conflictRef.current);
      return;
    }
    if (ours === synced.contents) {
      applyExternal(disk.contents);
      entry.localRevisions.clear();
      return;
    }
    const merge = mergeThreeWay(synced.contents, ours, disk.contents);
    if (merge.clean) {
      applyExternal(merge.merged);
      saveLocal(merge.merged);
      return;
    }
    conflictRef.current = { diskContents: disk.contents };
    setConflict(conflictRef.current);
  }, [applyExternal, disk, entry, saveLocal]);

  const keepMine = useCallback(() => {
    conflictRef.current = null;
    setConflict(null);
    if (entry) saveLocal(entry.model.getValue());
  }, [entry, saveLocal]);

  const useDiskVersion = useCallback(() => {
    const current = conflictRef.current;
    conflictRef.current = null;
    setConflict(null);
    if (!entry || !current) return;
    applyExternal(current.diskContents);
    entry.localRevisions.clear();
    // Settles the save that was waiting on the conflict; it writes what is on disk.
    saveLocal(current.diskContents);
  }, [applyExternal, entry, saveLocal]);

  return { conflict, keepMine, useDiskVersion };
}
