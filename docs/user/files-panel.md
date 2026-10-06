# Files panel

The Files panel works like VS Code's window with its side bar on the right: an
activity bar at the panel's right edge picks the side bar view, and the file or
diff you open fills the rest. Choose the active view's icon again to hide the
side bar.

While the panel has the keyboard, VS Code's view keys work: ⌘B hides or shows
the side bar, ⇧⌘E shows the Explorer, ⇧⌘H shows Search with replace, and ⌃⇧G
shows Source Control. Elsewhere those keys keep their usual meaning (⌘B still
toggles the thread sidebar). ⇧⌘F opens Search from anywhere in a thread.

## Tabs

Files open in a preview tab, shown in italics, as in VS Code: the next file or
diff you open takes its place, so browsing doesn't pile up tabs. Editing the
file, double-clicking its tab, or double-clicking it in the explorer keeps the
tab open. When two tabs share a name, each shows the repo or folder it comes
from, such as `hello.py repo-a`.

## Links to files

A file path in the chat opens in the Files panel. Agents often write a path
relative to the folder they were working in, such as `app/utils/hostApp.ts`
inside `popups/apps/popups-editor`. When a path isn't at the top of the
workspace, T3 Code opens the workspace file that ends with it, or lists the
files when there are several.

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

## Search

The Search view finds text across the workspace and replaces it, as VS Code's
does. Press ⇧⌘F, or choose the magnifying glass in the activity bar. Text you
selected in the chat fills in the search.

- **Aa** matches case, **ab** matches whole words, and **.\*** searches with a
  regular expression.
- Choose **…** for **files to include** and **files to exclude**: comma-separated
  patterns such as `*.ts, src/components` or `node_modules, *.test.ts`. A
  pattern matches in any folder unless it starts with `./`. Files ignored by git
  aren't searched.
- Results are grouped by file. Select one to open the file at that line. Hover a
  file or a result to dismiss it, or press Delete on a result.

Choose the arrow left of the search box, or press ⇧⌘H, to show **Replace**. The
results then preview each change. Hover a result or a file for **Replace** or
**Replace All**, or replace every result with the button beside the field
(⌥⌘Enter), which asks first. With a regular expression, `$1` and `$<name>`
insert captured groups, `$&` the whole match, and `\n` a new line. If a file
changed since the search, a result that moved is left alone and T3 Code says so.

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

Source Control replaces the old Diff panel: **Source Control** in the panel's
menu and ⌘D open it, and it opens by itself after a turn that changed files.
"Open diff" in the chat opens here too. For the latest turn, changes that are
still uncommitted open in Source Control, so you can review, stage and commit
them in one place. Earlier turns, and changes already committed, open that
turn's own changes (the tab says "Turn 3"): the file as the turn found it
against how it left it.

### The diff editor

The diff opens in VS Code's diff editor. Use the header to step between
changes (⌥F5 and ⇧⌥F5), switch between side-by-side and inline, or collapse
unchanged regions. The working tree side is editable and saves like any file;
the arrows between the sides revert a change.

## Go to file (⌘P)

⌘P finds files the way VS Code's quick open does, using a port of VS Code's
own ranking. Type any letters of the name in order (`btn` finds `Button.tsx`); a
name that starts with what you typed comes first, then name matches, then
matches that need the folder. Include a `/` to match on the folder too
(`src/comp/button`), or separate words with spaces to require each one.
Files you opened recently are listed first, under **Recently opened**.
Add `:42` to open the file at line 42 (`app.ts:42`).

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
