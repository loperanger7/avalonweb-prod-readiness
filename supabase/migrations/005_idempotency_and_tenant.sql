-- 005_idempotency_and_tenant.sql
-- Adds unique constraints for webhook idempotency and seeds the default tenant.
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING throughout).

-- ── Seed default tenant ─────────────────────────────────────────────────────
INSERT INTO public.tenants (name, slug, status)
VALUES ('Avalon Vitality', 'avalon-vitality', 'active')
ON CONFLICT (slug) DO NOTHING;

-- ── Unique constraints on appointments external IDs ─────────────────────────
-- Prevents duplicate rows from concurrent webhook delivery.
-- Webhook handlers MUST use upsert (ON CONFLICT ... DO UPDATE), not
-- select-then-insert, or concurrent delivery will hit 23505.
--
-- NULLs are excluded: a row without an acuity_appointment_id (e.g. created
-- by Stripe webhook before Acuity fires) won't conflict with another such row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_acuity_id
  ON public.appointments (acuity_appointment_id)
  WHERE acuity_appointment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_stripe_session
  ON public.appointments (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- ── Backfill tenant_id on existing rows ─────────────────────────────────────
-- All existing data belongs to the single Avalon Vitality tenant.
UPDATE public.appointments
SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'avalon-vitality' LIMIT 1)
WHERE tenant_id IS NULL;

UPDATE public.acuity_events
SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'avalon-vitality' LIMIT 1)
WHERE tenant_id IS NULL;
