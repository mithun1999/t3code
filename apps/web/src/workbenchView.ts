/**
 * Which view the Files panel's side bar shows. Kept outside React so the
 * panel store and chat actions can switch it without the panel mounted.
 */
import * as Schema from "effect/Schema";

import { getLocalStorageItem, writeLocalStorageValue } from "./hooks/useLocalStorage";

export type WorkbenchSideBarView = "explorer" | "scm";

export const SIDE_BAR_VIEW_STORAGE_KEY = "t3code.workbenchSideBarView";
export const SideBarViewSchema = Schema.Literals(["explorer", "scm"]);

export function readWorkbenchSideBarView(): WorkbenchSideBarView {
  try {
    return getLocalStorageItem(SIDE_BAR_VIEW_STORAGE_KEY, SideBarViewSchema) ?? "explorer";
  } catch {
    return "explorer";
  }
}

/** Switches the Files panel's side bar to Source Control, mounted or not. */
export function revealSourceControlView(): void {
  try {
    writeLocalStorageValue(SIDE_BAR_VIEW_STORAGE_KEY, "scm", SideBarViewSchema);
  } catch (error) {
    console.error(error);
  }
}
