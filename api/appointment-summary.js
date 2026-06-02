/**
 * GET /api/appointment-summary?session_id=cs_xxx
 *
 * Public-safe endpoint for the booking confirmation page. Returns only
 * non-sensitive appointment data: date, time, service type, confirmation
 * number. No medical data, no payment details, no PII.
 *
 * Lookup is by Stripe checkout session_id (opaque, one-time). Not by
 * Acuity appointment ID (guessable sequential integer).
 */

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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionId = req.query?.session_id;
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return res.status(400).json({ error: 'Valid session_id is required' });
  }

  const db = await getSupabase();
  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { data, error } = await db.from('appointments')
    .select('acuity_appointment_id, starts_at, protocol_key, status, deposit_amount_cents, balance_due_cents, payment_status, created_at')
    .eq('stripe_checkout_session_id', sessionId)
    .maybeSingle();

  if (error) {
    console.error('[appointment-summary]', error.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }

  if (!data) {
    return res.status(404).json({ error: 'Appointment not found' });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    confirmationId: data.acuity_appointment_id || null,
    startsAt: data.starts_at,
    service: data.protocol_key,
    status: data.status,
    depositCents: data.deposit_amount_cents,
    balanceDueCents: data.balance_due_cents,
    paymentStatus: data.payment_status,
  });
}
