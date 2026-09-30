const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  // Monaco's input can be an EditContext element rather than a textarea.
  ".monaco-editor",
].join(",");

/**
 * Whether a text-editing element owns the keyboard. Shortcuts that share
 * their chord with native editing (mod+z) must yield when this is true.
 */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Whether a code editor (a file or diff in the Files panel) owns the keyboard.
 * VS Code's editor shortcuts (⌘D, ⌘[, ⌘K chords, ⇧⌘K…) win over the app's then.
 */
export function isCodeEditorFocused(target: EventTarget | null = document.activeElement): boolean {
  return target instanceof Element && target.closest(".monaco-editor") !== null;
}

/** Whether focus is inside the Files panel: its explorer, source control, or editor. */
export function isFilesPanelFocused(target: EventTarget | null = document.activeElement): boolean {
  return target instanceof Element && target.closest("[data-file-workbench]") !== null;
}
