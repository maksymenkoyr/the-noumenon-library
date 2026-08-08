"use client";

import { useEffect } from "react";
import { signalPageArrived } from "./introSignal";

/**
 * Rendered once inside CommittedPage: fires the moment the real page is on
 * screen (whether that took 8-32s of generation or was instant on a cached
 * revisit), so Intro knows to leave its idle loop and play the opening
 * sequence. No DOM of its own.
 */
export function PageArrivedSignal() {
  useEffect(() => {
    signalPageArrived();
  }, []);
  return null;
}
