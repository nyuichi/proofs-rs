import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Route } from "./+types/home";
import { listPublications } from "../lib/repository.server";
import { relativeTime, splitPublicationMessage } from "../lib/presentation";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return listPublications(env.DB, url.searchParams.get("cursor"));
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

export default function Home({ loaderData }: Route.ComponentProps) {
  const { publications, nextCursor } = loaderData;

  return (
    <main className="page-shell home-page">
      <section className="page-heading">
        <h1>Publications</h1>
      </section>

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

      {nextCursor ? (
        <div className="pagination">
          <Link
            className="outline-link"
            to={`/?cursor=${encodeURIComponent(nextCursor)}`}
          >
            Load more
          </Link>
        </div>
      ) : null}
    </main>
  );
}
