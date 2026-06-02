import { Resend } from 'resend';
import { checkRateLimit, clientIp } from './_lib/rate-limit.js';

const resend = new Resend(process.env.RESEND_API_KEY);

const INTERNAL_TO = 'littonjose@gmail.com';
const FROM_INTERNAL = 'Avalon Waitlist <onboarding@resend.dev>';
const FROM_SUBSCRIBER = 'Avalon Vitality <support@avalonvitality.co>';

// --- Config ------------------------------------------------------------------

const MAX_LEN = {
  firstName: 80,
  email: 254, // RFC 5321
};

const RATE_LIMIT = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
};

// Rate limiter lives in api/_lib/rate-limit.js. Bucket keyed on `waitlist:${ip}`
// so waitlist traffic doesn't cannibalize /apply's budget (or vice versa).

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

function looksLikeSpam(str) {
  const links = (str.match(/https?:\/\//gi) || []).length;
  if (links >= 1) return true; // waitlist names should never contain URLs
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

  const ip = clientIp(req);
  const limit = await checkRateLimit({
    key: `waitlist:${ip}`,
    windowMs: RATE_LIMIT.windowMs,
    max: RATE_LIMIT.max,
  });
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    // Honeypot — silent success for bots.
    if (body.website) {
      return res.status(200).json({ success: true });
    }

    const firstName = truncate(body.firstName, MAX_LEN.firstName);
    const email = truncate(body.email, MAX_LEN.email).toLowerCase();
    const source = truncate(body.source, 40) || 'waitlist';

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    if (firstName && looksLikeSpam(firstName)) {
      return res.status(400).json({ error: 'Submission flagged. Please contact support@avalonvitality.co.' });
    }

    // --- Build emails ------------------------------------------------------

    const safeFirst = escapeHtml(firstName);
    const safeEmail = escapeHtml(email);
    const safeSource = escapeHtml(source);
    const safeIp = escapeHtml(ip);

    const internalHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #0a0a0a;">
        <h2 style="font-size: 18px; margin: 0 0 16px;">New waitlist signup</h2>
        <p><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
        <p><strong>Name:</strong> ${safeFirst || '<em>Not provided</em>'}</p>
        <p><strong>Source:</strong> ${safeSource}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 11px; color: #888;">
          Submitted ${new Date().toISOString()}<br />
          Source IP: ${safeIp}
        </p>
      </div>
    `;

    const subscriberHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0a0a0a;">
        <p>${safeFirst ? `Hi ${safeFirst},` : 'Hello,'}</p>
        <p>You're on the Avalon Vitality waitlist. We'll send you presale updates, launch details, and early access to new protocols as we open them.</p>
        <p>When you're ready to apply for membership, you can do so any time at <a href="https://avalonvitality.co/apply">avalonvitality.co/apply</a>.</p>
        <p style="margin-top: 24px;">— The Avalon Vitality Team</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="font-size: 11px; color: #888; line-height: 1.5;">
          Avalon Vitality &bull; San Francisco, CA<br />
          To unsubscribe, reply to this email with "unsubscribe".
        </p>
      </div>
    `;

    // Both emails are best-effort. The waitlist signup succeeds regardless of
    // email delivery. A customer should never see an error because Resend is down.
    try {
      const internalResult = await resend.emails.send({
        from: FROM_INTERNAL,
        to: INTERNAL_TO,
        replyTo: email,
        subject: `Waitlist signup — ${email}`,
        html: internalHtml,
      });
      if (internalResult?.error) {
        console.error('Waitlist internal email failed:', internalResult.error);
      }
    } catch (err) {
      console.error('Waitlist internal email threw:', err.message);
    }

    try {
      await resend.emails.send({
        from: FROM_SUBSCRIBER,
        to: email,
        replyTo: INTERNAL_TO,
        subject: "You're on the Avalon Vitality waitlist",
        html: subscriberHtml,
      });
    } catch (err) {
      console.error('Waitlist confirmation email failed:', err.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Waitlist handler error:', error);
    return res.status(500).json({ error: 'Failed to join waitlist.' });
  }
}
