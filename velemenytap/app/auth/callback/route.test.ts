import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the emailed-auth-link callback.
 *
 * A real password-recovery link generated against the isolated Supabase
 * project came back in the implicit shape (`#access_token=...`), which a
 * server route can never read, and dead-ended on the error page. Which shape
 * Supabase actually sends depends on the project's email templates and on
 * whether the generating request registered a PKCE challenge -- neither of
 * which this route controls. So it now accepts BOTH server-readable shapes,
 * and these tests pin that down.
 */

vi.mock("server-only", () => ({}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession, verifyOtp } }),
}));

import { GET } from "./route";

function request(query: string) {
  return { nextUrl: new URL(`http://localhost:3000/auth/callback${query}`) } as never;
}

async function redirectedTo(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected the route to redirect, but it returned");
}

beforeEach(() => {
  vi.clearAllMocks();
  // safeRedirectTarget validates `next` against this origin, and falls back
  // to /dashboard when it is unset -- which would silently mask what these
  // tests are actually asserting about the redirect target.
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  exchangeCodeForSession.mockResolvedValue({ error: null });
  verifyOtp.mockResolvedValue({ error: null });
});

describe("GET /auth/callback", () => {
  it("exchanges a PKCE code and lands on next", async () => {
    const target = await redirectedTo(GET(request("?code=abc&next=/auth/reset-password")));
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(target).toBe("/auth/reset-password");
  });

  it("REGRESSION: also accepts the token_hash/type shape, which some templates send instead of a code", async () => {
    const target = await redirectedTo(GET(request("?token_hash=hash123&type=recovery&next=/auth/reset-password")));
    expect(verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "hash123" });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(target).toBe("/auth/reset-password");
  });

  it("falls back from a failed code exchange to a token_hash present on the same link", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    const target = await redirectedTo(GET(request("?code=stale&token_hash=hash123&type=recovery&next=/auth/reset-password")));
    expect(exchangeCodeForSession).toHaveBeenCalled();
    expect(verifyOtp).toHaveBeenCalled();
    expect(target).toBe("/auth/reset-password");
  });

  it("sends an invalid or already-used link to the error page rather than anywhere authenticated", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "expired" } });
    const target = await redirectedTo(GET(request("?code=expired&next=/auth/reset-password")));
    expect(target).toBe("/auth/auth-code-error");
  });

  it("an implicit-flow link carries its session in a fragment the server never receives -- error page, not a hang", async () => {
    // The fragment is not part of what reaches the server at all; this is
    // the request as the route actually sees it.
    const target = await redirectedTo(GET(request("?next=/auth/reset-password")));
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(target).toBe("/auth/auth-code-error");
  });

  it("never honours an off-site next, even with a valid code", async () => {
    const target = await redirectedTo(GET(request("?code=abc&next=https://evil.example.com")));
    expect(target).not.toContain("evil.example.com");
  });
});
