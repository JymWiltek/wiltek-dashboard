-- ═══════════════════════════════════════════════════════════════════════
-- V2 Launch Fix 3 · 件1 — 3 HQ staff users (marketing / hr / warehouse)
-- ═══════════════════════════════════════════════════════════════════════
-- HQ all-store roles: store = NULL (company-wide, can use branch picker like
-- owner). cost-12 bcrypt via pgcrypto crypt()/gen_salt('bf',12) — verified by
-- bcryptjs (api/login.js). Idempotent (ON CONFLICT username DO NOTHING).
--
-- 🔐 SECURITY: passwords are NOT committed. Before running, replace the 3
--    <<...>> placeholders with the bootstrap passwords from the Notion
--    decision log 36b0a2d3-1100-8153-8ef0-dfb7d0071ee5, then run in the
--    Supabase SQL editor. Tell each user to rotate on first login.
--
-- The guard below aborts if placeholders are left in by mistake.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF '<<MARKETING_PW>>' LIKE '<<%' THEN
    RAISE EXCEPTION 'Replace the <<...>> password placeholders before running this migration.';
  END IF;
END $$;

INSERT INTO public.users (username, password_hash, role, store, display_name, is_active) VALUES
  ('marketing', crypt('<<MARKETING_PW>>', gen_salt('bf', 12)), 'marketing', NULL, 'Marketing Team', true),
  ('hr',        crypt('<<HR_PW>>',        gen_salt('bf', 12)), 'hr',        NULL, 'HR Team',        true),
  ('warehouse', crypt('<<WAREHOUSE_PW>>', gen_salt('bf', 12)), 'warehouse', NULL, 'Warehouse Team', true)
ON CONFLICT (username) DO NOTHING;

-- Verify:
--   SELECT username, role, store, is_active FROM public.users
--   WHERE username IN ('marketing','hr','warehouse');
