/**
 * POST /api/charge-balance
 *
 * Nurse-triggered (no portal): charges the remaining appointment balance to the
 * card saved on file at deposit time. Off-session. If the card needs SCA
 * authentication, returns a Stripe-hosted link for the client to complete.
 *
 * Auth: behind AVALON_INTERNAL_API_SECRET + AVALON_ENABLE_LIVE_API (via
 * requireInternalAccess). Never callable from the public client bundle.
 *
 * Body: { acuityAppointmentId: string, amountCentsOverride?: number }
 */

import Stripe from 'stripe';
import { requireInternalAccess } from './_lib/pre-api-guard.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Live-flag + internal-secret gate. In pre-API mode this returns the hard wall.
  if (!requireInternalAccess(req, res, 'Charge appointment balance')) return;

  const { acuityAppointmentId, amountCentsOverride } = req.body || {};
  if (!acuityAppointmentId) {
    return res.status(400).json({ error: 'acuityAppointmentId is required' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const db = await getSupabase();
  if (!db) {
    return res.status(503).json({ error: 'Database is not configured', code: 'db_not_configured' });
  }

  const { data: appt, error: lookupErr } = await db.from('appointments')
    .select('id, stripe_customer_id, stripe_payment_method_id, balance_due_cents, payment_status, currency')
    .eq('acuity_appointment_id', String(acuityAppointmentId))
    .maybeSingle();

  if (lookupErr) return res.status(500).json({ error: lookupErr.message });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (appt.payment_status === 'paid_in_full') {
    return res.status(409).json({ error: 'Balance already paid', code: 'already_paid' });
  }

  const amount = Number(amountCentsOverride || appt.balance_due_cents || 0);
  if (!amount || amount < 50) {
    return res.status(400).json({ error: 'No balance due to charge', code: 'no_balance' });
  }
  if (!appt.stripe_customer_id || !appt.stripe_payment_method_id) {
    return res.status(409).json({ error: 'No saved card on file', code: 'no_card_on_file' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const currency = appt.currency || 'usd';
  const baseUrl = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const metadata = { kind: 'balance', acuityAppointmentId: String(acuityAppointmentId) };

  try {
    const idempotencyKey = `balance-${acuityAppointmentId}-${amount}`;
    const pi = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: appt.stripe_customer_id,
      payment_method: appt.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata,
    }, { idempotencyKey });

    const now = new Date().toISOString();
    await db.from('appointments').update({
      stripe_balance_payment_intent: pi.id,
      balance_paid_at: now,
      payment_status: 'paid_in_full',
      updated_at: now,
    }).eq('id', appt.id);

    return res.status(200).json({ ok: true, status: pi.status, paymentIntentId: pi.id, amount });
  } catch (err) {
    // SCA / card error → hand the client a Stripe-hosted link to finish.
    if (err.code === 'authentication_required' || err.type === 'StripeCardError') {
      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer: appt.stripe_customer_id,
          line_items: [{
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amount,
              product_data: { name: 'Avalon visit — remaining balance' },
            },
          }],
          payment_intent_data: { metadata },
          success_url: `${baseUrl}/booking/confirmation?balance=paid`,
          cancel_url: `${baseUrl}/booking/confirmation?balance=pending`,
        });
        return res.status(200).json({ ok: false, requiresAction: true, url: session.url, reason: err.code || 'card_error' });
      } catch (linkErr) {
        return res.status(502).json({ error: linkErr.message });
      }
    }
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
