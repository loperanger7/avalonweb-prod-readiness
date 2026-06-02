# Patches Applied — Session 2026-06-01

All changes shipped in commit `aaba796` on branch `snooches-deploy`.
Repo: https://github.com/loperanger7/avalonweb-prod-readiness

---

## Security

### 1. Removed hardcoded demo password fallback
**File:** `src/lib/useAuthStore.js:35`
**Was:** `const DEMO_PASSWORD = import.meta.env.VITE_AVALON_DEMO_PASSWORD || 'JonJones1986';`
**Now:** `const DEMO_PASSWORD = import.meta.env.VITE_AVALON_DEMO_PASSWORD || '';`
**Why:** The fallback password was in a public GitHub repo. Anyone could log in as admin.

### 2. Removed client-controlled custom-treatment pricing
**File:** `api/_lib/catalog-pricing.js:82-84`
**Was:** Items with `type: 'custom-treatment'` accepted a client-submitted price ($150-$5000)
**Now:** Removed. All prices come from the server-side catalog.
**Why:** A customer could craft a POST request with an artificially low price.

### 3. Scrubbed PII from server error logs
**File:** `api/create-checkout-session.js:352-356`
**Was:** `console.error(..., err.body || '')` — logged full Acuity/Stripe error bodies that may contain customer name, email, medical data
**Now:** Logs only `err.message` and `err.status`
**Why:** Error logs should never contain patient health information.

---

## Idempotency

### 4. Database unique constraints migration
**File:** `supabase/migrations/005_idempotency_and_tenant.sql` (new)
**What:** Added UNIQUE partial indexes on `appointments.acuity_appointment_id` and `appointments.stripe_checkout_session_id`. Prevents duplicate appointment rows from concurrent webhook delivery.

### 5. Webhook handlers rewritten to atomic upsert
**Files:** `api/integrations/stripe/webhook.js`, `api/integrations/acuity/webhook.js`
**Was:** Select-then-insert pattern (race condition: two concurrent webhooks both see "not found", both insert, one fails or creates a duplicate)
**Now:** `.upsert()` with `onConflict` — single atomic operation, no race window
**Why:** Stripe and Acuity can deliver webhooks near-simultaneously for the same event.

### 6. Stripe idempotency keys on checkout session creation
**File:** `api/create-checkout-session.js:325`
**What:** Added `idempotencyKey` to `stripe.checkout.sessions.create()` call. Prevents duplicate Stripe sessions from request retries.

### 7. Stripe idempotency key on balance charge
**File:** `api/charge-balance.js:74`
**What:** Added `idempotencyKey` derived from `balance-{appointmentId}-{amount}` to `stripe.paymentIntents.create()`. Prevents duplicate charges if a nurse double-clicks or the request retries.

---

## Tenant isolation

### 8. Default tenant seeded
**File:** `supabase/migrations/005_idempotency_and_tenant.sql`
**What:** Seeds an 'Avalon Vitality' tenant row. Backfills `tenant_id` on existing `appointments` and `acuity_events` rows.

### 9. tenant_id added to all webhook writes
**Files:** `api/integrations/stripe/webhook.js`, `api/integrations/acuity/webhook.js`
**Was:** Webhook handlers wrote rows without `tenant_id`
**Now:** All inserts/upserts include `tenant_id` from the default tenant
**Why:** Supabase RLS policies require tenant membership to read rows. Without tenant_id, data was invisible to the app.

---

## Bug fixes

### 10. Orphan Acuity appointment cancellation on checkout expiry
**File:** `api/integrations/stripe/webhook.js` (checkout.session.expired handler)
**Was:** `result = { action: 'release_scheduling_hold' }` — did nothing
**Now:** Reads `metadata.acuityAppointmentId`, calls `cancelAppointment()`, updates Supabase row to `status: 'canceled'`
**Why:** When a customer starts checkout, an Acuity appointment is created immediately. If they abandon payment, the appointment stays on the calendar, wasting nurse capacity.

### 11. Resend error handling — waitlist
**File:** `api/waitlist.js:128-153`
**Was:** Internal email failure crashed the endpoint with 500/502. Customer thought their submission failed.
**Now:** Both emails (internal notification + subscriber confirmation) wrapped in try/catch. Always returns `{ success: true }`.
**Why:** A customer submitting their info should never see an error because the confirmation email failed.

### 12. Resend error handling — apply
**File:** `api/apply.js:194-218`
**Same fix as waitlist.** Application always succeeds regardless of email delivery status.

### 13. Checkout submit double-click prevention
**File:** `app-modules/pages/Checkout.jsx`
**What:** Added `useRef` guard (`submittingRef`) that blocks re-entry before React state updates. The existing `disabled={loading}` only works after re-render, which is too slow for fast double-clicks.
**Why:** Without this, a fast double-click could create two Acuity appointments and two Stripe checkout sessions.

### 14. Humanized checkout error messages
**File:** `app-modules/pages/Checkout.jsx` (catch block)
**Was:** `setError(err.message)` — raw error text
**Now:** Fallback to "We couldn't complete your booking right now. Your card has not been charged. Please try again or contact us at support@avalonvitality.co."
**Why:** For a medical service where someone just entered their health information and credit card, a cold error message is a trust-breaker.

---

## New endpoints

### 15. Public appointment summary endpoint
**File:** `api/appointment-summary.js` (new)
**What:** `GET /api/appointment-summary?session_id=cs_xxx` — returns non-sensitive appointment data (date, time, service, confirmation number, payment status). Lookup by Stripe session_id (opaque), not Acuity appointment ID (guessable).
**Why:** The existing `/api/scheduling-appointment` endpoint requires `AVALON_INTERNAL_API_SECRET` in live mode. The browser can't provide that, so the BookingConfirmation page would break when the live API flag is enabled.

---

## Test infrastructure

### 16. vitest setup + test suite
**Files:** `package.json`, `tests/catalog-pricing.test.js`, `tests/stripe-webhook.test.js`, `tests/charge-balance.test.js`, `tests/waitlist.test.js`
**What:** Installed vitest. Added `"test": "vitest run"` to package.json. 29 tests across 4 files covering:
- Catalog pricing: all IV protocols, NAD+/CBD dosage tiers, add-ons, membership tiers, unknown items, boundary values, custom-treatment rejection
- Stripe webhook: expired checkout cancellation logic, upsert idempotency, tenant_id inclusion
- Charge-balance: idempotency key derivation, already-paid guard, minimum amount, no-card-on-file
- Waitlist: Resend failure handling, honeypot, rate limiting, email validation, spam detection
