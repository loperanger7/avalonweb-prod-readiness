import Stripe from 'stripe';
import { acuityFetch, cancelAppointment, resolveAppointmentTypeId } from './_acuity.js';
import { sanitizeCheckoutItems, sanitizeCheckoutMembership } from './_lib/catalog-pricing.js';
import { isLiveApiEnabled } from './_lib/pre-api-guard.js';
import { buildCheckoutReconciliationHint } from './_reconciliation.js';
import { getDepositAmountDollars } from '../src/lib/checkoutConfig.js';
import { upsertAttioPerson } from './_attio.js';

const TZ = 'America/Los_Angeles';

function dollarsToCents(value) {
  return Math.max(0, Math.round(Number(value || 0) * 100));
}

function httpError(message, status = 500, code = 'server_error') {
  return Object.assign(new Error(message), { status, code });
}

function assertSafeLiveBaseUrl(baseUrl) {
  if (!isLiveApiEnabled()) return;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw httpError('PUBLIC_SITE_URL must be a valid absolute URL', 503, 'public_site_url_invalid');
  }
  if (/^(localhost|127\.|0\.0\.0\.0)$/i.test(parsed.hostname) || parsed.hostname.endsWith('.local')) {
    throw httpError('PUBLIC_SITE_URL cannot be localhost in live API mode', 503, 'public_site_url_unsafe');
  }
}

function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_SITE_URL?.replace(/\/$/, '');
  if (configured) {
    assertSafeLiveBaseUrl(configured);
    return configured;
  }
  if (isLiveApiEnabled()) {
    throw httpError('PUBLIC_SITE_URL is required before live checkout', 503, 'public_site_url_missing');
  }
  const proto = req.headers?.['x-forwarded-proto'] || 'http';
  const host = req.headers?.host || '127.0.0.1:5173';
  return `${proto}://${host}`;
}

function isDevRequest(req) {
  const host = req?.headers?.host || '';
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

function yesNo(value) {
  return value === true || value === 'true' || value === 'Yes' ? 'Yes' : 'No';
}

function formatAddons(items = []) {
  const addons = items.filter((i) => i.type === 'addon' || i.type === 'im');
  if (!addons.length) return null;
  return addons.map((a) => {
    const label = a.label || a.key || 'Add-on';
    // Capture tiered dosage hints embedded in label (e.g. "Vitamin C — High Dose 25g")
    return `  • ${label}${a.price ? ` ($${a.price})` : ''}`;
  }).join('\n');
}

function appointmentNotes({ appointment = {}, items = [], membership = null, req = null }) {
  const ivItems = items.filter((i) => i.type === 'iv');
  const addonBlock = formatAddons(items);
  const isTest = isDevRequest(req);

  const sections = [
    isTest ? '⚠️  [TEST BOOKING — NOT A REAL APPOINTMENT]' : null,
    '━━━ BOOKING DETAILS ━━━',
    appointment.address        ? `📍 Address: ${appointment.address}` : null,
    appointment.timeLabel      ? `🕐 Time: ${appointment.timeLabel}` : null,
    appointment.guests && appointment.guests !== '1'
                               ? `👥 Guests: ${appointment.guests}` : null,

    ivItems.length             ? `\n💉 PROTOCOL\n${ivItems.map((i) => `  • ${i.label} ($${i.price})`).join('\n')}` : null,
    addonBlock                 ? `\n➕ ADD-ONS\n${addonBlock}` : null,
    membership                 ? `\n📋 MEMBERSHIP\n  • ${membership.name} – ${membership.billing} ($${membership.price})` : null,

    appointment.dob            ? `\n🏥 MEDICAL\n  DOB: ${appointment.dob}` : null,
    appointment.medicalConditions && appointment.medicalConditions !== 'None of the above'
                               ? `  Conditions: ${appointment.medicalConditions}` : null,
    appointment.covidPositive === 'Yes'
                               ? '  ⚠️  COVID positive in last 14 days' : null,
    appointment.infectiousDisease === 'Yes'
                               ? '  ⚠️  Active infectious disease' : null,
    appointment.ivBefore       ? `  IV before: ${appointment.ivBefore}` : null,
    appointment.allergies      ? `  Allergies: ${appointment.allergies}` : null,
    appointment.medications    ? `  Medications: ${appointment.medications}` : null,
    appointment.emergencyContact
                               ? `  Emergency contact: ${appointment.emergencyContact}` : null,

    appointment.notes          ? `\n📝 CLIENT NOTES\n  ${appointment.notes}` : null,
    isTest ? '\n⚠️  [TEST — DO NOT DISPATCH]' : null,
  ].filter(Boolean);

  return sections.join('\n');
}

function requiresSpecialConsent(items = [], appointmentTypeID, needle) {
  const haystack = `${appointmentTypeID} ${items.map((item) => `${item.cartKey || item.key || ''} ${item.label || ''}`).join(' ')}`.toLowerCase();
  return haystack.includes(needle);
}

function requiredSchedulingFields(appointment = {}, items = [], appointmentTypeID = '') {
  const medicalConditions = appointment.medicalConditions || 'None of the above';
  const fields = [
    { id: 16968986, value: appointment.dob || '' },
    { id: 16968987, value: appointment.address || '' },
    { id: 16978048, value: appointment.guests || '1' },
    { id: 16968998, value: appointment.covidPositive || 'No' },
    { id: 16978067, value: appointment.infectiousDisease || 'No' },
    { id: 16968997, value: appointment.ivBefore || 'Yes' },
    { id: 16969005, value: medicalConditions },
    { id: 16969010, value: appointment.allergies || '' },
    { id: 16969009, value: appointment.medications || '' },
    { id: 16968994, value: appointment.emergencyContact || '' },
    { id: 16969698, value: appointment.additionalComments || '' },
    { id: 16969017, value: yesNo(appointment.privacyAck) },
    { id: 16969015, value: yesNo(appointment.treatmentConsent) },
    { id: 16969719, value: yesNo(appointment.generalConsent) },
  ];

  if (requiresSpecialConsent(items, appointmentTypeID, 'cbd')) {
    fields.push({ id: 16969724, value: yesNo(appointment.cbdConsent) });
  }
  if (requiresSpecialConsent(items, appointmentTypeID, 'nad')) {
    fields.push({ id: 16969727, value: yesNo(appointment.nadConsent) });
  }

  return fields;
}

async function createSchedulingAppointment({ appointment, contact, items, membership, req }) {
  if (!appointment?.acuityDatetime) return null;

  const appointmentTypeID = Number(appointment.acuityTypeId)
    || resolveAppointmentTypeId(items, membership);

  if (!appointmentTypeID) {
    throw Object.assign(new Error('Appointment type is not configured'), { status: 400 });
  }

  return acuityFetch('/appointments', {
    method: 'POST',
    body: JSON.stringify({
      appointmentTypeID,
      datetime: appointment.acuityDatetime,
      firstName: contact.firstName,
      lastName: contact.lastName || '',
      email: contact.email,
      phone: contact.phone || '',
      timezone: appointment.acuityTimezone || TZ,
      notes: appointmentNotes({ appointment, items, membership, req }),
      fields: requiredSchedulingFields(appointment, items, appointmentTypeID),
    }),
  });
}

function stripeLineItems(items = [], membership = null, { depositOnly = false, depositAmount = getDepositAmountDollars(process.env) } = {}) {
  const lineItems = depositOnly && items.length
    ? [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: dollarsToCents(depositAmount),
          product_data: {
            name: 'Avalon appointment deposit',
            metadata: { type: 'deposit' },
          },
        },
      }]
    : items.map((item) => ({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: dollarsToCents(item.price),
          product_data: {
            name: item.label || 'Avalon Visit',
            metadata: { type: item.type || 'service', key: item.key || item.cartKey || '' },
          },
        },
      }));

  if (membership) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: dollarsToCents(membership.price),
        recurring: { interval: membership.billing === 'annual' ? 'year' : 'month' },
        product_data: {
          name: `${membership.name} Subscription`,
          metadata: { type: 'subscription' },
        },
      },
    });
  }

  return lineItems;
}

function checkoutExpiresAt() {
  const rawMinutes = Number.parseInt(process.env.STRIPE_CHECKOUT_EXPIRES_MINUTES || '30', 10);
  const minutes = Number.isFinite(rawMinutes)
    ? Math.min(24 * 60, Math.max(30, rawMinutes))
    : 30;
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    mode = 'payment',
    items: rawItems = [],
    membership: rawMembership = null,
    contact = {},
    appointment = {},
    paymentMethod = 'card',
  } = req.body || {};

  if (!contact.firstName || !contact.email) {
    return res.status(400).json({ error: 'First name and email are required' });
  }

  let acuityAppointment = null;
  try {
    const items = sanitizeCheckoutItems(rawItems);
    const membership = sanitizeCheckoutMembership(rawMembership);

    if (!items.length && !membership) {
      return res.status(400).json({ error: 'No items to checkout' });
    }

    const baseUrl = publicBaseUrl(req);

    if (!isLiveApiEnabled()) {
      const localId = `local-${Date.now()}`;
      const successUrl = `${baseUrl}/booking/confirmation?appointment=${encodeURIComponent(localId)}&preapi=1`;
      return res.status(200).json({
        ok: true,
        provider: 'local-simulation',
        previewOnly: true,
        preApiHardWall: true,
        code: 'pre_api_hard_wall',
        appointment: {
          id: localId,
          provider: 'local-simulation',
          type: items[0]?.label || membership?.name || 'Avalon local simulation',
          datetime: appointment.acuityDatetime || null,
          preApi: true,
        },
        url: successUrl,
      });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({
        error: 'Secure checkout is not configured',
        code: 'payment_provider_missing',
      });
    }

    acuityAppointment = await createSchedulingAppointment({
      appointment,
      contact,
      items,
      membership,
      req,
    });

    const successUrl = `${baseUrl}/booking/confirmation${acuityAppointment?.id ? `?appointment=${encodeURIComponent(acuityAppointment.id)}` : ''}`;
    const successJoiner = successUrl.includes('?') ? '&' : '?';
    const cancelUrl = `${baseUrl}/checkout`;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const visitSubtotal = items.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const hasVisitItems = items.length > 0;
    const depositAmount = getDepositAmountDollars(process.env);
    const line_items = stripeLineItems(items, membership, {
      depositOnly: hasVisitItems,
      depositAmount,
    });

    if (!line_items.length) {
      return res.status(400).json({ error: 'No items to checkout' });
    }

    const sessionMode = mode === 'subscription' || membership ? 'subscription' : 'payment';
    const visitSubtotalCents = dollarsToCents(visitSubtotal);
    const depositCents = dollarsToCents(depositAmount);
    const balanceDueCents = hasVisitItems ? Math.max(0, visitSubtotalCents - depositCents) : 0;
    const primaryService = items[0]?.label || membership?.name || 'Avalon Visit';

    const sessionParams = {
      mode: sessionMode,
      customer_email: contact.email,
      line_items,
      expires_at: checkoutExpiresAt(),
      success_url: `${successUrl}${successJoiner}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        acuityAppointmentId: acuityAppointment?.id ? String(acuityAppointment.id) : '',
        customerName: contact.name || `${contact.firstName} ${contact.lastName || ''}`.trim(),
        phone: contact.phone || '',
        paymentMethod: paymentMethod || 'card',
        service: primaryService,
        visitSubtotalCents: String(visitSubtotalCents),
        depositAmountCents: String(depositCents),
        balanceDueCents: String(balanceDueCents),
      },
    };

    // Deposit (one-time payment): save the card on file so the nurse can charge
    // the remaining balance off-session at the end of the appointment.
    if (sessionMode === 'payment') {
      sessionParams.payment_intent_data = { setup_future_usage: 'off_session' };
    }

    const idempotencyKey = `checkout-${contact.email}-${Date.now()}`;
    const session = await stripe.checkout.sessions.create(sessionParams, { idempotencyKey });

    // Sync the client into Attio CRM — non-blocking, never fails the booking.
    // CRM-safe: contact + lifecycle only, no clinical/intake details.
    upsertAttioPerson({
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      source: 'Avalon Booking',
      lifecycleStage: 'Deposit Pending',
      service: primaryService,
    }).catch((e) => console.warn('[create-checkout-session] Attio sync failed:', e.message));

    return res.status(200).json({
      ok: true,
      provider: 'stripe',
      appointment: acuityAppointment,
      balanceDueCents,
      url: session.url,
    });
  } catch (err) {
    if (acuityAppointment?.id) {
      try {
        await cancelAppointment(acuityAppointment.id, 'Stripe checkout failed before payment confirmation.');
      } catch (rollbackErr) {
        console.error('[create-checkout-session:rollback]', rollbackErr.message);
      }
    }
    const reconciliation = buildCheckoutReconciliationHint({ acuityAppointment, error: err });
    console.error('[create-checkout-session]', err.message, err.status || '', reconciliation?.case_type || '');
    return res.status(err.status || 500).json({
      error: err.message || 'Checkout failed',
      reconciliation: reconciliation
        ? {
            caseType: reconciliation.case_type,
            ownerRole: reconciliation.owner_role,
            externalReference: reconciliation.external_reference,
            requiredAction: reconciliation.payload.required_action,
          }
        : null,
    });
  }
}
