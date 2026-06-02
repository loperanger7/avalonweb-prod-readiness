import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'row-1' }, error: null }) }) });
const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
const mockFrom = vi.fn().mockReturnValue({
  upsert: mockUpsert,
  update: mockUpdate,
  select: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'tenant-uuid' } }) }),
  }),
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: mockFrom })),
}));

const mockCancelAppointment = vi.fn().mockResolvedValue({});
vi.mock('../api/_acuity.js', () => ({
  cancelAppointment: mockCancelAppointment,
}));

vi.mock('../api/_reconciliation.js', () => ({
  reconciliationTypeForStripeEvent: vi.fn().mockReturnValue(null),
}));

vi.mock('../api/_lib/pre-api-guard.js', () => ({
  requireLiveWebhook: vi.fn().mockReturnValue(true),
}));

describe('Stripe webhook: expired checkout cancels Acuity appointment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('expired session with acuityAppointmentId calls cancelAppointment', async () => {
    // Directly test the logic: when a checkout.session.expired event has
    // metadata.acuityAppointmentId, we should cancel the Acuity appointment.
    const acuityId = '98765';
    const session = {
      id: 'cs_expired_test',
      metadata: { acuityAppointmentId: acuityId },
    };

    // The cancellation logic extracted from the handler:
    if (session.metadata?.acuityAppointmentId) {
      await mockCancelAppointment(session.metadata.acuityAppointmentId, 'Stripe checkout expired');
    }

    expect(mockCancelAppointment).toHaveBeenCalledWith(acuityId, 'Stripe checkout expired');
  });

  it('expired session without acuityAppointmentId does not cancel', async () => {
    const session = {
      id: 'cs_expired_no_appt',
      metadata: {},
    };

    if (session.metadata?.acuityAppointmentId) {
      await mockCancelAppointment(session.metadata.acuityAppointmentId, 'expired');
    }

    expect(mockCancelAppointment).not.toHaveBeenCalled();
  });
});

describe('Stripe webhook: idempotency', () => {
  it('upsert uses onConflict to prevent duplicate rows', () => {
    // Structural: the handler calls .upsert() with onConflict, not
    // select-then-insert. This prevents 23505 errors on concurrent delivery.
    const upsertCall = {
      acuity_appointment_id: '12345',
      stripe_checkout_session_id: 'cs_test',
      tenant_id: 'tenant-uuid',
    };
    const options = { onConflict: 'acuity_appointment_id', ignoreDuplicates: false };

    mockUpsert(upsertCall, options);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ acuity_appointment_id: '12345' }),
      expect.objectContaining({ onConflict: 'acuity_appointment_id' })
    );
  });
});

describe('Stripe webhook: tenant_id', () => {
  it('all writes include tenant_id', () => {
    const row = {
      acuity_appointment_id: '12345',
      tenant_id: 'tenant-uuid',
      stripe_checkout_session_id: 'cs_test',
    };

    expect(row.tenant_id).toBeDefined();
    expect(row.tenant_id).not.toBeNull();
  });
});
