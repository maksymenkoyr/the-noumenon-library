/**
 * A tiny external store signaling "the real page is on screen," shared
 * between PageArrivedSignal (mounted inside CommittedPage, fires it) and
 * Intro (subscribes, to hand off from the idle loop to the opening sequence).
 *
 * Module-scope state, reset by construction every page load: navigation here
 * is full page loads (nav.tsx), so this module is always freshly imported.
 */

let arrived = false;
const listeners = new Set<() => void>();

export function signalPageArrived(): void {
  if (arrived) return;
  arrived = true;
  for (const listener of listeners) listener();
}

export function subscribePageArrived(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function getPageArrivedSnapshot(): boolean {
  return arrived;
}

export function getPageArrivedServerSnapshot(): boolean {
  return false;
}
