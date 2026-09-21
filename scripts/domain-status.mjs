// Read-only diagnostics. DNS records and nameservers are never changed here.
import { appendFile } from "node:fs/promises";
const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
const r = await fetch(
  "https://api.cloudflare.com/client/v4/zones?name=proofs.rs&account.id=" +
    encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID),
  { headers },
);
const d = await r.json();
let summary;
if (!r.ok || !d.success)
  summary =
    "Domain status could not be read with the deployment token. Add/check proofs.rs in Cloudflare dashboard. Zone Read permission is needed for this diagnostic.";
else if (!d.result.length)
  summary =
    "proofs.rs has not been added to this Cloudflare account. Add it using the Free website plan; preserve existing mail DNS records, then set the assigned nameservers at Istanco.";
else
  summary = d.result
    .map(
      (z) =>
        `Domain: ${z.name}; status: ${z.status}; assigned nameservers: ${(z.name_servers || []).join(", ")}`,
    )
    .join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, "\n" + summary + "\n");
