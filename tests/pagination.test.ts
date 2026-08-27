import { describe, expect, it } from "vitest";

import {
  getPaginationItems,
  InvalidPageParamError,
  PAGINATION_ELLIPSIS,
  parsePageParam,
} from "../app/lib/pagination";

describe("publication page parameters", () => {
  it("defaults an absent page to the canonical first page", () => {
    expect(parsePageParam(new URL("https://proofs.example/"))).toBe(1);
  });

  it("accepts only one positive safe integer value", () => {
    expect(parsePageParam(new URL("https://proofs.example/?page=12"))).toBe(12);
    for (const value of ["", "0", "-1", "1.5", "1e2", "01", "9007199254740992"]) {
      expect(() => parsePageParam(new URL(`https://proofs.example/?page=${value}`))).toThrow(
        InvalidPageParamError,
      );
    }
    expect(() => parsePageParam(new URL("https://proofs.example/?page=2&page=2"))).toThrow(
      InvalidPageParamError,
    );
  });
});

describe("publication page number sequences", () => {
  it("keeps the single and boundary pages compact", () => {
    expect(getPaginationItems(1, 1, 2)).toEqual([1]);
    expect(getPaginationItems(1, 2, 2)).toEqual([1, 2]);
    expect(getPaginationItems(12, 12, 2)).toEqual([1, PAGINATION_ELLIPSIS, 10, 11, 12]);
  });

  it("keeps a one-page gap visible", () => {
    expect(getPaginationItems(1, 4, 1)).toEqual([1, 2, 3, 4]);
  });

  it("uses ellipses around a distant current page", () => {
    expect(getPaginationItems(6, 12, 2)).toEqual([
      1,
      PAGINATION_ELLIPSIS,
      4,
      5,
      6,
      7,
      8,
      PAGINATION_ELLIPSIS,
      12,
    ]);
    expect(getPaginationItems(6, 12, 1)).toEqual([
      1,
      PAGINATION_ELLIPSIS,
      5,
      6,
      7,
      PAGINATION_ELLIPSIS,
      12,
    ]);
  });

  it("keeps only one sibling on mobile-sized sequences", () => {
    expect(getPaginationItems(500, 1000, 1)).toEqual([
      1,
      PAGINATION_ELLIPSIS,
      499,
      500,
      501,
      PAGINATION_ELLIPSIS,
      1000,
    ]);
  });
});
