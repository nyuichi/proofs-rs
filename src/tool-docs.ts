import { documents } from "./tool-doc-content";
import { Fault, one } from "./core";
export function requireDocument(id: unknown): string {
  if (typeof id !== "string" || !Object.hasOwn(documents, id))
    throw new Fault(400, "invalid_tool_documentation");
  return id;
}
export async function documentationFor(
  db: D1Database,
  toolId: string,
  versionId?: string,
) {
  const binding = await one(
    db,
    `SELECT COALESCE((SELECT documentation_id FROM tool_version_documentation_bindings WHERE tool_version_id=?),(SELECT documentation_id FROM tool_documentation_bindings WHERE tool_id=?)) documentation_id`,
    versionId || "",
    toolId,
  );
  const id = binding?.documentation_id;
  if (!id || !Object.hasOwn(documents, id))
    throw new Fault(409, "tool_documentation_required");
  return { id, latest: documents[id].at(-1)!, revisions: documents[id] };
}
