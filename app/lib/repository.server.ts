import { ulid } from "ulid";

import {
  parsePublicationLabels,
  type PublicationLabels,
  type PublicationMetadata,
} from "./metadata";
import { normalizePublicationLabel } from "./publication-labels";
import type { SarifRoot } from "./sarif";

export const PUBLICATION_PAGE_SIZE = 20;
export const PUBLICATION_DAILY_LIMIT = 20;

export interface PublisherRecord {
  id: string;
  github_user_id: string;
  github_login: string;
  created_at: string;
}

export interface PublicationLabelRecord {
  publication_id: string;
  position: number;
  display_name: string;
  normalized_name: string;
}

export interface PublicationRecord extends Omit<PublicationMetadata, "labels"> {
  id: string;
  publisher_id: string;
  publisher_login: string;
  sarif_version: string;
  created_at: string;
  labels: PublicationLabelRecord[];
}

export interface SarifRunRecord {
  publication_id: string;
  run_index: number;
  run_json: string;
}

export interface PublicationWithRuns extends PublicationRecord {
  runs: SarifRunRecord[];
}

export interface PublicationListPage {
  publications: PublicationWithRuns[];
  nextCursor?: string;
}

export interface PublicationCreateInput {
  publisherId: string;
  metadata: PublicationMetadata;
  /**
   * Optional compatibility override for callers that keep labels outside the
   * metadata object. The parsed metadata labels are used by default.
   */
  labels?: PublicationLabels | readonly string[];
  sarif: SarifRoot;
  now?: Date;
}

export class PublicationRateLimitError extends Error {
  constructor() {
    super("A publisher may create at most 20 publications per UTC day.");
    this.name = "PublicationRateLimitError";
  }
}

export class PublicationNotFoundError extends Error {
  constructor(id: string) {
    super(`Publication '${id}' was not found.`);
    this.name = "PublicationNotFoundError";
  }
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(value: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string | null | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===";
    const binary = atob(padded.slice(0, padded.length - (padded.length % 4)));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).createdAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      return parsed as Cursor;
    }
  } catch {
    // Treat a malformed cursor as the first page rather than leaking SQL errors.
  }
  return undefined;
}

function utcDayBounds(now: Date): { start: string; end: string } {
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endDate = new Date(startDate.getTime() + 86_400_000);
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}

function mapPublication(row: Record<string, unknown>): PublicationRecord {
  return {
    id: String(row.id),
    publisher_id: String(row.publisher_id),
    publisher_login: String(row.publisher_login),
    message: String(row.message),
    crate_name: String(row.crate_name),
    crate_version: String(row.crate_version),
    upstream_repository: String(row.upstream_repository),
    upstream_commit: String(row.upstream_commit),
    upstream_path: String(row.upstream_path),
    verification_repository: String(row.verification_repository),
    verification_commit: String(row.verification_commit),
    verification_path: String(row.verification_path),
    sarif_version: String(row.sarif_version),
    created_at: String(row.created_at),
    labels: [],
  };
}

function mapPublicationLabel(row: Record<string, unknown>): PublicationLabelRecord {
  return {
    publication_id: String(row.publication_id),
    position: Number(row.position),
    display_name: String(row.display_name),
    normalized_name: String(row.normalized_name),
  };
}

async function loadRuns(db: D1Database, publicationIds: string[]): Promise<SarifRunRecord[]> {
  if (publicationIds.length === 0) {
    const result = await db
      .prepare("SELECT publication_id, run_index, run_json FROM sarif_runs WHERE 0")
      .all<SarifRunRecord>();
    return result.results;
  }
  const placeholders = publicationIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT publication_id, run_index, run_json
       FROM sarif_runs
       WHERE publication_id IN (${placeholders})
       ORDER BY publication_id ASC, run_index ASC`,
    )
    .bind(...publicationIds)
    .all<SarifRunRecord>();
  return result.results;
}

async function loadLabels(
  db: D1Database,
  publicationIds: string[],
): Promise<PublicationLabelRecord[]> {
  if (publicationIds.length === 0) {
    const result = await db
      .prepare("SELECT publication_id, position, display_name, normalized_name FROM publication_labels WHERE 0")
      .all<Record<string, unknown>>();
    return result.results.map(mapPublicationLabel);
  }
  const placeholders = publicationIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT publication_id, position, display_name, normalized_name
       FROM publication_labels
       WHERE publication_id IN (${placeholders})
       ORDER BY publication_id ASC, position ASC`,
    )
    .bind(...publicationIds)
    .all<Record<string, unknown>>();
  return result.results.map(mapPublicationLabel);
}

function attachChildren(
  rows: PublicationRecord[],
  runs: SarifRunRecord[],
  labels: PublicationLabelRecord[],
): PublicationWithRuns[] {
  const byPublication = new Map<string, SarifRunRecord[]>();
  for (const run of runs) {
    const existing = byPublication.get(run.publication_id);
    if (existing) existing.push(run);
    else byPublication.set(run.publication_id, [run]);
  }
  const labelsByPublication = new Map<string, PublicationLabelRecord[]>();
  for (const label of labels) {
    const existing = labelsByPublication.get(label.publication_id);
    if (existing) existing.push(label);
    else labelsByPublication.set(label.publication_id, [label]);
  }
  return rows.map((publication) => ({
    ...publication,
    runs: byPublication.get(publication.id) ?? [],
    labels: labelsByPublication.get(publication.id) ?? [],
  }));
}

const publicationSelect = `
  SELECT
    p.id, p.publisher_id, p.message, p.crate_name, p.crate_version,
    p.upstream_repository, p.upstream_commit, p.upstream_path,
    p.verification_repository, p.verification_commit, p.verification_path,
    p.sarif_version, p.created_at, pub.github_login AS publisher_login
  FROM publications AS p
  JOIN publishers AS pub ON pub.id = p.publisher_id
`;

/** Fetches one page, then loads all runs and immutable publication labels. */
export async function listPublications(
  db: D1Database,
  cursorValue?: string | null,
  pageSize = PUBLICATION_PAGE_SIZE,
): Promise<PublicationListPage> {
  const cursor = decodeCursor(cursorValue);
  const requested = Math.min(Math.max(pageSize, 1), PUBLICATION_PAGE_SIZE) + 1;
  const where = cursor
    ? "WHERE (p.created_at < ? OR (p.created_at = ? AND p.id < ?))"
    : "";
  const parameters = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id, requested] : [requested];
  const publicationResult = await db
    .prepare(
      `${publicationSelect}
       ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(...parameters)
    .all<Record<string, unknown>>();

  const hasMore = publicationResult.results.length > requested - 1;
  const pageRows = (hasMore ? publicationResult.results.slice(0, -1) : publicationResult.results).map(
    mapPublication,
  );
  const runs = await loadRuns(db, pageRows.map((publication) => publication.id));
  const labels = await loadLabels(db, pageRows.map((publication) => publication.id));
  const last = pageRows.at(-1);
  return {
    publications: attachChildren(pageRows, runs, labels),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : undefined,
  };
}

export async function getPublication(db: D1Database, id: string): Promise<PublicationWithRuns | null> {
  const result = await db.prepare(`${publicationSelect} WHERE p.id = ?`).bind(id).all<Record<string, unknown>>();
  const row = result.results[0];
  if (!row) return null;
  const publication = mapPublication(row);
  const runs = await loadRuns(db, [id]);
  const labels = await loadLabels(db, [id]);
  return attachChildren([publication], runs, labels)[0] ?? null;
}

export async function getPublisherById(db: D1Database, id: string): Promise<PublisherRecord | null> {
  const result = await db
    .prepare("SELECT id, github_user_id, github_login, created_at FROM publishers WHERE id = ?")
    .bind(id)
    .first<PublisherRecord>();
  return result ?? null;
}

export async function upsertPublisher(
  db: D1Database,
  githubUserId: string,
  githubLogin: string,
  now = new Date(),
): Promise<PublisherRecord> {
  const existing = await db
    .prepare("SELECT id, github_user_id, github_login, created_at FROM publishers WHERE github_user_id = ?")
    .bind(githubUserId)
    .first<PublisherRecord>();
  if (existing) {
    await db.prepare("UPDATE publishers SET github_login = ? WHERE id = ?").bind(githubLogin, existing.id).run();
    return { ...existing, github_login: githubLogin };
  }
  const record: PublisherRecord = {
    id: ulid(),
    github_user_id: githubUserId,
    github_login: githubLogin,
    created_at: now.toISOString(),
  };
  await db
    .prepare("INSERT INTO publishers (id, github_user_id, github_login, created_at) VALUES (?, ?, ?, ?)")
    .bind(record.id, record.github_user_id, record.github_login, record.created_at)
    .run();
  return record;
}

export async function createPublication({
  db,
  publisherId,
  metadata,
  labels: labelsOverride,
  sarif,
  now = new Date(),
}: PublicationCreateInput & { db: D1Database }): Promise<string> {
  const labels = parsePublicationLabels(labelsOverride ?? metadata.labels ?? []);
  const { start, end } = utcDayBounds(now);
  const countResult = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM publications WHERE publisher_id = ? AND created_at >= ? AND created_at < ?",
    )
    .bind(publisherId, start, end)
    .first<{ count: number | string }>();
  if (Number(countResult?.count ?? 0) >= PUBLICATION_DAILY_LIMIT) {
    throw new PublicationRateLimitError();
  }

  const publicationId = ulid();
  const createdAt = now.toISOString();
  const insert = db
    .prepare(
      `INSERT INTO publications (
        id, publisher_id, message, crate_name, crate_version,
        upstream_repository, upstream_commit, upstream_path,
        verification_repository, verification_commit, verification_path,
        sarif_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM publications
        WHERE publisher_id = ? AND created_at >= ? AND created_at < ?
      ) < ?`,
    )
    .bind(
      publicationId,
      publisherId,
      metadata.message,
      metadata.crate_name,
      metadata.crate_version,
      metadata.upstream_repository,
      metadata.upstream_commit,
      metadata.upstream_path,
      metadata.verification_repository,
      metadata.verification_commit,
      metadata.verification_path,
      sarif.version,
      createdAt,
      publisherId,
      start,
      end,
      PUBLICATION_DAILY_LIMIT,
    );
  const runStatements = sarif.runs.map((run, runIndex) =>
    db
      .prepare("INSERT INTO sarif_runs (publication_id, run_index, run_json) VALUES (?, ?, ?)")
      .bind(publicationId, runIndex, JSON.stringify(run)),
  );
  const labelStatements = labels.map((label, position) =>
    db
      .prepare(
        "INSERT INTO publication_labels (publication_id, position, display_name, normalized_name) VALUES (?, ?, ?, ?)",
      )
      .bind(publicationId, position, label, normalizePublicationLabel(label)),
  );

  try {
    const results = await db.batch([insert, ...runStatements, ...labelStatements]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw new PublicationRateLimitError();
  } catch (error) {
    if (error instanceof PublicationRateLimitError) throw error;
    throw error;
  }
  return publicationId;
}
