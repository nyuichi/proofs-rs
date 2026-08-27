import { env } from "cloudflare:workers";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/home";
import {
  InvalidPageParamError,
  getPaginationItems,
  PAGINATION_ELLIPSIS,
  parsePageParam,
  PUBLICATION_PAGE_SIZE,
} from "../lib/pagination";
import { listPublications } from "../lib/repository.server";
import { relativeTime, splitPublicationMessage } from "../lib/presentation";

function invalidPageResponse(): Response {
  return new Response("Invalid page parameter.", {
    status: 400,
    statusText: "Bad Request",
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  let page: number;
  try {
    page = parsePageParam(url);
  } catch (error) {
    if (error instanceof InvalidPageParamError) throw invalidPageResponse();
    throw error;
  }

  if (url.searchParams.has("page") && page === 1) throw redirect("/");

  const listing = await listPublications(env.DB, page);
  if (page > listing.totalPages) {
    throw new Response("Publication page not found.", {
      status: 404,
      statusText: "Not Found",
    });
  }
  return listing;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Publications · proofs.rs" },
    {
      name: "description",
      content: "Published verification records for Rust crates.",
    },
  ];
}

function pageHref(page: number): string {
  return page === 1 ? "/" : `/?page=${page}`;
}

function PageControl({
  direction,
  page,
  totalPages,
}: {
  direction: "previous" | "next";
  page: number;
  totalPages: number;
}) {
  const targetPage = direction === "previous" ? page - 1 : page + 1;
  const disabled = targetPage < 1 || targetPage > totalPages;
  const label = direction === "previous" ? "Prev" : "Next";
  const ariaLabel = direction === "previous" ? "Previous page" : "Next page";
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="pagination-control pagination-control-disabled"
      >
        {label}
      </span>
    );
  }
  return (
    <Link
      aria-label={ariaLabel}
      className="pagination-control"
      to={pageHref(targetPage)}
    >
      {label}
    </Link>
  );
}

function PageNumbers({
  currentPage,
  totalPages,
  siblingCount,
  variant,
}: {
  currentPage: number;
  totalPages: number;
  siblingCount: number;
  variant: "desktop" | "mobile";
}) {
  return (
    <div className={`pagination-pages pagination-pages-${variant}`}>
      {getPaginationItems(currentPage, totalPages, siblingCount).map((item, index) =>
        item === PAGINATION_ELLIPSIS ? (
          <span
            aria-hidden="true"
            className="pagination-ellipsis"
            key={`ellipsis-${index}`}
          >
            …
          </span>
        ) : item === currentPage ? (
          <span
            aria-current="page"
            className="pagination-page pagination-page-current"
            key={item}
          >
            {item}
          </span>
        ) : (
          <Link className="pagination-page" key={item} to={pageHref(item)}>
            {item}
          </Link>
        ),
      )}
    </div>
  );
}

function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Publication pages" className="pagination">
      <PageControl direction="previous" page={page} totalPages={totalPages} />
      <PageNumbers
        currentPage={page}
        siblingCount={2}
        totalPages={totalPages}
        variant="desktop"
      />
      <PageNumbers
        currentPage={page}
        siblingCount={1}
        totalPages={totalPages}
        variant="mobile"
      />
      <PageControl direction="next" page={page} totalPages={totalPages} />
    </nav>
  );
}

function publicationRange(page: number, totalCount: number): string {
  if (totalCount === 0) return "0 publications";
  const first = (page - 1) * PUBLICATION_PAGE_SIZE + 1;
  const last = Math.min(page * PUBLICATION_PAGE_SIZE, totalCount);
  return `${first}–${last} of ${totalCount} publications`;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { page, publications, totalCount, totalPages } = loaderData;

  return (
    <main className="page-shell home-page">
      <section className="page-heading">
        <h1>Publications</h1>
      </section>

      <p className="publication-range">{publicationRange(page, totalCount)}</p>

      {publications.length > 0 ? (
        <div className="publication-list" aria-label="Publications">
          {publications.map((publication) => {
            const { title } = splitPublicationMessage(publication.message);
            const shownLabels = publication.labels.slice(0, 3);
            const remainingLabelCount = publication.labels.length - shownLabels.length;
            return (
              <Link
                className="publication-row"
                key={publication.id}
                to={`/publications/${encodeURIComponent(publication.id)}`}
              >
                <div className="publication-row-grid">
                  <div className="publication-crate">
                    <span className="publication-crate-name">{publication.crate_name}</span>
                    <span className="publication-crate-version">{publication.crate_version}</span>
                  </div>
                  <div className="publication-row-info">
                    <p className="publication-title">{title}</p>
                    {shownLabels.length > 0 ? (
                      <div className="publication-labels" aria-label="Publication labels">
                        {shownLabels.map((label) => (
                          <span className="publication-label" key={label.position}>
                            {label.display_name}
                          </span>
                        ))}
                        {remainingLabelCount > 0 ? (
                          <span className="publication-label publication-label-more">
                            +{remainingLabelCount}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <span className="publication-byline">
                      by @{publication.publisher_login} <span aria-hidden="true">·</span>{" "}
                      <time
                        dateTime={publication.created_at}
                        suppressHydrationWarning
                      >
                        {relativeTime(publication.created_at)}
                      </time>
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <p>No publications yet.</p>
          <p className="muted">The first published verification record will appear here.</p>
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} />
    </main>
  );
}
