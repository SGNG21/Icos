"use client";

import { useEffect } from "react";

/** Registers the offline-safe shell worker (public/sw.js). It never caches cockpit data. */
export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
