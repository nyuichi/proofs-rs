import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { App, Env, Fault, uid, requireUser } from "./core";
import { authenticate, authRoutes } from "./auth";
import api from "./api";
import { importRoutes } from "./imports";
import { queue, dispatch, backup } from "./jobs";
import { admin } from "./admin";
const app = new Hono<App>();
app.use("*", async (c, next) => {
  c.set("requestId", uid());
  await next();
  c.header("X-Request-ID", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (c.env.ENVIRONMENT !== "production")
    c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/"))
    c.header("Cache-Control", "no-store");
});
app.use(
  "*",
  bodyLimit({
    maxSize: 131072,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }),
);
app.use("/api/*", async (c, next) => {
  await authenticate(c);
  await next();
});
app.use("/auth/*", async (c, next) => {
  await authenticate(c);
  await next();
});
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("origin") !== c.env.APP_ORIGIN)
      throw new Fault(403, "invalid_origin");
    if (c.req.path !== "/api/v1/notifications/unsubscribe") {
      requireUser(c);
      if (c.req.header("X-CSRF-Token") !== c.get("csrf"))
        throw new Fault(403, "invalid_csrf");
      if (
        ![
          "/auth/logout",
          "/api/v1/me/terms-acceptance",
          "/api/v1/me/notification-preferences",
        ].includes(c.req.path) &&
        c.get("user")!.accepted_terms_version !== c.env.TERMS_VERSION
      )
        throw new Fault(428, "terms_required");
    }
  }
  await next();
});
app.use("/api/*", async (c, next) => {
  await next();
  if (
    c.env.JOBS &&
    c.req.method === "POST" &&
    c.res.ok &&
    (c.req.path.endsWith("/publish/prepare") ||
      c.req.path.endsWith("/comments"))
  )
    c.executionCtx.waitUntil(dispatch(c.env));
});
app.route("/auth", authRoutes());
app.route("/api/v1", api);
app.route("/api/v1", importRoutes);
app.route("/api/v1/admin", admin);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((e, c) => {
  if (e instanceof Fault)
    return c.json(
      { error: e.code, message: e.message, request_id: c.get("requestId") },
      e.status as any,
    );
  console.error(
    JSON.stringify({ request_id: c.get("requestId"), error: "internal_error" }),
  );
  return c.json(
    { error: "internal_error", request_id: c.get("requestId") },
    500,
  );
});
export default {
  fetch: app.fetch,
  queue,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(dispatch(env));
    if (controller.cron === "17 2 * * *") ctx.waitUntil(backup(env));
  },
};
export { app };
