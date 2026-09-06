import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `setOnboardingTourStatusAction`'s zero-affected-row disambiguation
 * (`actions.ts`'s own comment explains the branches) has no black-box e2e
 * hook for most of its own decision points: the UPDATE and the follow-up
 * read are two calls inside the same server-side function, milliseconds
 * apart, and a browser-driven test can only observe what comes out the
 * other end, not steer what either Supabase call returns mid-flight.
 * `e2e/onboarding-tour.spec.ts` still covers the externally-observable
 * outcomes that matter (a real UI flow ending in success or a real retry
 * prompt); these tests instead mock the two collaborators the action
 * itself calls (`getCurrentOrganization`, `createClient`) and drive each
 * of its branches directly and deterministically.
 *
 * The mock query builder below stands in for the real `@supabase/ssr`
 * client's chainable `.from().update().eq().neq().select()` /
 * `.from().select().eq().maybeSingle()` shapes -- just enough surface for
 * `actions.ts`'s own two call shapes, not a general-purpose Supabase mock.
 */

const { mockGetCurrentOrganization, mockFrom } = vi.hoisted(() => ({
  mockGetCurrentOrganization: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock("@/features/organizations/current", () => ({
  getCurrentOrganization: mockGetCurrentOrganization,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

import { setOnboardingTourStatusAction } from "./actions";

type QueryResult = { data: unknown; error: unknown };

/**
 * A chainable stand-in for one `supabase.from(...)` call. `.update`/
 * `.select`/`.eq`/`.neq` all return the same chain (matching the real
 * builder's fluent API); the chain resolves to `result` both when awaited
 * directly (the update-then-select call in `actions.ts` never calls a
 * terminal method, just `await`s the builder itself) and via
 * `.maybeSingle()` (the follow-up read's own terminal call).
 */
function chainable(result: QueryResult) {
  const chain: {
    update: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    neq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    then: (
      onFulfilled: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
  } = {
    update: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

const ORG = {
  id: 42,
  name: "Test Org",
  slug: "test-org",
  role: "owner" as const,
  onboardingTourStatus: "not_started" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentOrganization.mockResolvedValue(ORG);
});

describe("setOnboardingTourStatusAction", () => {
  it("rejects an invalid runtime status before any database call", async () => {
    const result = await setOnboardingTourStatusAction("hacked");

    expect(result).toEqual({ error: "Érvénytelen állapot." });
    expect(mockGetCurrentOrganization).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("returns an error when no organization is found for the caller", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({ error: "Nem található szervezet a fiókodhoz." });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("the update affecting exactly one row succeeds", async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: [{ onboarding_tour_status: "skipped" }], error: null }),
    );

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({});
    // Exactly one `.from()` call -- the follow-up read never runs when the
    // update itself already affected a row.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("the initial update returning a database error is reported as an error", async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: { message: "connection reset" } }));

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({ error: "Nem sikerült menteni az útmutató állapotát." });
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("zero rows, follow-up read confirms completed -> success (the guard's intended no-op)", async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: { onboarding_tour_status: "completed" }, error: null }));

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({});
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("zero rows, follow-up read shows not_started -> error (the WHERE clause should have matched)", async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: { onboarding_tour_status: "not_started" }, error: null }));

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({ error: "Nem sikerült menteni az útmutató állapotát." });
  });

  it("zero rows, follow-up read shows skipped when completed was requested -> error, not silently accepted", async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: { onboarding_tour_status: "skipped" }, error: null }));

    const result = await setOnboardingTourStatusAction("completed");

    expect(result).toEqual({ error: "Nem sikerült menteni az útmutató állapotát." });
  });

  it("zero rows, follow-up read finds no row at all -> error (unreadable or gone under this session's RLS)", async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }));

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({ error: "Nem sikerült menteni az útmutató állapotát." });
  });

  it("zero rows, follow-up read itself returns a database error -> error", async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: { message: "timeout" } }));

    const result = await setOnboardingTourStatusAction("skipped");

    expect(result).toEqual({ error: "Nem sikerült menteni az útmutató állapotát." });
  });
});
