import { useEffect, useState, type FormEvent } from "react";
import { safeRedirectTarget, supabase, supabaseConfigured } from "./supabase";

export function Login() {
  const params = new URLSearchParams(window.location.search);
  const target = safeRedirectTarget(params.get("redirect"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const go = (): void => {
      if (active) window.location.replace(target);
    };
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) go();
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) go();
    });
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [target]);

  if (!supabaseConfigured || !supabase) {
    return (
      <main className="card">
        <h1>EGA Skills</h1>
        <p className="error">Sign-in is not configured on this deployment.</p>
      </main>
    );
  }
  const client = supabase;

  const signIn = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage("Sign-in failed. Check your email and password and try again.");
      setPending(false);
      return;
    }
    window.location.replace(target);
  };

  const sendMagicLink = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const redirectTo = `${window.location.origin}/login?redirect=${encodeURIComponent(target)}`;
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
    });
    setPending(false);
    if (error) {
      setMessage("Could not send a sign-in link. Check the address and try again.");
      return;
    }
    setMagicLinkSent(true);
  };

  return (
    <main className="card">
      <h1>EGA Skills</h1>
      <p className="muted">Sign in to continue to the application that requested access.</p>
      {message ? <p className="error" role="alert">{message}</p> : null}
      {magicLinkSent ? (
        <p className="notice" role="status">Check your email for a sign-in link.</p>
      ) : (
        <form onSubmit={(event) => void signIn(event)}>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <button type="button" className="secondary" disabled={pending || email === ""} onClick={() => void sendMagicLink()}>
            Email me a sign-in link
          </button>
        </form>
      )}
      <p className="muted small">Signed in to continue to {target.startsWith("/oauth/consent") ? "an authorization request" : "EGA Skills"}.</p>
    </main>
  );
}

