/**
 * Which view the Files panel's side bar shows. Kept outside React so the
 * panel store and chat actions can switch it without the panel mounted.
 */
import * as Schema from "effect/Schema";

import { getLocalStorageItem, writeLocalStorageValue } from "./hooks/useLocalStorage";

export type WorkbenchSideBarView = "explorer" | "search" | "scm";

export const SIDE_BAR_VIEW_STORAGE_KEY = "t3code.workbenchSideBarView";
export const SideBarViewSchema = Schema.Literals(["explorer", "search", "scm"]);

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

export interface WorkbenchViewRequest {
  readonly view: WorkbenchSideBarView;
  /** Search only: expand the replace field. */
  readonly replace?: boolean;
  /** Text to search for, such as the editor's selection. */
  readonly query?: string;
}

const WORKBENCH_VIEW_REQUEST_EVENT = "t3code:workbench-view-request";
let pendingRequest: WorkbenchViewRequest | null = null;

/**
 * Shows a side bar view and puts the keyboard in it. The Files panel may not
 * be mounted yet (⇧⌘F opens it), so the request also waits for it.
 */
export function requestWorkbenchView(request: WorkbenchViewRequest): void {
  try {
    writeLocalStorageValue(SIDE_BAR_VIEW_STORAGE_KEY, request.view, SideBarViewSchema);
  } catch (error) {
    console.error(error);
  }
  pendingRequest = request;
  window.dispatchEvent(new CustomEvent(WORKBENCH_VIEW_REQUEST_EVENT));
}

/** Delivers requests to the mounted Files panel, including one sent before it mounted. */
export function subscribeWorkbenchViewRequests(
  listener: (request: WorkbenchViewRequest) => void,
): () => void {
  const deliver = () => {
    const request = pendingRequest;
    if (!request) return;
    pendingRequest = null;
    listener(request);
  };
  deliver();
  window.addEventListener(WORKBENCH_VIEW_REQUEST_EVENT, deliver);
  return () => window.removeEventListener(WORKBENCH_VIEW_REQUEST_EVENT, deliver);
}
