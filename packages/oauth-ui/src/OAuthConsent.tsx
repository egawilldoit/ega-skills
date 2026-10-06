import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentLocation, supabase, supabaseConfigured } from "./supabase";

interface AuthorizationDetails {
  readonly authorization_id: string;
  readonly redirect_uri: string;
  readonly client: { readonly id: string; readonly name?: string; readonly uri?: string };
  readonly user: { readonly id: string; readonly email: string };
  readonly scope: string;
}

type State =
  | { kind: "loading" }
  | { kind: "details"; details: AuthorizationDetails }
  | { kind: "redirecting" }
  | { kind: "error"; message: string };

function failClosedMessage(): string {
  return "This authorization request is no longer valid. Return to the application that started it and try again.";
}

function describeDestination(redirectUri: string): string {
  try {
    const parsed = new URL(redirectUri);
    return parsed.host || redirectUri;
  } catch {
    return redirectUri;
  }
}

export function OAuthConsent() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const authorizationId = params.get("authorization_id");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    if (!authorizationId) {
      setState({ kind: "error", message: failClosedMessage() });
      return;
    }
    let active = true;
    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        window.location.replace(`/login?redirect=${encodeURIComponent(currentLocation())}`);
        return;
      }
      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (!active) return;
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === "session_not_found" || code === "session_expired") {
          window.location.replace(`/login?redirect=${encodeURIComponent(currentLocation())}`);
          return;
        }
        setState({ kind: "error", message: failClosedMessage() });
        return;
      }
      if (!data) {
        setState({ kind: "error", message: failClosedMessage() });
        return;
      }
      if ("redirect_url" in data && typeof data.redirect_url === "string") {
        settled.current = true;
        setState({ kind: "redirecting" });
        window.location.assign(data.redirect_url);
        return;
      }
      if ("authorization_id" in data && data.authorization_id) {
        setState({ kind: "details", details: data as AuthorizationDetails });
        return;
      }
      setState({ kind: "error", message: failClosedMessage() });
    })();
    return () => {
      active = false;
    };
  }, [authorizationId]);

  const decide = useCallback(
    async (action: "approve" | "deny"): Promise<void> => {
      if (!supabase || pending || settled.current) return;
      setPending(true);
      setActionError(null);
      const { data, error } = await (action === "approve"
        ? supabase.auth.oauth.approveAuthorization(authorizationId as string, { skipBrowserRedirect: true })
        : supabase.auth.oauth.denyAuthorization(authorizationId as string, { skipBrowserRedirect: true }));
      if (error || !data || typeof data.redirect_url !== "string") {
        setPending(false);
        setActionError(failClosedMessage());
        return;
      }
      settled.current = true;
      setState({ kind: "redirecting" });
      window.location.assign(data.redirect_url);
    },
    [authorizationId, pending],
  );

  if (!supabaseConfigured || !supabase) {
    return (
      <main className="card">
        <h1>EGA Skills</h1>
        <p className="error">Authorization is not configured on this deployment.</p>
      </main>
    );
  }

  if (state.kind === "loading" || state.kind === "redirecting") {
    return (
      <main className="card">
        <h1>EGA Skills</h1>
        <p className="muted">{state.kind === "redirecting" ? "Returning to the application…" : "Loading authorization request…"}</p>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="card">
        <h1>EGA Skills</h1>
        <p className="error" role="alert">{state.message}</p>
      </main>
    );
  }

  const { details } = state;
  const clientName = details.client.name?.trim() || "An application";
  const scopes = details.scope.split(/\s+/).filter(Boolean);
  const destination = describeDestination(details.redirect_uri);

  return (
    <main className="card">
      <h1>EGA Skills</h1>
      <p className="muted">An application wants to access EGA Skills on your behalf.</p>
      <dl className="details">
        <dt>Application</dt>
        <dd>{clientName}</dd>
        {details.client.uri ? (
          <>
            <dt>Application site</dt>
            <dd className="break">{details.client.uri}</dd>
          </>
        ) : null}
        <dt>Signed-in account</dt>
        <dd>{details.user.email}</dd>
        <dt>Redirect destination</dt>
        <dd className="break">
          <strong>{destination}</strong>
          <span className="muted small"> — the verification code is sent to this destination only</span>
        </dd>
        <dt>Requested access</dt>
        <dd>
          {scopes.length > 0 ? (
            <ul className="scopes">
              {scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          ) : (
            <span>Basic account access</span>
          )}
        </dd>
      </dl>
      <p className="muted small">
        EGA Skills shares your authenticated identity with this application and lets it call the four read-only EGA
        Skills tools (search, resolve, inspect, get_content) with your existing permissions. It cannot change your
        workspace, projects, or skills.
      </p>
      {actionError ? <p className="error" role="alert">{actionError}</p> : null}
      <div className="actions">
        <button type="button" disabled={pending} onClick={() => void decide("approve")}>
          {pending ? "Working…" : "Allow"}
        </button>
        <button type="button" className="secondary" disabled={pending} onClick={() => void decide("deny")}>
          Deny
        </button>
      </div>
    </main>
  );
}
