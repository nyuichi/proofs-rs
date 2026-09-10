import { z } from 'zod';
import { ulid } from 'ulid';
import type { SarifRoot } from './sarif';
import type { PublicationMetadata } from './metadata';

const recordSchema = z.object({
  api_path: z.string().trim().min(1).max(500),
  api_kind: z.enum(['function', 'method']),
  tag: z.enum(['no-ub', 'no-panic']),
  contract: z.string().trim().min(1).max(4000),
  configuration: z.string().trim().min(1).max(1000),
  run_index: z.number().int().min(0),
  result_index: z.number().int().min(0),
  supersedes_id: z.string().optional(),
});
export type RecordInput = z.infer<typeof recordSchema>;
export const recordInputsSchema = z.array(recordSchema).max(200);
export class RecordValidationError extends Error {}
export interface VerificationRecord extends RecordInput {
  id: string;
  publication_id: string;
  publisher_login: string;
  created_at: string;
  crate_name: string;
  crate_version: string;
  tool_name: string;
  tool_version: string;
  evidence_message: string;
}
const select = `SELECT r.*, p.crate_name, p.crate_version, p.created_at, u.github_login AS publisher_login,
 coalesce(json_extract(s.run_json, '$.tool.driver.name'), 'Unknown tool') AS tool_name,
 coalesce(json_extract(s.run_json, '$.tool.driver.version'), '') AS tool_version,
 coalesce(json_extract(s.run_json, '$.results[' || r.result_index || '].message.text'), '') AS evidence_message
 FROM verification_records r JOIN publications p ON p.id=r.publication_id
 JOIN publishers u ON u.id=p.publisher_id
 JOIN sarif_runs s ON s.publication_id=r.publication_id AND s.run_index=r.run_index`;
export async function getRecord(db: D1Database, id: string) {
 return db.prepare(`${select} WHERE r.id=?`).bind(id).first<VerificationRecord>();
}
export async function getPublicationRecords(db: D1Database, id: string) {
 return (await db.prepare(`${select} JOIN publication_records m ON m.record_id=r.id WHERE m.publication_id=? ORDER BY m.position`).bind(id).all<VerificationRecord>()).results;
}
export async function recordHistory(db: D1Database, id: string) {
 const records: VerificationRecord[] = [];
 const seen = new Set<string>();
 while (id && !seen.has(id) && records.length < 100) {
  seen.add(id); const record = await getRecord(db, id); if (!record) break;
  records.push(record); id = record.supersedes_id ?? '';
 }
 return records;
}
export async function prepareRecordStatements(db: D1Database, publicationId: string, metadata: PublicationMetadata, sarif: SarifRoot, input: unknown = [], inherited: string[] = []) {
 const records = recordInputsSchema.parse(input);
 if (records.length + inherited.length > 200 || new Set(inherited).size !== inherited.length) throw new RecordValidationError('Use at most 200 distinct results.');
 const statements: D1PreparedStatement[] = [];
 const imported = new Map<string, VerificationRecord>();
 for (const id of new Set([...inherited, ...records.flatMap(r => r.supersedes_id ? [r.supersedes_id] : [])])) {
  const original = await getRecord(db, id);
  if (!original || original.crate_name !== metadata.crate_name || original.crate_version !== metadata.crate_version) throw new RecordValidationError('Referenced results must belong to this exact crate and version.');
  imported.set(id, original);
 }
 let position = 0;
 const membership = (id: string) => db.prepare('INSERT INTO publication_records (publication_id, record_id, position) VALUES (?, ?, ?)').bind(publicationId,id,position++);
 for (const id of inherited) statements.push(membership(id));
 for (const record of records) {
  const run = sarif.runs[record.run_index];
  const result = run?.results?.[record.result_index];
  if (!result || result.kind === 'fail' || result.kind === 'notApplicable' || result.level === 'error') throw new RecordValidationError('Select supporting evidence, not a failed result.');
  // A publisher explicitly asserts visibility, target and contract; SARIF alone cannot establish them.
  if (record.supersedes_id) {
   const parent = imported.get(record.supersedes_id)!;
   if (parent.api_path !== record.api_path || parent.tag !== record.tag || parent.api_kind !== record.api_kind) throw new RecordValidationError('An update must keep the same API and tag as its source.');
   if (inherited.includes(parent.id)) throw new RecordValidationError('Do not both retain and replace the same result.');
  }
  const id=ulid();
  statements.push(db.prepare(`INSERT INTO verification_records
   (id, publication_id, api_path, api_kind, tag, contract, configuration, run_index, result_index, supersedes_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id,publicationId,record.api_path,record.api_kind,record.tag,record.contract,record.configuration,record.run_index,record.result_index,record.supersedes_id ?? null));
  statements.push(membership(id));
 }
 return statements;
}
