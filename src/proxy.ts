import { type NextRequest, NextResponse } from "next/server";

import { safeNextPath } from "./auth-navigation";

const SESSION_COOKIE_NAME = "icos.session_token";

/** Redirection UX optimiste ; l'autorisation réelle reste dans les composants serveur. */
export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === "/login" || request.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.next();
  }

  const destination = safeNextPath(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", destination);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
