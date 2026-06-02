# Avalon Vitality — Remaining Work for Production

**Repo:** https://github.com/loperanger7/avalonweb-prod-readiness (branch: `snooches-deploy`)
**Live test build:** https://harrisburg-psi.vercel.app

---

## Already shipped

| Item | Status |
|---|---|
| Remove hardcoded password backdoor | Done |
| DB idempotency migration (unique constraints + tenant seed) | Done |
| Webhook handlers rewritten to atomic upsert + tenant_id | Done |
| Stripe idempotency keys on checkout + balance charge | Done |
| Orphan Acuity appointment cancellation on checkout expiry | Done |
| Resend error handling (waitlist + apply won't 500 on email failure) | Done |
| Checkout double-click prevention | Done |
| Humanized error messages with support contact | Done |
| Remove client-controlled custom-treatment pricing | Done |
| Scrub PII from server error logs | Done |
| Public `/api/appointment-summary` endpoint (confirmation page fix) | Done |
| vitest infrastructure + 29 passing tests | Done |

---

## Remaining (7 items, ordered by dependency)

### 1. Auth rewrite — Supabase Auth

The largest piece. Blocks everything else.

- Replace `src/lib/useAuthStore.js` demo auth with Supabase Auth
- Keep existing role names (provider/admin) for now
- ~20 components consume `useAuthStore()`, all need to work with real sessions
- The `useMessages` hook expects `user.id` to match Supabase `auth.users`
- Must land before Supabase creds are added (pages that fall back to mock data will instead fail against RLS policies if Supabase is connected without auth)

### 2. Wire remaining secrets on Vercel

- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
- `STRIPE_WEBHOOK_SECRET` (+ configure endpoint in Stripe dashboard)
- `ACUITY_WEBHOOK_SECRET`
- `AVALON_INTERNAL_API_SECRET` (generate a random token)
- `AVALON_ENABLE_LIVE_API=true`

### 3. Update BookingConfirmation page

- Change the fetch from `/api/scheduling-appointment?id=X` to `/api/appointment-summary?session_id=X`
- The old endpoint requires internal auth the browser can't provide
- The new endpoint (already built) returns only non-sensitive fields

### 4. RLS policy tightening

- Current Supabase RLS: authenticated users get full read/write on everything
- Needs role-based policies: clients see only their own data, providers see their assigned appointments, admins see everything
- The HIPAA minimum: no one reads `external_payload` or `raw_payload_json` without the right role

### 5. HIPAA data audit

- `appointments.external_payload` and `acuity_events.raw_payload_json` contain full Acuity appointment data including DOB, allergies, medications, emergency contacts
- These are the primary PHI stores, not just browser localStorage (which is already redacted by `preApiSecurity.js`)
- Need: either encrypt these columns at the application level or restrict access via column-level policies

### 6. Sentry / error monitoring

- Install `@sentry/node`, instrument the serverless function handlers
- Set up a daily query against `reconciliation_cases` table for unresolved items
- Stripe provides its own webhook dashboard (just needs the endpoint configured)

### 7. E2E smoke test

- Full booking flow against Stripe test mode: select service -> enter address -> pick time -> fill medical form -> pay -> see confirmation
- Validates the complete chain: browser -> checkout API -> Acuity -> Stripe -> webhook -> Supabase -> confirmation page

---

## Rollout sequence (once all 7 are done)

1. Deploy everything with `AVALON_ENABLE_LIVE_API=true` + **Stripe test keys**
2. Run the E2E smoke test end-to-end
3. Swap to live Stripe keys
4. One real booking with a team member's card
5. Monitor 24 hours, then announce

**Rollback:** Set `AVALON_ENABLE_LIVE_API=false`. Site returns to simulation mode. Existing Stripe charges and Acuity appointments need manual reconciliation.

---

## After launch (Phase 2+)

- One authenticated admin view showing real Supabase appointments
- Nurse shift view with real data + balance charge UI
- Service area waitlist capture (accepted expansion)
- Medical questionnaire persistence for repeat visits (accepted expansion)
- Full HIPAA compliance audit + BAA with Supabase
