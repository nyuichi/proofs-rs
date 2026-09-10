import { createRequestHandler } from "react-router";

import { assertSameOrigin } from "../app/lib/auth.server";
import { withSecurityHeaders } from "../app/lib/security.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      try { assertSameOrigin(request, env); }
      catch (error) { if (error instanceof Response) return withSecurityHeaders(error); throw error; }
    }
    const response = await requestHandler(request);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;

