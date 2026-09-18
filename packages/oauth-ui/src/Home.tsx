import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "./supabase";

interface Grant {
  readonly client: { readonly id: string; readonly name?: string };
  readonly scopes: readonly string[];
  readonly granted_at: string;
}

export function Home() {
  const [state, setState] = useState<"loading" | "signed-out" | "ready">("loading");
  const [grants, setGrants] = useState<readonly Grant[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (!data.session) {
        setState("signed-out");
        window.location.replace(`/login?redirect=${encodeURIComponent("/")}`);
        return;
      }
      const result = await supabase.auth.oauth.listGrants();
      if (!active) return;
      if (result.error) {
        setError("Could not load authorized applications.");
      } else {
        setGrants(result.data ?? []);
      }
      setState("ready");
    })();
    return () => {
      active = false;
    };
  }, []);

  const revoke = async (clientId: string): Promise<void> => {
    if (!supabase) return;
    const { error: revokeError } = await supabase.auth.oauth.revokeGrant({ clientId });
    if (revokeError) {
      setError("Could not revoke access. Try again.");
      return;
    }
    setGrants((current) => current.filter((grant) => grant.client.id !== clientId));
  };

  const signOut = async (): Promise<void> => {
    if (!supabase) return;
    await supabase.auth.signOut();
    window.location.replace("/login");
  };

  return (
    <main className="card">
      <h1>EGA Skills</h1>
      {!supabaseConfigured || !supabase ? (
        <p className="error">This deployment is not configured.</p>
      ) : state === "loading" ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted">Applications you have authorized to access EGA Skills.</p>
          {error ? <p className="error" role="alert">{error}</p> : null}
          {grants.length === 0 ? (
            <p className="muted">No connected applications.</p>
          ) : (
            <ul className="grants">
              {grants.map((grant) => (
                <li key={grant.client.id}>
                  <span>{grant.client.name?.trim() || grant.client.id}</span>
                  <span className="muted small">{grant.scopes.join(" ")}</span>
                  <button type="button" className="secondary" onClick={() => void revoke(grant.client.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      )}
    </main>
  );
}
