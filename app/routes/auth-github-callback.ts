import { completeGitHubOAuth, type AuthEnv } from "../lib/auth.server";
import type { Route } from "./+types/auth-github-callback";

import { env } from "cloudflare:workers";

export async function loader({ request }: Route.LoaderArgs) {
  return completeGitHubOAuth(request, env as AuthEnv, env.DB);
}
