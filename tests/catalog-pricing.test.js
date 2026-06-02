import { describe, it, expect } from 'vitest';
import { sanitizeCheckoutItems, sanitizeCheckoutMembership } from '../api/_lib/catalog-pricing.js';

describe('sanitizeCheckoutItems', () => {
  it('returns correct price for known IV protocols', () => {
    const items = [{ key: 'hydration', label: 'Hydration IV' }];
    const result = sanitizeCheckoutItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(150);
  });

  it('returns correct price for NAD+ dosage tiers', () => {
    expect(sanitizeCheckoutItems([{ key: 'nad_250' }])[0].price).toBe(350);
    expect(sanitizeCheckoutItems([{ key: 'nad_500' }])[0].price).toBe(500);
    expect(sanitizeCheckoutItems([{ key: 'nad_750' }])[0].price).toBe(600);
    expect(sanitizeCheckoutItems([{ key: 'nad_1000' }])[0].price).toBe(750);
    expect(sanitizeCheckoutItems([{ key: 'nad_1250' }])[0].price).toBe(950);
    expect(sanitizeCheckoutItems([{ key: 'nad_1500' }])[0].price).toBe(1100);
  });

  it('returns correct price for CBD dosage tiers', () => {
    expect(sanitizeCheckoutItems([{ key: 'cbd_33' }])[0].price).toBe(350);
    expect(sanitizeCheckoutItems([{ key: 'cbd_66' }])[0].price).toBe(450);
    expect(sanitizeCheckoutItems([{ key: 'cbd_99' }])[0].price).toBe(550);
    expect(sanitizeCheckoutItems([{ key: 'cbd_132' }])[0].price).toBe(650);
  });

  it('resolves add-ons by label', () => {
    const items = [{ label: 'B12', type: 'addon' }];
    const result = sanitizeCheckoutItems(items);
    expect(result[0].price).toBe(40);
  });

  it('resolves add-ons by label with fuzzy NAD matching', () => {
    const items = [{ label: 'NAD 500mg booster' }];
    const result = sanitizeCheckoutItems(items);
    expect(result[0].price).toBe(500);
  });

  it('throws 400 for unknown items', () => {
    expect(() => sanitizeCheckoutItems([{ key: 'unknown-thing' }]))
      .toThrow('Unknown checkout item');
  });

  it('returns empty array for empty input', () => {
    expect(sanitizeCheckoutItems([])).toEqual([]);
    expect(sanitizeCheckoutItems(undefined)).toEqual([]);
  });

  it('rejects custom-treatment type (no client-controlled pricing)', () => {
    expect(() => sanitizeCheckoutItems([{ type: 'custom-treatment', price: 200, label: 'Custom' }]))
      .toThrow('Unknown checkout item');
  });

  it('normalizes key prefixes (pkg-, iv-, addon-, im-)', () => {
    expect(sanitizeCheckoutItems([{ key: 'iv-hydration' }])[0].price).toBe(150);
    expect(sanitizeCheckoutItems([{ key: 'pkg-recovery' }])[0].price).toBe(250);
  });
});

describe('sanitizeCheckoutMembership', () => {
  it('returns correct price for known tiers', () => {
    expect(sanitizeCheckoutMembership({ name: 'Starter' }).price).toBe(199);
    expect(sanitizeCheckoutMembership({ name: 'Pro' }).price).toBe(389);
    expect(sanitizeCheckoutMembership({ name: 'VIP' }).price).toBe(899);
  });

  it('defaults to monthly billing', () => {
    expect(sanitizeCheckoutMembership({ name: 'Starter' }).billing).toBe('monthly');
  });

  it('respects annual billing', () => {
    expect(sanitizeCheckoutMembership({ name: 'Starter', billing: 'annual' }).billing).toBe('annual');
  });

  it('throws 400 for unknown tier', () => {
    expect(() => sanitizeCheckoutMembership({ name: 'Platinum' }))
      .toThrow('Unknown membership');
  });

  it('returns null for null/undefined input', () => {
    expect(sanitizeCheckoutMembership(null)).toBeNull();
    expect(sanitizeCheckoutMembership(undefined)).toBeNull();
  });

  it('overrides client-provided price with server-side price', () => {
    const result = sanitizeCheckoutMembership({ name: 'Starter', price: 1 });
    expect(result.price).toBe(199);
  });
});
