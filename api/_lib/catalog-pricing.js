const ITEM_PRICE_BY_KEY = new Map(Object.entries({
  hydration: 150,
  energy: 250,
  immunity: 250,
  beauty: 250,
  recovery: 250,
  jetlag: 250,
  myers: 250,
  postnight: 250,
  nad: 350,
  nad_250: 350,
  nad_500: 500,
  nad_750: 600,
  nad_1000: 750,
  nad_1250: 950,
  nad_1500: 1100,
  cbd: 350,
  cbd_33: 350,
  cbd_66: 450,
  cbd_99: 550,
  cbd_132: 650,
  exosomes_30: 700,
  exosomes_50: 1200,
  exosomes_90: 1800,
}));

const ADDON_PRICE_BY_LABEL = new Map(Object.entries({
  'extra fluid': 25,
  'extra ingredients': 30,
  'vitamin c iv push 5g': 45,
  'vitamin c iv push 10g': 85,
  'vitamin c iv push 15g': 125,
  'cbd review': 350,
  'cbd review plus': 450,
  'nad 250mg': 350,
  'nad 500mg': 500,
  'nad 1000mg': 750,
  'glutathione push 600mg': 60,
  'glutathione push 1200mg': 100,
  'glutathione push 1800mg': 140,
  'magnesium boost': 30,
  b12: 40,
  mic: 50,
  'nad+': 80,
  'glutathione im 200mg': 50,
  'glutathione im 400mg': 80,
  'vitamin c im 500mg': 30,
  'vitamin c im 1000mg': 45,
}));

const MEMBERSHIP_PRICE_BY_NAME = new Map(Object.entries({
  starter: 199,
  pro: 389,
  premium: 400,
  vip: 899,
  concierge: 899,
}));

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeKey(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/^pkg-/, '')
    .replace(/^iv-/, '')
    .replace(/^addon-/, '')
    .replace(/^im-/, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function priceForItem(item = {}) {
  const key = normalizeKey(item.key || item.cartKey || '');
  if (ITEM_PRICE_BY_KEY.has(key)) return ITEM_PRICE_BY_KEY.get(key);

  const label = normalize(item.label || item.name || '');
  if (ADDON_PRICE_BY_LABEL.has(label)) return ADDON_PRICE_BY_LABEL.get(label);

  if (label.includes('nad') && label.includes('1000')) return 750;
  if (label.includes('nad') && label.includes('500')) return 500;
  if (label.includes('nad') && label.includes('250')) return 350;
  if (label.includes('cbd') && label.includes('review plus')) return 450;
  if (label.includes('cbd')) return 350;

  return null;
}

export function sanitizeCheckoutItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const price = priceForItem(item);
    if (price == null) {
      throw Object.assign(new Error(`Unknown checkout item: ${item?.label || item?.key || 'item'}`), { status: 400 });
    }
    return {
      ...item,
      price,
      label: item.label || item.key || 'Avalon service',
      type: item.type || 'service',
    };
  });
}

export function sanitizeCheckoutMembership(membership = null) {
  if (!membership) return null;
  const key = normalize(membership.name || '');
  const price = MEMBERSHIP_PRICE_BY_NAME.get(key);
  if (price == null && key === 'custom') {
    const proposed = Number(membership.price);
    if (Number.isFinite(proposed) && proposed >= 150 && proposed <= 10000) {
      return {
        ...membership,
        price: proposed,
        billing: membership.billing === 'annual' ? 'annual' : 'monthly',
      };
    }
  }
  if (price == null) {
    throw Object.assign(new Error(`Unknown membership: ${membership.name || 'membership'}`), { status: 400 });
  }
  return {
    ...membership,
    price,
    billing: membership.billing === 'annual' ? 'annual' : 'monthly',
  };
}
