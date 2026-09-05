import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

// Protect-by-default: everything requires auth except this explicit
// allowlist. /r is the public NFC landing page — customers reach it by
// tapping a physical card, never signed in. /api/e2e-config-check is a
// test-only diagnostic endpoint (round-2 finding R2-06) that must be
// reachable without a session — Playwright's global setup checks it before
// any test runs, and it returns only the already-public
// NEXT_PUBLIC_SUPABASE_URL. Update this when new public routes are added
// (e.g. a marketing home page).
const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/auth",
  "/r",
  "/api/e2e-config-check",
  // Round-3 R3-03: the notification-email confirmation link is clicked
  // from an email, possibly in a browser/device with no session at all.
  "/api/notification-email/confirm",
  // Stripe's servers call this with no session at all -- the webhook's own
  // signature check (app/api/webhooks/stripe/route.ts) is the real
  // security boundary here, not this allowlist.
  "/api/webhooks/stripe",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export async function proxy(request: NextRequest) {
  // Forwarded as a request header so Server Components (the dashboard
  // layout's billing paywall, specifically -- see
  // app/dashboard/layout.tsx) can read the current path via next/headers,
  // which has no other way to know it. Next.js's own documented recipe
  // for this: a new Headers instance, not a mutation of request.headers
  // (which throws in some runtimes).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  let supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the session cookie; also protects against reading a stale
  // session from a Server Component (auth cannot be trusted without this).
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims.sub && !isPublicPath(request.nextUrl.pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - image files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
