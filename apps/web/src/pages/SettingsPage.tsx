import type { ReactNode } from "react";

import { API_BASE_PATH } from "../api/client";
import { describeReleaseStatus } from "../components/ReleaseStatus";
import { Field } from "../components/DataTable";
import { supabaseConfigured, supabaseConfigurationIssue } from "../auth/supabase";
import { useAuth } from "../auth/AuthProvider";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * `/settings` — read-only deployment and session diagnostics.
 *
 * Deliberately not a settings form. This console is read-only: there is no
 * write path anywhere in it, so nothing on this page can be changed. Every value
 * shown is read from live client state or from the build-time configuration, and
 * each is labelled with where it comes from so an operator can tell a real
 * value from a default.
 */
export function SettingsPage(): ReactNode {
  const { status, userId, email, configurationIssue } = useAuth();
  const { workspaceId, state, role, stateLabel, can } = useWorkspace();

  return (
    <>
      <section className="panel" aria-labelledby="settings-session">
        <h2 id="settings-session">Session</h2>
        <dl className="fields">
          <Field label="Session status" mono>
            {status}
          </Field>
          <Field label="Subject" mono>
            {userId ?? "No authenticated subject"}
          </Field>
          <Field label="Email" mono>
            {email ?? "Not recorded by the identity provider"}
          </Field>
          <Field label="Auth method">First-party Supabase user session (password or provider, PKCE)</Field>
        </dl>
        <p className="page__lede">
          This console never uses EGA delegated OAuth. A delegated session carries a{" "}
          <span className="mono">client_id</span> claim and would read zero control-plane rows
          under the restrictive policy in{" "}
          <span className="mono">202609180001_delegated_oauth_containment.sql</span>.
        </p>
      </section>

      <section className="panel" aria-labelledby="settings-build">
        <h2 id="settings-build">Build configuration</h2>
        <dl className="fields">
          <Field label="Supabase configured" mono>
            {supabaseConfigured ? "Yes" : "No"}
          </Field>
          <Field label="Configuration issue" mono>
            {configurationIssue ?? supabaseConfigurationIssue() ?? "None"}
          </Field>
          <Field label="API base path" mono>
            {API_BASE_PATH}
          </Field>
          <Field label="Secrets in this bundle" mono>
            None. Only VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are inlined by
            Vite, and neither is a secret.
          </Field>
        </dl>
      </section>

      <section className="panel" aria-labelledby="settings-workspace">
        <h2 id="settings-workspace">Workspace context</h2>
        <dl className="fields">
          <Field label="Selected workspace" mono>
            {workspaceId ?? "No workspace selected"}
          </Field>
          <Field label="Role state" mono>
            {state.kind}
          </Field>
          <Field label="Effective role" mono>
            {role ?? "None — permission-gated views are withheld"}
          </Field>
          <Field label="Explanation">{stateLabel}</Field>
        </dl>
        <h3>Permissions granted by this role</h3>
        <ul className="id-list">
          {(
            [
              ["catalog_read", "Catalog and releases"],
              ["projects_read", "Projects"],
              ["contexts_read", "Project contexts"],
              ["members_read", "Workspace members"],
              ["quotas_read", "Quotas and usage"],
              ["security_read", "Security denies"],
              ["audit_read", "Audit events"],
            ] as const
          ).map(([permission, label]) => (
            <li key={permission}>
              <span
                className={
                  can(permission) ? "badge badge--stable" : "badge badge--muted"
                }
              >
                {can(permission) ? "Granted" : "Not granted"}
              </span>{" "}
              {label} <span className="mono">({permission})</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="settings-incomplete">
        <h2 id="settings-incomplete">Not wired yet</h2>
        <p className="page__lede">
          This build has no BFF endpoints behind the API, so every data view reports an
          explicit unavailable state. Release integrity wording used by the console:{" "}
          {(["stable", "unpinned", "mismatch"] as const)
            .map((value) => describeReleaseStatus(value))
            .join(", ")}
          .
        </p>
      </section>
    </>
  );
}