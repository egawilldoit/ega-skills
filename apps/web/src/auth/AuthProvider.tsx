import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthChangeEvent, Provider, Session, User } from "@supabase/supabase-js";

import { supabase, supabaseConfigured, supabaseConfigurationIssue } from "./supabase";

/** One failed authentication attempt. Never carries a token or a raw stack. */
export interface AuthFailure {
  readonly message: string;
  readonly code: string | null;
}

export type AuthStatus = "unconfigured" | "loading" | "signed_out" | "signed_in";

export interface AuthState {
  readonly status: AuthStatus;
  readonly session: Session | null;
  readonly userId: string | null;
  readonly email: string | null;
  /** Non-null only when `status === "unconfigured"`. */
  readonly configurationIssue: string | null;
  readonly lastFailure: AuthFailure | null;
}

export interface AuthContextValue extends AuthState {
  /** Resolves to `null` when signed out or unconfigured. Never throws. */
  readonly getAccessToken: () => Promise<string | null>;
  readonly signInWithPassword: (email: string, password: string) => Promise<AuthFailure | null>;
  readonly signInWithProvider: (provider: Provider) => Promise<AuthFailure | null>;
  readonly signOut: () => Promise<AuthFailure | null>;
  readonly clearFailure: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const UNCONFIGURED: AuthState = {
  status: "unconfigured",
  session: null,
  userId: null,
  email: null,
  configurationIssue: null,
  lastFailure: null,
};

function failureFrom(error: unknown, fallback: string): AuthFailure {
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; error_description?: unknown; code?: unknown };
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error_description === "string"
          ? record.error_description
          : fallback;
    const code = typeof record.code === "string" ? record.code : null;
    return { message, code };
  }
  return { message: fallback, code: null };
}

function readUser(event: AuthChangeEvent, session: Session | null): User | null {
  return event === "SIGNED_OUT" ? null : (session?.user ?? null);
}

export interface AuthProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the first-party Supabase user session.
 *
 * When the browser-visible env is absent the provider settles on
 * `status: "unconfigured"` with an actionable message. It never throws and never
 * attempts a request, so the rest of the console can render a real state.
 */
export function AuthProvider({ children }: AuthProviderProps): ReactNode {
  const [state, setState] = useState<AuthState>(() =>
    supabaseConfigured
      ? {
          status: "loading",
          session: null,
          userId: null,
          email: null,
          configurationIssue: null,
          lastFailure: null,
        }
      : { ...UNCONFIGURED, configurationIssue: supabaseConfigurationIssue() },
  );
  // supabase-js calls onAuthStateChange synchronously; the session object is
  // only safe to read after the callback returns.
  const pending = useRef<Session | null>(null);

  useEffect(() => {
    if (!supabaseConfigured || supabase === null) return;
    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const session = data.session;
      pending.current = session;
      setState((previous) => ({
        ...previous,
        status: session === null ? "signed_out" : "signed_in",
        session,
        userId: session?.user.id ?? null,
        email: typeof session?.user.email === "string" ? session.user.email : null,
      }));
    });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const user = readUser(event, session);
      pending.current = session;
      setState((previous) => ({
        ...previous,
        status: session === null ? "signed_out" : "signed_in",
        session,
        userId: user?.id ?? null,
        email: typeof user?.email === "string" ? user.email : null,
      }));
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!supabaseConfigured || supabase === null) return null;
    const session = pending.current;
    if (session !== null) return session.access_token;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const requireConfigured = useCallback((): AuthFailure | null => {
    if (supabaseConfigured && supabase !== null) return null;
    return {
      message: supabaseConfigurationIssue() ?? "Supabase is not configured.",
      code: "E_SUPABASE_UNCONFIGURED",
    };
  }, []);

  const signInWithPassword = useCallback(
    async (email: string, password: string): Promise<AuthFailure | null> => {
      const blocked = requireConfigured();
      if (blocked !== null || supabase === null) return blocked;
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error !== null) {
        const failure = failureFrom(error, "Sign-in failed.");
        setState((previous) => ({ ...previous, lastFailure: failure }));
        return failure;
      }
      setState((previous) => ({ ...previous, lastFailure: null }));
      return null;
    },
    [requireConfigured],
  );

  const signInWithProvider = useCallback(
    async (provider: Provider): Promise<AuthFailure | null> => {
      const blocked = requireConfigured();
      if (blocked !== null || supabase === null) return blocked;
      // PKCE is configured on the client; the browser navigates away to the
      // provider and comes back through `detectSessionInUrl`.
      const { error } = await supabase.auth.signInWithOAuth({ provider });
      if (error !== null) {
        const failure = failureFrom(error, "Provider sign-in failed.");
        setState((previous) => ({ ...previous, lastFailure: failure }));
        return failure;
      }
      return null;
    },
    [requireConfigured],
  );

  const signOut = useCallback(async (): Promise<AuthFailure | null> => {
    const blocked = requireConfigured();
    if (blocked !== null || supabase === null) return blocked;
    const { error } = await supabase.auth.signOut();
    if (error !== null) {
      const failure = failureFrom(error, "Sign-out failed.");
      setState((previous) => ({ ...previous, lastFailure: failure }));
      return failure;
    }
    setState((previous) => ({ ...previous, lastFailure: null }));
    return null;
  }, [requireConfigured]);

  const clearFailure = useCallback(() => {
    setState((previous) => ({ ...previous, lastFailure: null }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      getAccessToken,
      signInWithPassword,
      signInWithProvider,
      signOut,
      clearFailure,
    }),
    [state, getAccessToken, signInWithPassword, signInWithProvider, signOut, clearFailure],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}