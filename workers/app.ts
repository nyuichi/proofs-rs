import { createRequestHandler } from "react-router";

import { withSecurityHeaders } from "../app/lib/security.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    const response = await requestHandler(request);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
