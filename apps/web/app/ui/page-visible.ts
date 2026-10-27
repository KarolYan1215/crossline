/**
 * Whether anything of this page is on screen: the tab itself, or the 小帮手 pinned on the desktop (a Document Picture-in-Picture window
 * this page owns, helper-pet-client.tsx), which stays visible while the tab is in the background. The pollers ask this instead of the
 * tab's own visibility, so the pinned 小帮手 keeps its conversation and state current; a hidden tab with nothing pinned still asks nothing.
 */
let pinned = false;
export function setPinnedVisible(open: boolean): void { pinned = open; }
export function pageVisible(): boolean {
  return pinned || document.visibilityState === "visible";
}
