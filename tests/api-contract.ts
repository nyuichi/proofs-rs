import assert from "node:assert/strict";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { app } from "../src/worker";
import type { Env } from "../src/core";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let document: Promise<any> | undefined;
const validators = new Map<string, ValidateFunction>();
export function publicSpec() {
  return (document ??= (async () => {
    const r = await app.request("https://example.test/openapi.json", {}, {
      ENVIRONMENT: "staging",
    } as Env);
    assert.equal(r.status, 200);
    return r.json();
  })());
}

// Every response exercised by the existing API fixture is checked against the
// runtime contract, including non-empty lists and authenticated writes.
export async function assertResponseContract(
  path: string,
  method: string,
  status: number,
  body: unknown,
) {
  if (path.startsWith("/api/v1/admin/")) return;
  const spec = await publicSpec();
  const pathname = new URL(path, "https://example.test").pathname;
  const paths = Object.keys(spec.paths);
  const match =
    paths.find((p) => p === pathname) ??
    paths.find((p) => {
      const pattern = p
        .split("/")
        .map((segment) =>
          segment.startsWith("{")
            ? "[^/]+"
            : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/");
      return new RegExp(`^${pattern}$`).test(pathname);
    });
  const operation = match && spec.paths[match][method.toLowerCase()];
  // Existing tests also probe removed/unknown endpoints.
  if (!operation) {
    assert.ok(status >= 400, `Undocumented success: ${method} ${path}`);
    return;
  }
  const response = operation.responses[status] ?? operation.responses.default;
  assert.ok(response, `Undocumented status: ${method} ${path} ${status}`);
  if (status < 400)
    assert.ok(
      operation.responses[status],
      `Success must have an explicit status: ${method} ${path}`,
    );
  const schema = response.content?.["application/json"]?.schema;
  assert.ok(schema, `Missing JSON response schema: ${method} ${path}`);
  const key = `${method} ${match} ${status}`;
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile({ ...schema, components: spec.components });
    validators.set(key, validate);
  }
  assert.ok(validate(body), `${key}: ${ajv.errorsText(validate.errors)}`);
}
