#!/usr/bin/env node
/**
 * Obtain a fresh first-party Supabase user access token for staging OAuth
 * interop, without a browser: Admin API `generate_link` + `verify`. The token
 * is written to a 0600 file; only claim presence is printed.
 *
 * Required environment:
 *   EGA_INTEROP_ADMIN_KEY   Supabase secret/service key (never printed)
 *   EGA_INTEROP_USER_EMAIL  staging user email
 *   EGA_INTEROP_TOKEN_OUT   output path (0600)
 * Optional:
 *   EGA_INTEROP_SUPABASE_URL default https://divriwexbijtojjulqtu.supabase.co
 */

import { writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.EGA_INTEROP_SUPABASE_URL ?? "https://divriwexbijtojjulqtu.supabase.co";
const ADMIN_KEY = process.env.EGA_INTEROP_ADMIN_KEY;
const EMAIL = process.env.EGA_INTEROP_USER_EMAIL;
const OUT = process.env.EGA_INTEROP_TOKEN_OUT;

if (!ADMIN_KEY || !EMAIL || !OUT) {
  console.error("EGA_INTEROP_ADMIN_KEY, EGA_INTEROP_USER_EMAIL and EGA_INTEROP_TOKEN_OUT are required");
  process.exit(2);
}

async function post(path, body, headers) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: { apikey: ADMIN_KEY, authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

const link = await post("/auth/v1/admin/generate_link", { type: "magiclink", email: EMAIL });
if (link.status !== 200 || !link.body?.email_otp) {
  console.error(`generate_link failed status=${link.status}`);
  process.exit(1);
}
const verify = await post("/auth/v1/verify", { type: "magiclink", token: link.body.email_otp, email: EMAIL });
if (verify.status !== 200 || !verify.body?.access_token) {
  console.error(`verify failed status=${verify.status}`);
  process.exit(1);
}
writeFileSync(OUT, `${verify.body.access_token}\n`, { mode: 0o600 });
const claims = JSON.parse(Buffer.from(verify.body.access_token.split(".")[1], "base64url").toString("utf8"));
console.log(JSON.stringify({ issuer: claims.iss, audience: claims.aud, subject_present: typeof claims.sub === "string", client_id: claims.client_id ?? null, expires_at: claims.exp, refresh_token: Boolean(verify.body.refresh_token) }, null, 2));
