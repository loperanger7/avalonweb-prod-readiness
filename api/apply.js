import { Resend } from 'resend';
import { checkRateLimit, clientIp } from './_lib/rate-limit.js';

const resend = new Resend(process.env.RESEND_API_KEY);

const INTERNAL_TO = 'littonjose@gmail.com';
const FROM_INTERNAL = 'Avalon Apply <onboarding@resend.dev>';
const FROM_APPLICANT = 'Avalon Vitality <support@avalonvitality.co>';

// --- Config ------------------------------------------------------------------

const MAX_LEN = {
  firstName: 80,
  lastName: 80,
  email: 254,       // RFC 5321
  phone: 24,
  jobTitle: 120,
  state: 4,
};

const ALLOWED_STATES = new Set(['CA', 'NY', 'TX', 'FL', 'WA', 'OR', 'NV', 'AZ', 'CO', 'IL', 'MA', 'other']);
const ALLOWED_GOALS = new Set([
  'Energy & Focus',
  'Recovery & Sleep',
  'Longevity & Cellular Health',
  'Immunity',
  'Athletic Performance',
  'Stress & Mood',
  'Skin & Beauty',
  'General Wellness',
]);
const ALLOWED_TIERS = new Set(['Starter', 'Premium', 'VIP']);
const ALLOWED_CATEGORIES = new Set(['Vitamins', 'NAD+', 'CBD', 'IV Vitamins']);

const RATE_LIMIT = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
};

// Rate limiter lives in api/_lib/rate-limit.js — KV-backed when provisioned,
// in-memory fallback otherwise. Keys are scoped per route to prevent one
// endpoint's traffic from exhausting another's budget.

// --- Validation --------------------------------------------------------------

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePhone(phone) {
  // Strip everything non-digit. Empty string means "not provided".
  return String(phone || '').replace(/\D/g, '');
}

function looksLikeSpam(str) {
  // Cheap content filter — the big signal is runaway link density.
  const links = (str.match(/https?:\/\//gi) || []).length;
  if (links >= 2) return true;
  if (/<script|onerror=|javascript:/i.test(str)) return true;
  return false;
}

function truncate(str, max) {
  const s = String(str || '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// --- Handler ----------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit first — cheapest check.
  const ip = clientIp(req);
  const limit = await checkRateLimit({
    key: `apply:${ip}`,
    windowMs: RATE_LIMIT.windowMs,
    max: RATE_LIMIT.max,
  });
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    // Honeypot: if the hidden `website` field is filled, it's a bot.
    // Return 200 so the bot sees success and doesn't retry, but do nothing.
    if (body.website) {
      return res.status(200).json({ success: true });
    }

    const firstName = truncate(body.firstName, MAX_LEN.firstName);
    const lastName = truncate(body.lastName, MAX_LEN.lastName);
    const email = truncate(body.email, MAX_LEN.email).toLowerCase();
    const phoneDigits = normalizePhone(body.phone).slice(0, MAX_LEN.phone);
    const jobTitle = truncate(body.jobTitle, MAX_LEN.jobTitle);
    const stateRaw = truncate(body.state, MAX_LEN.state);
    const goalsRaw = Array.isArray(body.goals) ? body.goals : [];
    const membershipsRaw = (body.memberships && typeof body.memberships === 'object') ? body.memberships : {};

    // Required fields
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    if (phoneDigits && phoneDigits.length < 10) {
      return res.status(400).json({ error: 'Phone number appears incomplete.' });
    }

    // Spam content filter across free-text fields
    for (const field of [firstName, lastName, jobTitle]) {
      if (looksLikeSpam(field)) {
        return res.status(400).json({ error: 'Submission flagged. Please contact support@avalonvitality.co.' });
      }
    }

    // Enum-check structured fields
    const state = ALLOWED_STATES.has(stateRaw) ? stateRaw : '';
    const goals = goalsRaw
      .filter((g) => typeof g === 'string' && ALLOWED_GOALS.has(g))
      .slice(0, 8);
    const memberships = {};
    for (const [cat, tier] of Object.entries(membershipsRaw)) {
      if (!ALLOWED_CATEGORIES.has(cat)) continue;
      if (typeof tier !== 'string' || !ALLOWED_TIERS.has(tier)) continue;
      memberships[cat] = tier;
    }

    // --- Build emails ------------------------------------------------------

    const safeFirst = escapeHtml(firstName);
    const safeLast = escapeHtml(lastName);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phoneDigits);
    const safeJobTitle = escapeHtml(jobTitle);
    const safeState = escapeHtml(state);
    const safeIp = escapeHtml(ip);
    const goalsList = goals.length
      ? goals.map((g) => `<li>${escapeHtml(g)}</li>`).join('')
      : '<li><em>None selected</em></li>';
    const membershipRows = Object.keys(memberships).length
      ? Object.entries(memberships).map(([cat, tier]) => `<li><strong>${escapeHtml(cat)}:</strong> ${escapeHtml(tier)}</li>`).join('')
      : '<li><em>None selected</em></li>';

    const internalHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #0a0a0a;">
        <h2 style="font-size: 20px; margin: 0 0 16px;">New membership application</h2>
        <p><strong>Name:</strong> ${safeFirst} ${safeLast}</p>
        <p><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
        <p><strong>Phone:</strong> ${safePhone || '<em>Not provided</em>'}</p>
        <p><strong>State:</strong> ${safeState || '<em>Not provided</em>'}</p>
        <p><strong>Wellness goals:</strong></p>
        <ul>${goalsList}</ul>
        <p><strong>Membership selections:</strong></p>
        <ul>${membershipRows}</ul>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 11px; color: #888;">
          Submitted ${new Date().toISOString()}<br />
          Source IP: ${safeIp}
        </p>
      </div>
    `;

    const applicantHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0a0a0a;">
        <p>Dear ${safeFirst},</p>
        <p>Thank you for applying to Avalon Vitality. We've received your application and our team will review it within 48 hours.</p>
        <p>If approved, you'll receive a follow-up email with next steps for securing your presale membership.</p>
        <p style="margin-top: 24px;">— The Avalon Vitality Team</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="font-size: 11px; color: #888; line-height: 1.5;">
          Avalon Vitality &bull; San Francisco, CA<br />
          This is an automated confirmation. For questions, reply to this email or contact support@avalonvitality.co.
        </p>
      </div>
    `;

    // Both emails are best-effort. The application succeeds regardless of
    // email delivery. A customer should never see an error because Resend is down.
    try {
      const applyResult = await resend.emails.send({
        from: FROM_INTERNAL,
        to: INTERNAL_TO,
        replyTo: email,
        subject: `New Membership Application — ${firstName} ${lastName}`,
        html: internalHtml,
      });
      if (applyResult?.error) {
        console.error('Apply internal email failed:', applyResult.error);
      }
    } catch (err) {
      console.error('Apply internal email threw:', err.message);
    }

    try {
      await resend.emails.send({
        from: FROM_APPLICANT,
        to: email,
        replyTo: INTERNAL_TO,
        subject: 'Your Avalon Vitality application',
        html: applicantHtml,
      });
    } catch (err) {
      console.error('Applicant confirmation email failed:', err.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Apply handler error:', error);
    return res.status(500).json({ error: 'Failed to submit application.' });
  }
}
