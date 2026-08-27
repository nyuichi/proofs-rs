export const PUBLICATION_PAGE_SIZE = 20;
export const PAGINATION_ELLIPSIS = "ellipsis" as const;

export type PaginationItem = number | typeof PAGINATION_ELLIPSIS;

export class InvalidPageParamError extends Error {
  constructor() {
    super("The page parameter must be a positive safe integer.");
    this.name = "InvalidPageParamError";
  }
}

/** Parse the optional page query parameter without coercing ambiguous values. */
export function parsePageParam(url: URL): number {
  const values = url.searchParams.getAll("page");
  if (values.length === 0) return 1;
  if (values.length !== 1) throw new InvalidPageParamError();

  const value = values[0];
  if (!value || !/^[1-9]\d*$/.test(value)) throw new InvalidPageParamError();

  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) throw new InvalidPageParamError();
  return page;
}

/**
 * Build the compact page-number sequence used by the list pager.
 * A gap of one page is kept visible rather than replaced by an ellipsis.
 */
export function getPaginationItems(
  currentPage: number,
  totalPages: number,
  siblingCount: number,
): PaginationItem[] {
  if (totalPages < 1) return [];

  const pages = new Set<number>([1, totalPages]);
  const firstSibling = Math.max(1, currentPage - Math.max(0, siblingCount));
  const lastSibling = Math.min(totalPages, currentPage + Math.max(0, siblingCount));
  for (let page = firstSibling; page <= lastSibling; page += 1) pages.add(page);

  const sortedPages = [...pages].sort((left, right) => left - right);
  const items: PaginationItem[] = [];
  for (const [index, page] of sortedPages.entries()) {
    if (index > 0) {
      const previous = sortedPages[index - 1];
      const gap = page - previous;
      if (gap === 2) items.push(previous + 1);
      else if (gap > 2) items.push(PAGINATION_ELLIPSIS);
    }
    items.push(page);
  }
  return items;
}
