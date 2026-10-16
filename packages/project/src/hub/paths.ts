import { join } from "node:path";

/** Canonical adopted external repository root for one Hub source. */
export function adoptedSourcePath(hubDir: string, sourceId: string): string {
  return join(hubDir, "external", sourceId, "repo");
}
