import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Route } from "./+types/home";
import { listPublications } from "../lib/repository.server";
import {
  relativeTime,
  ruleIdsForPublication,
  splitPublicationMessage,
} from "../lib/presentation";

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
    <main className="page-shell">
      <section className="page-heading">
        <p className="eyebrow">Registry</p>
        <h1>Publications</h1>
        <p className="lede">Published verification records, newest first.</p>
      </section>

      {publications.length > 0 ? (
        <div className="publication-list" aria-label="Publications">
          {publications.map((publication) => {
            const { title } = splitPublicationMessage(publication.message);
            const ruleIds = ruleIdsForPublication(publication);
            const shownRules = ruleIds.slice(0, 3);
            return (
              <Link
                className="publication-row"
                key={publication.id}
                to={`/publications/${encodeURIComponent(publication.id)}`}
              >
                <div className="publication-row-head">
                  <span className="publication-subject">
                    {publication.crate_name} {publication.crate_version}
                  </span>
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
                <p className="publication-title">{title}</p>
                <div className="rule-preview" aria-label="Rules">
                  {shownRules.map((ruleId, index) => (
                    <code className="rule-preview-id" key={`${ruleId}-${index}`}>
                      [{ruleId}]
                    </code>
                  ))}
                  {ruleIds.length > shownRules.length ? (
                    <span className="rule-preview-more">
                      {ruleIds.length - shownRules.length} more rules
                    </span>
                  ) : null}
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
