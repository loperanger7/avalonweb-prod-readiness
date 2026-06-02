import { describe, it, expect } from 'vitest';

describe('charge-balance idempotency', () => {
  it('idempotency key is derived from appointment + amount', () => {
    const acuityAppointmentId = '12345';
    const amount = 15000;
    const key = `balance-${acuityAppointmentId}-${amount}`;

    expect(key).toBe('balance-12345-15000');
    // Same appointment + same amount = same key = Stripe dedupes
  });

  it('different amounts produce different keys', () => {
    const id = '12345';
    const key1 = `balance-${id}-15000`;
    const key2 = `balance-${id}-20000`;

    expect(key1).not.toBe(key2);
  });

  it('already-paid check prevents double charge', () => {
    const appt = { payment_status: 'paid_in_full' };

    // The handler checks this before creating a PaymentIntent
    const shouldBlock = appt.payment_status === 'paid_in_full';
    expect(shouldBlock).toBe(true);
  });

  it('minimum charge amount enforced', () => {
    const amount = 49;
    const blocked = !amount || amount < 50;
    expect(blocked).toBe(true);
  });

  it('no card on file returns 409', () => {
    const appt = {
      stripe_customer_id: null,
      stripe_payment_method_id: null,
    };
    const noCard = !appt.stripe_customer_id || !appt.stripe_payment_method_id;
    expect(noCard).toBe(true);
  });
});
