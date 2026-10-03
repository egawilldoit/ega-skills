import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Public browser Supabase client. Only the publishable key is ever bundled;
 * server secrets (secret key, service role, Vercel tokens) must never reach
 * this bundle.
 *
 * Authentication here is FIRST-PARTY ONLY: a plain Supabase user session
 * obtained through password/email or a provider login in PKCE mode. It is
 * deliberately not the EGA delegated OAuth flow. Every control-plane table
 * carries a RESTRICTIVE policy `using ((auth.jwt() ->> 'client_id') is null)`
 * (supabase/migrations/202609180001_delegated_oauth_containment.sql:44-46),
 * and an OAuth-minted session always carries `client_id`, so such a session
 * reads zero control-plane rows. `packages/oauth-ui` remains isolated and is
 * not used by this console.
 */
export const supabase: SupabaseClient | null =
  url && publishableKey
    ? createClient(url, publishableKey, {
        auth: {
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
          flowType: "pkce",
        },
      })
    : null;

export const supabaseConfigured = supabase !== null;

/**
 * Names of the two browser-visible variables that are missing or empty. The
 * console renders this instead of crashing, because a missing `VITE_` variable
 * is a deployment mistake an operator needs to see, not an exception.
 */
export function supabaseConfigurationIssue(): string | null {
  const missing: string[] = [];
  if (!url) missing.push("VITE_SUPABASE_URL");
  if (!publishableKey) missing.push("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (missing.length === 0) return null;
  return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set at build time. Rebuild the SPA with both browser-visible variables defined.`;
}

/** Only allow same-site relative paths as post-login targets. */
export function safeRedirectTarget(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}