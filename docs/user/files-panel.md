# Files panel

The Files panel works like VS Code's window: an activity bar on the left picks
the side bar view, and the file or diff you open fills the rest. Choose the
active view's icon again to hide the side bar.

While the panel has the keyboard, VS Code's view keys work: ⌘B hides or shows
the side bar, ⇧⌘E shows the Explorer and ⌃⇧G shows Source Control. Elsewhere
those keys keep their usual meaning (⌘B still toggles the thread sidebar).

## Explorer

The explorer lists your workspace. In a multi-repo workspace each repository is
a top-level folder.

- **New File…** and **New Folder…** (the header buttons, or a right-click)
  add an entry in the selected folder. Type its name and press Enter.
- **Rename…** (F2) and **Delete** (⌘⌫ or Delete) act on the selected entry.
  Deleted entries go to the Trash; if that isn't possible, T3 Code asks before
  deleting them for good.
- **Duplicate** copies a file or folder as `name copy.ext`.
- Drag an entry onto a folder to move it. T3 Code asks first. Dragging an entry
  onto the chat composer still adds it as a mention.
- **Copy Path** and **Copy Relative Path** copy the entry's location.

Changed files are coloured as in VS Code, with a letter badge: **M** modified,
**U** untracked, **A** added, **D** deleted, **R** renamed. Ignored files are
dimmed.

The server watches the workspace, so files an agent or another program
creates, renames or deletes appear without a refresh. The tree keeps the
folders you opened when you switch to another tab and back.

## Source Control

The Source Control view lists each repository's changes in VS Code's groups:
**Merge Changes**, **Staged Changes** and **Changes**.

- Select a file to open its diff: unstaged changes compare the index with the
  working tree, staged changes compare HEAD with the index.
- Hover a file for **Open File**, **Discard Changes**, and **Stage** or
  **Unstage**. Hover a group's title to act on every file in it.
- Type a message and press ⌘Enter, or choose **Commit**. With nothing staged,
  T3 Code offers to stage everything and commit it. The menu next to **Commit**
  has **Commit (Amend)**, **Stage All Changes** and **Unstage All Changes**.
- Discarding a new file moves it to the Trash. Discarding edits to a tracked
  file can't be undone.

### The diff editor

The diff opens in VS Code's diff editor. Use the header to step between
changes (⌥F5 and ⇧⌥F5), switch between side-by-side and inline, or collapse
unchanged regions. The working tree side is editable and saves like any file;
the arrows between the sides revert a change.

## Keyboard

Files and diffs open in VS Code's editor, with its keyboard shortcuts: ⌘D adds
the next match, ⇧⌘L selects every match, ⌥↑ and ⌥↓ move lines, ⇧⌘K deletes a
line, ⌘/ comments, ⌘[ and ⌘] indent, ⌘F finds and ⌥⌘F replaces. ⌥Z toggles word
wrap and ⇧⌘P (or F1) opens the editor's command palette. While the editor has the
keyboard, these win over the app's shortcuts that share their keys.

## Edits from agents

When an agent changes a file you have open, the change appears in the editor
straight away, and one undo removes it. If you have unsaved edits on other
lines, both sets of edits are kept. If you both changed the same lines, saving
pauses and T3 Code asks whether to keep your version or use the one on disk,
so neither is overwritten silently.
