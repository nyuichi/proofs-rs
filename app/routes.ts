import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("publications/:id", "routes/publication.tsx"),
  route("crates/:name", "routes/crate.tsx"),
  route("results/:id", "routes/result.tsx"),
  route("demo", "routes/demo.tsx"),
  route("publish", "routes/publish.tsx"),
  route("auth/github", "routes/auth-github.ts"),
  route("auth/github/callback", "routes/auth-github-callback.ts"),
  route("logout", "routes/logout.ts"),
] satisfies RouteConfig;

