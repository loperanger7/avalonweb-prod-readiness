import Stripe from 'stripe';
import { cancelAppointment } from '../../_acuity.js';
import { reconciliationTypeForStripeEvent } from '../../_reconciliation.js';
import { requireLiveWebhook } from '../../_lib/pre-api-guard.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Supabase (lazy; graceful no-op until service-role key is configured) ─────
let _supabase = null;
async function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

async function getDefaultTenantId(db) {
  const { data } = await db.from('tenants')
    .select('id').eq('slug', 'avalon-vitality').maybeSingle();
  return data?.id || null;
}

async function handleCheckoutCompleted(stripe, db, session) {
  const md = session.metadata || {};
  const acuityId = md.acuityAppointmentId || null;

  let paymentMethodId = null;
  const paymentIntentId = session.payment_intent || null;
  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      paymentMethodId = pi.payment_method || null;
    } catch (e) {
      console.warn('[stripe/webhook] payment_intent retrieve failed:', e.message);
    }
  }

  const tenantId = await getDefaultTenantId(db);
  const now = new Date().toISOString();
  const row = {
    acuity_appointment_id:         acuityId,
    stripe_checkout_session_id:    session.id,
    stripe_customer_id:            session.customer || null,
    stripe_deposit_payment_intent: paymentIntentId,
    stripe_payment_method_id:      paymentMethodId,
    deposit_paid_at:               now,
    payment_status:                'deposit_paid',
    balance_due_cents:             md.balanceDueCents != null ? Number(md.balanceDueCents) : null,
    visit_subtotal_cents:          md.visitSubtotalCents != null ? Number(md.visitSubtotalCents) : null,
    deposit_amount_cents:          md.depositAmountCents != null ? Number(md.depositAmountCents) : 5000,
    tenant_id:                     tenantId,
    updated_at:                    now,
  };

  // Atomic upsert: if a row already exists (from Acuity webhook), update it.
  // If not, insert. The UNIQUE partial index on acuity_appointment_id handles
  // concurrent delivery without 23505 races.
  if (acuityId) {
    const { error } = await db.from('appointments').upsert(
      { ...row, created_at: now },
      { onConflict: 'acuity_appointment_id', ignoreDuplicates: false }
    );
    if (error) console.warn('[stripe/webhook] appointment upsert failed:', error.message);
    return { action: 'deposit_paid', matched: true };
  }

  // No Acuity ID (edge case: direct Stripe-only checkout). Insert by session ID.
  const { error } = await db.from('appointments').upsert(
    { ...row, created_at: now },
    { onConflict: 'stripe_checkout_session_id', ignoreDuplicates: false }
  );
  if (error) console.warn('[stripe/webhook] appointment upsert (session) failed:', error.message);
  return { action: 'deposit_paid', matched: false };
}

async function handleBalancePaid(db, paymentIntent) {
  // Balance charges are tagged metadata.kind='balance' by /api/charge-balance.
  const md = paymentIntent.metadata || {};
  if (md.kind !== 'balance') return { action: 'ignored_non_balance_pi' };

  const now = new Date().toISOString();
  const patch = {
    stripe_balance_payment_intent: paymentIntent.id,
    balance_paid_at:               now,
    payment_status:                'paid_in_full',
    updated_at:                    now,
  };
  if (md.acuityAppointmentId) {
    await db.from('appointments').update(patch)
      .eq('acuity_appointment_id', String(md.acuityAppointmentId));
  }
  return { action: 'balance_paid' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const gate = requireLiveWebhook(req, res, {
    provider: 'Stripe',
    secretEnv: 'STRIPE_WEBHOOK_SECRET',
  });
  if (!gate) return null;

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  let event = null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);

    const db = await getSupabase();
    if (!db) {
      // Signature valid but DB not wired — ack so Stripe doesn't retry endlessly.
      return res.status(200).json({
        received: true, id: event.id, type: event.type,
        persisted: false, note: 'db_not_configured',
      });
    }

    let result = { action: 'store_for_audit' };
    switch (event.type) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(stripe, db, event.data.object);
        break;
      case 'payment_intent.succeeded':
        result = await handleBalancePaid(db, event.data.object);
        break;
      case 'checkout.session.expired': {
        const expiredSession = event.data.object;
        const expiredAcuityId = expiredSession.metadata?.acuityAppointmentId;
        if (expiredAcuityId) {
          try {
            await cancelAppointment(expiredAcuityId, 'Stripe checkout expired — customer did not complete payment.');
            if (db) {
              await db.from('appointments')
                .update({ status: 'canceled', updated_at: new Date().toISOString() })
                .eq('acuity_appointment_id', String(expiredAcuityId));
            }
            result = { action: 'expired_appointment_canceled', acuityAppointmentId: expiredAcuityId };
          } catch (cancelErr) {
            console.error('[stripe/webhook] expired cancel failed:', cancelErr.message);
            result = { action: 'expired_cancel_failed', error: cancelErr.message };
          }
        } else {
          result = { action: 'expired_no_appointment' };
        }
        break;
      }
      default:
        result = { action: 'store_for_audit' };
    }

    return res.status(200).json({
      received: true,
      id: event.id,
      type: event.type,
      persisted: true,
      reconciliationCaseType: reconciliationTypeForStripeEvent(event),
      result,
    });
  } catch (err) {
    // Before verification → 400 (Stripe should resend). After → 200 to avoid retry storms.
    if (!event) {
      return res.status(400).json({ error: err.message || 'Invalid Stripe webhook' });
    }
    console.error('[stripe/webhook] processing error:', err.message);
    return res.status(200).json({ received: true, persisted: false, error: err.message });
  }
}
