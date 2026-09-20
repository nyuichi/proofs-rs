const origin = process.argv[2];
if (!origin?.startsWith("https://")) throw Error("Expected staging URL");
for (const path of [
  "/",
  "/api/v1/health",
  "/api/v1/home",
  "/api/v1/crates",
  "/api/v1/tools",
  "/api/v1/me",
  "/api/v1/config",
]) {
  const r = await fetch(origin + path);
  if (!r.ok) throw Error(path + " returned " + r.status);
  if (!r.headers.get("x-robots-tag")?.includes("noindex"))
    throw Error("Missing staging noindex header");
  if (path === "/api/v1/config") {
    const config = await r.json();
    console.log(
      "Integration configuration: OAuth=" +
        config.oauth_configured +
        ", email=" +
        config.email_configured,
    );
  }
  console.log("OK " + path);
}
