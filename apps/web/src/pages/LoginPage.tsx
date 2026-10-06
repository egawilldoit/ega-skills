import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { currentLocation, safeRedirectTarget } from "../auth/supabase";

/**
 * First-party sign-in surface.
 *
 * Password/email and a provider login in PKCE mode. Deliberately no EGA
 * delegated OAuth: `packages/oauth-ui` serves that flow for external clients
 * and is not reachable from this console. A delegated session carries a
 * `client_id` claim and therefore reads zero control-plane rows under the
 * RESTRICTIVE policy added in
 * `supabase/migrations/202609180001_delegated_oauth_containment.sql:44-46`.
 *
 * Read-only console: this page authenticates an operator and does nothing else.
 * There is no sign-up, no password reset flow, and no account mutation, because
 * those are identity-provider concerns rather than console concerns.
 */
export function LoginPage(): ReactNode {
  const { status, configurationIssue, signInWithPassword, signInWithProvider, lastFailure, clearFailure } =
    useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();

  const next = safeRedirectTarget(searchParams.get("next"));

  if (status === "signed_in") {
    return <Navigate to={next} replace />;
  }

  if (status === "unconfigured") {
    return (
      <main className="auth" id="console-main">
        <div className="auth__card">
          <h1>EGA Skills Console</h1>
          <section className="state state--unavailable" aria-labelledby="auth-unconfigured">
            <h2 id="auth-unconfigured">Sign-in is not available</h2>
            <p>
              {configurationIssue ??
                "The browser-visible Supabase variables are missing from this build."}
            </p>
          </section>
        </div>
      </main>
    );
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    clearFailure();
    setBusy(true);
    try {
      await signInWithPassword(email, password);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth" id="console-main">
      <div className="auth__card">
        <h1>EGA Skills Console</h1>
        <p className="auth__lede">
          Read-only operations view over the hosted control plane. Sign in with your
          first-party Supabase user account.
        </p>

        {status === "loading" ? (
          <p className="state state--loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Resolving your session…
          </p>
        ) : null}

        {lastFailure === null ? null : (
          <p className="state state--error" role="alert">
            {lastFailure.message}
          </p>
        )}

        <form className="auth__form" onSubmit={(event) => void onSubmit(event)}>
          <div className="field">
            <label className="field__label" htmlFor={emailId}>
              Email
            </label>
            <input
              className="field__input"
              id={emailId}
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={passwordId}>
              Password
            </label>
            <input
              className="field__input"
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="auth__divider">
          <span>or</span>
        </div>

        <div className="auth__providers">
          {(["github", "google"] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void signInWithProvider(provider)}
            >
              Continue with {provider === "github" ? "GitHub" : "Google"}
            </button>
          ))}
        </div>

        <p className="auth__note">
          Returning to <span className="mono">{currentLocation()}</span>
        </p>
      </div>
    </main>
  );
}