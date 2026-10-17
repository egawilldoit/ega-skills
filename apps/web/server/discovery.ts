/**
 * Pinned synthetic-intent inspection (EGA-728).
 *
 * Read-only, digest-bound inspection of one synthetic evaluation case. The
 * report is a committed build artifact (`discovery-report.json` beside the
 * verified release); it is never regenerated here and never reads production
 * telemetry or user prompts.
 *
 * A missing report, a missing release identity, or a report whose evaluated
 * digest does not equal the console's served release digest is refused. There
 * is no fallback to a previous or cached report.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getReleaseIdentityBinding } from "./release-identity.ts";
import type { ServerConfig } from "./env.ts";

export class DiscoveryInspectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DiscoveryInspectionError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Read and validate the pinned report against the served release.
 *
 * Returns the parsed report object verbatim (plus the verified digest) so the
 * UI can render its case without a second authority. The digest check is the
 * only gate: a report that names a different release is refused as a conflict.
 */
export function getDiscoveryInspection(config: ServerConfig): Record<string, unknown> {
  const binding = getReleaseIdentityBinding(config);
  if (binding.identity === null) {
    throw new DiscoveryInspectionError(
      503,
      "E_WEB_DISCOVERY_RELEASE_UNAVAILABLE",
      binding.unavailable_reason ?? "No verified release identity is available, so the inspection report cannot be attributed.",
    );
  }
  const servedDigest = binding.identity.release_digest;
  if (binding.identity.status === "mismatch") {
    throw new DiscoveryInspectionError(
      409,
      "E_WEB_DISCOVERY_RELEASE_MISMATCH",
      binding.identity.mismatch_reason ?? "The served release does not match its expected identity.",
    );
  }

  if (config.artifactDir === null) {
    throw new DiscoveryInspectionError(
      503,
      "E_WEB_DISCOVERY_REPORT_UNAVAILABLE",
      "No artifact directory is configured, so no inspection report is available.",
    );
  }
  const reportPath = join(config.artifactDir, "discovery-report.json");
  if (!existsSync(reportPath)) {
    throw new DiscoveryInspectionError(
      404,
      "E_WEB_DISCOVERY_REPORT_UNAVAILABLE",
      "No pinned inspection report is present in this deployment's artifact.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    throw new DiscoveryInspectionError(
      503,
      "E_WEB_DISCOVERY_REPORT_UNAVAILABLE",
      "The pinned inspection report could not be read.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DiscoveryInspectionError(
      503,
      "E_WEB_DISCOVERY_REPORT_UNAVAILABLE",
      "The pinned inspection report is not a JSON object.",
    );
  }
  const report = parsed as Record<string, unknown>;

  const evaluated =
    report["release_digest"] ??
    report["evaluated_release_digest"] ??
    report["evaluated_catalog_digest"] ??
    report["catalog_release_digest"] ??
    report["artifact_digest"];
  if (typeof evaluated !== "string" || evaluated !== servedDigest) {
    throw new DiscoveryInspectionError(
      409,
      "E_WEB_DISCOVERY_RELEASE_MISMATCH",
      "The inspection report's evaluated release digest does not match the release this console is serving, so it is refused.",
    );
  }

  return Object.freeze({ ...report, served_release_digest: servedDigest });
}
