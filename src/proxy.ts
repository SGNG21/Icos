import { type NextRequest, NextResponse } from "next/server";

import { safeNextPath } from "./auth-navigation";

const SESSION_COOKIE_NAMES = ["icos.session_token", "__Secure-icos.session_token"] as const;

/** Redirection UX optimiste ; l'autorisation réelle reste dans les composants serveur. */
export function proxy(request: NextRequest): NextResponse {
  if (
    request.nextUrl.pathname === "/login" ||
    SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))
  ) {
    return NextResponse.next();
  }

  const destination = safeNextPath(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", destination);
  return NextResponse.redirect(loginUrl);
}

/**
 * PWA shell assets are exempt: they carry no ICOS data and must load before a
 * session exists (install prompt, offline page, service worker). Anchored with
 * `$` or `/` so no application route can hide behind a look-alike prefix.
 */
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest$|sw.js$|offline.html$|icon/|apple-icon).*)",
  ],
};
