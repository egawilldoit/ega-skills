import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Public browser Supabase client. Only the publishable key is ever bundled;
 * server secrets (secret key, service role, Vercel tokens) must never reach
 * this bundle.
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

/** Only allow same-site relative paths as post-login targets. */
export function safeRedirectTarget(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}
