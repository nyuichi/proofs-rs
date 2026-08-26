import { destroySession, assertSameOrigin, type AuthEnv } from "../lib/auth.server";
import type { Route } from "./+types/logout";

import { env } from "cloudflare:workers";

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request, env as AuthEnv);
  return destroySession(request, env.DB);
}

export async function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export default function Logout() {
  return null;
}
