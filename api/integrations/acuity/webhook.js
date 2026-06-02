/**
 * POST /api/integrations/acuity/webhook
 *
 * Receives Acuity scheduling events and syncs them onto the canonical record:
 * public.appointments (the same row Stripe's deposit/balance data attaches to,
 * keyed by acuity_appointment_id). Contact detail is stored in external_payload
 * (jsonb); the CRM of record is Attio (upserted non-blocking).
 *
 * Acuity webhook config: Dashboard → Integrations → Webhooks
 *   URL: https://<domain>/api/integrations/acuity/webhook
 *   Events: scheduled, rescheduled, canceled, changed
 *
 * Idempotency: events deduped by (acuity_appointment_id + action + payload hash).
 * Until Supabase is wired, events are logged and 200'd so Acuity won't retry.
 */

import crypto from 'crypto';
import { getAppointment } from '../../_acuity.js';
import { requireLiveWebhook } from '../../_lib/pre-api-guard.js';
import { buildReconciliationCase } from '../../_reconciliation.js';
import { upsertAttioPerson } from '../../_attio.js';

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

function payloadHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

function safeEqual(left = '', right = '') {
  const l = Buffer.from(left);
  const r = Buffer.from(right);
  if (l.length !== r.length) return false;
  return crypto.timingSafeEqual(l, r);
}

function verifyWebhookSignature(req, body) {
  const secret = process.env.ACUITY_WEBHOOK_SECRET;
  if (!secret) return { required: false, valid: null };
  const supplied = String(
    req.headers?.['x-acuity-signature']
    || req.headers?.['x-webhook-signature']
    || req.headers?.['x-signature']
    || ''
  ).replace(/^sha256=/i, '');
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  return { required: true, valid: Boolean(supplied) && safeEqual(supplied, expected) };
}

const STATUS_BY_ACTION = {
  scheduled:   'scheduled',
  rescheduled: 'scheduled',
  changed:     'scheduled',
  canceled:    'canceled',
};

async function getDefaultTenantId(db) {
  const { data } = await db.from('tenants')
    .select('id').eq('slug', 'avalon-vitality').maybeSingle();
  return data?.id || null;
}

async function upsertAppointment(db, appt, action) {
  const acuityId = String(appt.id);
  const contact = {
    name: `${appt.firstName || ''} ${appt.lastName || ''}`.trim() || null,
    email: appt.email || null,
    phone: appt.phone || null,
  };
  const tenantId = await getDefaultTenantId(db);
  const now = new Date().toISOString();
  const row = {
    acuity_appointment_id: acuityId,
    starts_at:             appt.datetime || appt.date || null,
    status:                STATUS_BY_ACTION[action] || 'scheduled',
    protocol_key:          appt.type || null,
    external_payload:      { provider: 'acuity', action, contact, appointment: appt },
    tenant_id:             tenantId,
    updated_at:            now,
    created_at:            now,
  };

  // Atomic upsert keyed on acuity_appointment_id (UNIQUE partial index from 005).
  const { data, error } = await db.from('appointments').upsert(
    row,
    { onConflict: 'acuity_appointment_id', ignoreDuplicates: false }
  ).select('id').single();

  if (error) {
    console.error('[acuity/webhook] appointment upsert failed:', error.message);
    return null;
  }
  return data?.id || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireLiveWebhook(req, res, { provider: 'acuity', secretEnv: 'ACUITY_WEBHOOK_SECRET' })) return;

  const body = req.body || {};
  const action = body.action; // scheduled | rescheduled | canceled | changed
  const apptId = body.id;
  const signature = verifyWebhookSignature(req, body);

  if (!action || !apptId) {
    return res.status(400).json({ error: 'Missing action or appointment id' });
  }
  if (signature.required && !signature.valid) {
    console.warn(`[acuity/webhook] invalid signature action=${action} apptId=${apptId}`);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const hash = payloadHash(body);
  console.log(`[acuity/webhook] action=${action} apptId=${apptId} hash=${hash}`);

  const db = await getSupabase();
  if (!db) {
    return res.status(200).json({ ok: true, queued: false, note: 'db_not_configured' });
  }

  try {
    // 1. Dedupe + log raw event
    const { data: existingEvent } = await db.from('acuity_events')
      .select('id, processed_status')
      .eq('acuity_appointment_id', String(apptId))
      .eq('action', action)
      .eq('webhook_event_hash', hash)
      .maybeSingle();

    if (existingEvent && existingEvent.processed_status === 'processed') {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const tenantId = await getDefaultTenantId(db);
    const { data: eventRow } = await db.from('acuity_events').upsert({
      webhook_event_hash:    hash,
      acuity_appointment_id: String(apptId),
      action,
      calendar_id:           String(body.calendarID || ''),
      appointment_type_id:   String(body.appointmentTypeID || ''),
      signature_valid:       signature.valid,
      raw_payload_json:      body,
      processed_status:      'pending',
      tenant_id:             tenantId,
      created_at:            new Date().toISOString(),
    }, { onConflict: 'webhook_event_hash', ignoreDuplicates: false }).select().single();
    const eventId = eventRow?.id;

    // 2. canceled — flip status on the canonical row, done.
    if (action === 'canceled') {
      await db.from('appointments')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('acuity_appointment_id', String(apptId));
      if (eventId) await db.from('acuity_events')
        .update({ processed_status: 'processed', processed_at: new Date().toISOString() }).eq('id', eventId);
      return res.status(200).json({ ok: true, action: 'canceled' });
    }

    // 3. scheduled / rescheduled / changed — fetch full appt then upsert canonical row.
    let appt;
    try {
      appt = await getAppointment(apptId);
    } catch (err) {
      if (eventId) {
        await db.from('acuity_events').update({
          processed_status: 'failed', error_message: err.message, processed_at: new Date().toISOString(),
        }).eq('id', eventId);
        await db.from('reconciliation_cases').insert(buildReconciliationCase({
          caseType: 'appointment_drift', provider: 'acuity',
          externalReference: String(apptId), payload: { action, eventId, error: err.message },
        }));
      }
      console.error('[acuity/webhook] fetch appt failed:', err.message);
      return res.status(200).json({ ok: true, note: 'appt_fetch_failed' });
    }

    await upsertAppointment(db, appt, action);

    // CRM sync — non-blocking, contact only (no clinical detail).
    if (appt.email) {
      upsertAttioPerson({
        firstName: appt.firstName, lastName: appt.lastName, email: appt.email, phone: appt.phone,
        source: 'Acuity', lifecycleStage: 'Booked', service: appt.type || 'IV Therapy',
      }).catch((e) => console.warn('[acuity/webhook] Attio sync failed:', e.message));
    }

    if (eventId) await db.from('acuity_events')
      .update({ processed_status: 'processed', processed_at: new Date().toISOString() }).eq('id', eventId);

    return res.status(200).json({ ok: true, action });
  } catch (err) {
    console.error('[acuity/webhook] unhandled error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
