import { startGitHubOAuth, type AuthEnv } from "../lib/auth.server";
import type { Route } from "./+types/auth-github";

import { env } from "cloudflare:workers";

export async function loader({ request }: Route.LoaderArgs) {
  return startGitHubOAuth(request, env as AuthEnv);
}
