import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Form,
  Link,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

import { env } from "cloudflare:workers";

import type { Route } from "./+types/root";
import { getOptionalPublisher } from "./lib/auth.server";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const publisher = await getOptionalPublisher(request, env.DB);
  return {
    publisher: publisher
      ? { github_login: publisher.github_login }
      : null,
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { publisher } = useLoaderData<typeof loader>();

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="brand" to="/" aria-label="proofs.rs home">
            proofs.rs
          </Link>
          <nav className="primary-nav" aria-label="Primary navigation">
            <NavLink
              end
              to="/"
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              Publications
            </NavLink>
            <NavLink
              to="/publish"
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              Publish
            </NavLink>
          </nav>
          <div className="auth-area">
            {publisher ? (
              <Form method="post" action="/logout">
                <button className="auth-button" type="submit">
                  @{publisher.github_login} <span aria-hidden="true">·</span> Log out
                </button>
              </Form>
            ) : (
              <a className="auth-button" href="/auth/github">
                Log in with GitHub
              </a>
            )}
          </div>
        </div>
      </header>
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="page-shell error-page">
      <p className="eyebrow">proofs.rs</p>
      <h1>{message}</h1>
      <p className="error-message">{details}</p>
      <Link className="text-link" to="/">
        ← Back to publications
      </Link>
      {stack && (
        <pre className="error-stack">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
