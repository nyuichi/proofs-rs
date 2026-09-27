import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist/book");
const version = spawnSync("mdbook", ["--version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== "mdbook v0.4.45") {
  throw new Error(
    "Install mdBook 0.4.45: cargo install mdbook --version 0.4.45 --locked",
  );
}
// Use an absolute destination: mdBook cleans it before rendering.
const build = spawnSync("mdbook", ["build", "book", "--dest-dir", output], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

// Preserve the site's CSP and script execution order without a custom mdBook theme.
const digest = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
for (const filename of readdirSync(output).filter((name) =>
  name.endsWith(".html"),
)) {
  const path = resolve(output, filename);
  let html = readFileSync(path, "utf8").replace(
    /<script>([\s\S]*?)<\/script>/g,
    (_, source) => {
      const name = `inline-${digest(source)}.js`;
      writeFileSync(resolve(output, name), source);
      return `<script src="/book/${name}"></script>`;
    },
  );
  // This is the default template's only inline style.
  html = html.replaceAll(
    '<div style="clear: both"></div>',
    '<div class="book-clear"></div>',
  );
  html = html.replace(
    "</head>",
    '<link rel="stylesheet" href="/book/csp.css">\n</head>',
  );
  if (/<script\b(?![^>]*\bsrc=)[^>]*>|\sstyle=/.test(html)) {
    throw new Error(
      `Unexpected inline script/style in ${filename}; review mdBook CSP compatibility`,
    );
  }
  writeFileSync(path, html);
}
writeFileSync(resolve(output, "csp.css"), ".book-clear { clear: both; }\n");
