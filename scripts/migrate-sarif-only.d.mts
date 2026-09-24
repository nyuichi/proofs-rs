import type { Buffer } from "node:buffer";
export function convert(
  sarif: Record<string, any>,
  log: string,
  metadata: Record<string, any>,
  source: { repository: string; commit: string },
): { bytes: Buffer; metadata: Record<string, any> };
