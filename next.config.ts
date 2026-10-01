import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    /*
     * `forbidden()` + `src/app/forbidden.tsx` is the repo-wide denial pattern for an
     * AUTHENTICATED caller who lacks permission (src/app/page.tsx, /tasks/[id],
     * /admin/users, /voice). Next gates `forbidden()` behind this flag: without it the call
     * threw E488 ("`forbidden()` is experimental...") instead of interrupting, so every
     * such denial surfaced as a 500 and the existing forbidden.tsx boundary was dead code.
     * Enabling the flag is what makes the intended 403 denial actually happen — it grants
     * nothing and weakens no guard; the guards above the call are untouched.
     */
    authInterrupts: true,
  },
};

export default nextConfig;
