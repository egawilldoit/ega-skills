-- Dedicated-resource OAuth profile for the EGA Skills MCP.
--
-- Supabase supplies client_id in the signed-token hook event for delegated
-- OAuth sessions. Every OAuth client registered in this project is therefore
-- an EGA Skills MCP client; the hook binds those tokens to the one resource
-- this issuer serves. First-party sessions retain the provider's normal
-- claims, including aud=authenticated.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  client_id text := nullif(btrim(claims->>'client_id'), '');
begin
  if client_id is not null then
    claims := jsonb_set(
      claims,
      '{aud}',
      to_jsonb('https://ega-skills-mcp.vercel.app/mcp'::text),
      true
    );
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
