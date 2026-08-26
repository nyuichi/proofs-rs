export const MAX_PUBLICATION_LABELS = 8;
export const MAX_PUBLICATION_LABEL_LENGTH = 32;

/** Stable folded value for per-publication duplicate checks and persistence. */
export function normalizePublicationLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}
