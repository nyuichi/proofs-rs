import { readFile, writeFile, appendFile } from "node:fs/promises";
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token)
  throw Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
async function api(path, method = "GET", body) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const d = await r.json();
  if (!r.ok || !d.success)
    throw Error(`Cloudflare ${method} ${path}: ${JSON.stringify(d.errors)}`);
  return d.result;
}
async function pages(path) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api(`${path}?page=${page}&per_page=100`);
    all.push(...result);
    if (result.length < 100) return all;
  }
  throw Error("Resource pagination limit exceeded");
}
const config = JSON.parse(await readFile("wrangler.json", "utf8"));
const databases = await pages("/d1/database");
let database = databases.find(
  (x) => x.name === config.d1_databases[0].database_name,
);
if (!database)
  database = await api("/d1/database", "POST", {
    name: config.d1_databases[0].database_name,
  });
config.d1_databases[0].database_id = database.uuid;
const buckets = await api("/r2/buckets");
if (!buckets.buckets.some((x) => x.name === config.r2_buckets[0].bucket_name))
  await api("/r2/buckets", "POST", { name: config.r2_buckets[0].bucket_name });
const queues = await pages("/queues");
for (const name of new Set([
  ...config.queues.producers.map((x) => x.queue),
  ...config.queues.consumers.flatMap((x) => [x.queue, x.dead_letter_queue]),
]))
  if (!queues.some((x) => x.queue_name === name))
    await api("/queues", "POST", { queue_name: name });
const domain = await api("/workers/subdomain");
if (!domain.subdomain)
  throw Error("Enable a workers.dev subdomain in Cloudflare.");
config.vars.APP_ORIGIN = `https://${config.name}.${domain.subdomain}.workers.dev`;
config.vars.CLOUDFLARE_ACCOUNT_ID = account;
config.vars.DB_ID = database.uuid;
for (const name of [
  "GITHUB_CLIENT_ID",
  "EMAIL_FROM",
  "EMAIL_ALLOWLIST",
  "EMAIL_DOMAIN",
  "EMAIL_EVENT_SUBSCRIPTION",
  "ADMIN_GITHUB_IDS",
])
  if (process.env[name]) config.vars[name] = process.env[name];
if (config.vars.EMAIL_FROM)
  config.send_email = [
    {
      name: "EMAIL",
      allowed_sender_addresses: [config.vars.EMAIL_FROM],
      allowed_destination_addresses: config.vars.EMAIL_ALLOWLIST.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    },
  ];
await writeFile("wrangler.staging.json", JSON.stringify(config, null, 2));
console.log("Staging URL: " + config.vars.APP_ORIGIN);
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    "url=" + config.vars.APP_ORIGIN + "\n",
  );
