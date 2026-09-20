import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const config = JSON.parse(await readFile("wrangler.staging.json", "utf8"));
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${config.name}/secrets`;
const headers = {
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
  "Content-Type": "application/json",
};
const r = await fetch(endpoint, { headers });
const data = await r.json();
if (!r.ok || !data.success) throw Error("Cannot list staging secret names");
const existing = new Set(data.result.map((s) => s.name));
const values = {};
if (!existing.has("TOKEN_SECRET"))
  values.TOKEN_SECRET =
    process.env.TOKEN_SECRET || randomBytes(32).toString("hex");
if (process.env.GITHUB_CLIENT_SECRET)
  values.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
if (process.env.CLOUDFLARE_D1_TOKEN)
  values.CLOUDFLARE_D1_TOKEN = process.env.CLOUDFLARE_D1_TOKEN;
for (const [name, text] of Object.entries(values)) {
  const response = await fetch(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({ name, text, type: "secret_text" }),
  });
  if (!response.ok) throw Error("Unable to set Worker secret " + name);
  console.log("Configured " + name);
}
