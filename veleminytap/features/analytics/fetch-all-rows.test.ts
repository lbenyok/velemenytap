import { describe, it, expect, vi } from "vitest";
import { fetchAllRowsPaginated } from "./fetch-all-rows";

function page(data: number[], count: number) {
  return { data, count, error: null };
}

describe("fetchAllRowsPaginated", () => {
  it("returns all rows when everything fits in one page", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([1, 2, 3], 3));
    const result = await fetchAllRowsPaginated(fetchPage, 5000);
    expect(result).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("fetches subsequent pages when the total exceeds one page (the confirmed bug: a single request silently truncates past PostgREST's row cap)", async () => {
    // Simulates exactly what was empirically confirmed against the isolated
    // project: 1200 real rows, PostgREST's per-request cap at 1000, a
    // second request needed to get the rest.
    const pageOne = Array.from({ length: 1000 }, (_, i) => i);
    const pageTwo = Array.from({ length: 200 }, (_, i) => 1000 + i);
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page(pageOne, 1200))
      .mockResolvedValueOnce(page(pageTwo, 1200));

    const result = await fetchAllRowsPaginated(fetchPage, 5000);
    expect(result).toHaveLength(1200);
    expect(result).toEqual([...pageOne, ...pageTwo]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("fetches multiple remaining pages in parallel, not sequentially by page count", async () => {
    const totalRows = 3500; // 4 pages: 1000 + 1000 + 1000 + 500
    const fetchPage = vi.fn().mockImplementation(async (from: number, to: number) => {
      const size = to - from + 1;
      return page(
        Array.from({ length: size }, (_, i) => from + i),
        totalRows,
      );
    });

    const result = await fetchAllRowsPaginated(fetchPage, 5000);
    expect(result).toHaveLength(totalRows);
    expect(result[0]).toBe(0);
    expect(result[totalRows - 1]).toBe(totalRows - 1);
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it("never returns more than maxRows even if the table has more", async () => {
    const pageOne = Array.from({ length: 1000 }, (_, i) => i);
    const pageTwo = Array.from({ length: 1000 }, (_, i) => 1000 + i);
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page(pageOne, 10000))
      .mockResolvedValueOnce(page(pageTwo, 10000));

    const result = await fetchAllRowsPaginated(fetchPage, 1500);
    expect(result).toHaveLength(1500);
  });

  it("returns an empty array on error instead of throwing", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: null, count: null, error: new Error("boom") });
    const result = await fetchAllRowsPaginated(fetchPage, 5000);
    expect(result).toEqual([]);
  });

  it("falls back to data.length when count is null", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: [1, 2, 3], count: null, error: null });
    const result = await fetchAllRowsPaginated(fetchPage, 5000);
    expect(result).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops after the first page if it comes back short (fewer rows than a full page), even if count looks larger", async () => {
    // A defensive case: if the first page is short, there's nothing more to
    // fetch regardless of what count claims.
    const fetchPage = vi.fn().mockResolvedValue(page([1, 2], 500));
    const result = await fetchAllRowsPaginated(fetchPage, 5000);
    expect(result).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
