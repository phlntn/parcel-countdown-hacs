/**
 * Node fixture tests for the card's pure data layer.
 *
 * The card is a browser ES module, so stub the handful of globals it touches at
 * load time, then import it from a data: URL (always parsed as ESM regardless of
 * this repo having no package.json).
 *
 *   node test/run.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

globalThis.HTMLElement = class {
  attachShadow() { return { replaceChildren() {}, querySelectorAll: () => [] }; }
};
globalThis.customElements = { define() {}, get: () => undefined, whenDefined: () => Promise.resolve() };
globalThis.document = { createElement: () => ({ style: { setProperty() {} } }) };
globalThis.window = globalThis;
globalThis.CustomEvent = class {};

const source = await readFile(path.join(here, '..', 'dist', 'parcel-countdown-hacs.js'));
const card = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

const { deliveries } = JSON.parse(await readFile(path.join(here, 'fixtures.json'), 'utf8'));

// Fixed "now" so the assertions below are stable: 2026-08-20 08:00 local.
const NOW = new Date(2026, 7, 20, 8, 0, 0);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('parseEta');
test('prefers timestamp_expected (epoch seconds)', () => {
  const eta = card.parseEta(deliveries[1]);
  assert.equal(eta.getTime(), 1787216400 * 1000);
});
test('accepts epoch milliseconds', () => {
  const eta = card.parseEta(deliveries[11]);
  assert.equal(eta.getTime(), 1787616000000);
});
test('parses "YYYY-MM-DD HH:MM:SS" as local time', () => {
  const eta = card.parseEta({ date_expected: '2026-08-22 00:00:00' });
  assert.equal(eta.getFullYear(), 2026);
  assert.equal(eta.getMonth(), 7);
  assert.equal(eta.getDate(), 22);
  assert.equal(eta.getHours(), 0);
});
test('returns null for a missing date', () => {
  assert.equal(card.parseEta({ tracking_number: 'X' }), null);
});
test('returns null for a malformed date', () => {
  assert.equal(card.parseEta({ date_expected: 'not-a-date' }), null);
});
test('returns null for an impossible date (2026-02-31)', () => {
  assert.equal(card.parseEta({ date_expected: '2026-02-31 00:00:00' }), null);
});
test('survives null/undefined input', () => {
  assert.equal(card.parseEta(null), null);
  assert.equal(card.parseEta(undefined), null);
});

console.log('daysUntil');
test('today is 0', () => {
  assert.equal(card.daysUntil(new Date(2026, 7, 20, 23, 59), NOW), 0);
});
test('tomorrow just after midnight is 1', () => {
  assert.equal(card.daysUntil(new Date(2026, 7, 21, 0, 30), NOW), 1);
});
test('the past is negative', () => {
  assert.equal(card.daysUntil(new Date(2026, 7, 17, 12, 0), NOW), -3);
});
test('crosses a DST boundary cleanly', () => {
  // 25 Oct 2026 is the UK/EU clock change; 7 calendar days must stay 7.
  const from = new Date(2026, 9, 22, 12, 0);
  assert.equal(card.daysUntil(new Date(2026, 9, 29, 12, 0), from), 7);
});
test('null date yields null', () => {
  assert.equal(card.daysUntil(null, NOW), null);
});

console.log('buildRows');
const rows = card.buildRows(deliveries, {}, NOW);
test('hides delivered packages by default', () => {
  assert.ok(!rows.some((r) => r.code === 0));
});
test('a wide retention window brings delivered packages back', () => {
  const kept = card.buildRows(deliveries, { hide_delivered_after: 30 }, NOW);
  const delivered = deliveries.filter((d) => d.status_code === 0).length;
  assert.equal(kept.length, rows.length + delivered);
});
test('a delivered package dated only by a worded event is hidden on time', () => {
  // Its arrival exists solely as "August 17, 2026 09:19". If that fails to
  // parse it counts as having just landed and wrongly survives the filter.
  const ids = card.buildRows(deliveries, {}, NOW).map((r) => r.tracking);
  assert.ok(!ids.includes('WD0008'), 'delivered 3 days ago, retention is 1 day');
  assert.ok(
    card.buildRows(deliveries, { hide_delivered_after: 30 }, NOW)
      .map((r) => r.tracking).includes('WD0008'),
  );
});
test('sorts soonest first', () => {
  const dated = rows.filter((r) => r.days !== null).map((r) => r.days);
  assert.deepEqual(dated, [...dated].sort((a, b) => a - b));
});
test('overdue packages come first and are negative', () => {
  assert.equal(rows[0].tracking, 'CP987654321US');
  assert.equal(rows[0].days, -3);
});
test('undated packages sort last', () => {
  const firstUndated = rows.findIndex((r) => r.days === null);
  assert.ok(firstUndated > 0);
  assert.ok(rows.slice(firstUndated).every((r) => r.days === null));
});
test('undated packages include malformed and impossible dates', () => {
  const undated = rows.filter((r) => r.days === null).map((r) => r.tracking).sort();
  assert.deepEqual(undated, ['BAD0003', 'BAD0004', 'LX123456789GB', 'NULLROW']);
});
test('show_no_eta: false drops undated packages', () => {
  const only = card.buildRows(deliveries, { show_no_eta: false }, NOW);
  assert.ok(only.every((r) => r.days !== null));
});
test('falls back to the tracking number when description is missing', () => {
  const row = rows.find((r) => r.tracking === 'NODESC0001');
  assert.equal(row.name, 'NODESC0001');
});
test('max truncates the list', () => {
  assert.equal(card.buildRows(deliveries, { max: 3 }, NOW).length, 3);
});
test('max: 0 means all', () => {
  assert.equal(card.buildRows(deliveries, { max: 0 }, NOW).length, rows.length);
});
test('picks the most recent event regardless of array order', () => {
  const row = rows.find((r) => r.tracking === '1Z999AA10123456784');
  assert.equal(row.event.event, 'Arrived at facility');
});
test('tolerates a null events array', () => {
  const row = rows.find((r) => r.tracking === 'NULLROW');
  assert.equal(row.event, null);
});
test('handles a missing/garbage deliveries attribute', () => {
  assert.deepEqual(card.buildRows(undefined, {}, NOW), []);
  assert.deepEqual(card.buildRows(null, {}, NOW), []);
  assert.deepEqual(card.buildRows('nope', {}, NOW), []);
  assert.deepEqual(card.buildRows([], {}, NOW), []);
  assert.deepEqual(card.buildRows([null, 42, 'x'], {}, NOW), []);
});
test('scales to 20+ packages', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    description: `Package ${i}`,
    tracking_number: `T${i}`,
    carrier_code: 'ups',
    status_code: 2,
    date_expected: `2026-09-${String((i % 28) + 1).padStart(2, '0')} 00:00:00`,
  }));
  assert.equal(card.buildRows(many, {}, NOW).length, 25);
});

console.log('glyphs');
test('0 today, ! overdue, – undated, ✓ delivered', () => {
  assert.equal(card.countdownGlyph({ code: 2, days: 0 }), '0');
  assert.equal(card.countdownGlyph({ code: 2, days: -1 }), '!');
  assert.equal(card.countdownGlyph({ code: 2, days: null }), '–');
  assert.equal(card.countdownGlyph({ code: 0, days: -2 }), '✓');
  assert.equal(card.countdownGlyph({ code: 2, days: 12 }), '12');
});
test('tone classes', () => {
  assert.equal(card.countdownTone({ code: 2, days: -1 }), 'warn');
  assert.equal(card.countdownTone({ code: 2, days: 0 }), 'soon');
  assert.equal(card.countdownTone({ code: 2, days: 1 }), '');
  assert.equal(card.countdownTone({ code: 2, days: 5 }), '');
  assert.equal(card.countdownTone({ code: 2, days: null }), 'muted');
  assert.equal(card.countdownTone({ code: 0, days: 0 }), 'done');
});

console.log('resolveView diagnostics');
const ok = { state: '5', attributes: { deliveries } };

test('missing entity names the entity and points at the disabled default', () => {
  const { rows, message } = card.resolveView('sensor.nope', undefined, {}, NOW);
  assert.deepEqual(rows, []);
  assert.match(message.text, /Entity not found: sensor\.nope/);
  assert.match(message.hint, /disabled/);
  assert.equal(message.alert, true);
});
test('unavailable entity is reported as unavailable', () => {
  const { message } = card.resolveView('sensor.p', { state: 'unavailable', attributes: {} }, {}, NOW);
  assert.match(message.text, /is unavailable/);
  assert.equal(message.alert, true);
});
test('wrong sensor names the missing attribute', () => {
  const { message } = card.resolveView(
    'sensor.parcel_active_shipment', { state: '2', attributes: { count: 2 } }, {}, NOW);
  assert.match(message.text, /has no "deliveries" attribute/);
  assert.match(message.text, /sensor\.parcel_active_shipment/);
  assert.match(message.hint, /raw shipment data/);
  assert.equal(message.alert, true);
});
test('a non-array deliveries attribute is treated the same way', () => {
  const { message } = card.resolveView('sensor.p', { state: '1', attributes: { deliveries: 'nope' } }, {}, NOW);
  assert.match(message.text, /has no "deliveries" attribute/);
});
test('genuinely empty is not an error', () => {
  const { message } = card.resolveView('sensor.p', { state: '0', attributes: { deliveries: [] } }, {}, NOW);
  assert.equal(message.text, 'No packages');
  assert.equal(message.alert, false);
});
test('a working entity yields rows and no message', () => {
  const { rows, message } = card.resolveView('sensor.p', ok, {}, NOW);
  assert.equal(message, null);
  assert.ok(rows.length > 0);
});
test('filters that hide everything say what they hid', () => {
  const onlyDelivered = [
    { description: 'A', tracking_number: 'A', status_code: 0, date_expected: '2026-08-18 00:00:00' },
    { description: 'B', tracking_number: 'B', status_code: 0, date_expected: '2026-08-19 00:00:00' },
  ];
  const { rows, message } = card.resolveView('sensor.p', { state: '2', attributes: { deliveries: onlyDelivered } }, {}, NOW);
  assert.deepEqual(rows, []);
  assert.equal(message.text, 'Nothing to show');
  assert.match(message.hint, /2 delivered/);
  assert.equal(message.alert, false);
});
test('counts both hidden categories', () => {
  const mixed = [
    { description: 'A', tracking_number: 'A', status_code: 0, date_expected: '2026-08-18 00:00:00' },
    { description: 'B', tracking_number: 'B', status_code: 2 },
  ];
  const hint = card.describeFilters(mixed, { show_no_eta: false }, NOW);
  assert.match(hint, /1 delivered more than 1 day ago and 1 with no delivery estimate/);
});
test('falls back to a generic count when no filter explains it', () => {
  assert.match(card.describeFilters([{ status_code: 2 }], {}, NOW), /All 1 package is hidden/);
});
test('a delivery inside the retention window is not blamed on the filters', () => {
  // Delivered today, kept for 30 days: nothing here was filtered out.
  const recent = [{ tracking_number: 'R', status_code: 0, date_expected: '2026-08-20 00:00:00' }];
  assert.match(card.describeFilters(recent, { hide_delivered_after: 30 }, NOW), /All 1 package is hidden/);
});
test('a stale delivery is reported with its age', () => {
  const stale = [{ tracking_number: 'S', status_code: 0, date_expected: '2020-01-01 00:00:00' }];
  assert.match(
    card.describeFilters(stale, { hide_delivered_after: 30 }, NOW),
    /1 delivered more than 30 days ago/,
  );
});
test('a zero retention window is worded without a day count', () => {
  const any = [{ tracking_number: 'Z', status_code: 0, date_expected: '2026-08-20 00:00:00' }];
  assert.match(card.describeFilters(any, { hide_delivered_after: 0 }, NOW), /1 already delivered/);
});

console.log('tracking links');
const rowFor = (t) => rows.find((r) => r.tracking === t);

test('known carriers map to their tracking page', () => {
  assert.equal(
    card.trackingUrl({ tracking: '1Z999AA10123456784', carrier: 'ups' }),
    'https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784',
  );
});
test('carrier codes are matched case- and punctuation-insensitively', () => {
  const a = card.trackingUrl({ tracking: 'LX1', carrier: 'royal-mail' });
  const b = card.trackingUrl({ tracking: 'LX1', carrier: 'Royal Mail' });
  const c = card.trackingUrl({ tracking: 'LX1', carrier: 'ROYALMAIL' });
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(a, /royalmail\.com/);
});
test('unknown carriers fall back to a search', () => {
  const url = card.trackingUrl({ tracking: 'ZZZ123', carrier: 'some-regional-courier' });
  assert.match(url, /google\.com\/search/);
  assert.match(url, /ZZZ123/);
});
test('config carriers override the built-in map', () => {
  const url = card.trackingUrl(
    { tracking: 'ABC', carrier: 'ups' },
    { UPS: 'https://example.test/{tracking}?c={carrier}' },
  );
  assert.equal(url, 'https://example.test/ABC?c=ups');
});
test('config carriers add unknown carriers', () => {
  const url = card.trackingUrl({ tracking: 'Q1', carrier: 'my-courier' }, { 'My Courier': 'https://x.test/{tracking}' });
  assert.equal(url, 'https://x.test/Q1');
});
test('non-string override values are ignored', () => {
  const url = card.trackingUrl({ tracking: 'Q1', carrier: 'ups' }, { ups: 42 });
  assert.match(url, /ups\.com/);
});
test('tracking numbers are URL-encoded', () => {
  const url = card.trackingUrl({ tracking: 'A B&C', carrier: 'nope' });
  assert.ok(!url.includes(' '));
  assert.match(url, /A%20B%26C/);
});
test('no tracking number means no link', () => {
  assert.equal(card.trackingUrl({ tracking: '', carrier: 'ups' }), null);
  assert.equal(card.trackingUrl(null), null);
});
test('every fixture row with a tracking number resolves to a URL', () => {
  for (const row of rows) {
    if (row.tracking) assert.match(card.trackingUrl(row), /^https:\/\//);
  }
});

console.log('delivery windows');
test('window duration is carried onto an absolute-epoch ETA, not compared to it', () => {
  // date_expected/_end are local wall-clock; timestamp_expected is absolute.
  // The window must stay 4h wide and hang off the epoch ETA, whatever the tz.
  const delivery = {
    date_expected: '2026-08-20 09:00:00',
    date_expected_end: '2026-08-20 13:00:00',
    timestamp_expected: 1787216400,
  };
  const eta = card.parseEta(delivery);
  const end = card.etaWindowEnd(delivery, eta);
  assert.equal(end.getTime() - eta.getTime(), 4 * 3600 * 1000);
});
test('a wall-clock-only window is used directly', () => {
  const delivery = { date_expected: '2026-08-20 09:00:00', date_expected_end: '2026-08-20 13:00:00' };
  const eta = card.parseEta(delivery);
  assert.equal(card.etaWindowEnd(delivery, eta).getHours(), 13);
});
test('an end without a start is only used if it is later than the ETA', () => {
  const eta = new Date(2026, 7, 20, 12, 0);
  assert.equal(card.etaWindowEnd({ date_expected_end: '2026-08-20 09:00:00' }, eta), null);
  assert.ok(card.etaWindowEnd({ date_expected_end: '2026-08-20 15:00:00' }, eta));
});
test('a backwards or missing window yields null', () => {
  const d = { date_expected: '2026-08-20 13:00:00', date_expected_end: '2026-08-20 09:00:00' };
  assert.equal(card.etaWindowEnd(d, card.parseEta(d)), null);
  assert.equal(card.etaWindowEnd({ date_expected: '2026-08-20 09:00:00' }, new Date()), null);
  assert.equal(card.etaWindowEnd(null, new Date()), null);
  assert.equal(card.etaWindowEnd({}, null), null);
});

console.log('link safety');
test('a javascript: template never becomes a link', () => {
  assert.equal(
    card.trackingUrl({ tracking: 'X', carrier: 'evil' }, { evil: 'javascript:alert(1)' }),
    null,
  );
});
test('other non-http schemes are rejected too', () => {
  assert.equal(card.trackingUrl({ tracking: 'X', carrier: 'e' }, { e: 'data:text/html,hi' }), null);
  assert.equal(card.trackingUrl({ tracking: 'X', carrier: 'e' }, { e: '/relative/path' }), null);
});
test('http and https templates are allowed', () => {
  assert.match(card.trackingUrl({ tracking: 'X', carrier: 'e' }, { e: 'http://x.test/{tracking}' }), /^http:/);
  assert.match(card.trackingUrl({ tracking: 'X', carrier: 'e' }, { e: 'https://x.test/{tracking}' }), /^https:/);
});

console.log('entity discovery');
const stateWith = (attrs) => ({ state: '1', attributes: attrs });
test('prefers the documented entity when it carries deliveries', () => {
  const hass = { states: {
    'sensor.parcel_active_shipment': stateWith({ count: 2 }),
    'sensor.parcel_raw_shipment_data': stateWith({ deliveries: [] }),
  } };
  assert.equal(card.findParcelEntity(hass), 'sensor.parcel_raw_shipment_data');
});
test('prefers any sensor carrying deliveries over a name match', () => {
  const hass = { states: {
    'sensor.parcel_active_shipment': stateWith({ count: 2 }),
    'sensor.shipments_raw': stateWith({ deliveries: [] }),
  } };
  assert.equal(card.findParcelEntity(hass), 'sensor.shipments_raw');
});
test('falls back to a name match when nothing carries deliveries', () => {
  const hass = { states: { 'sensor.parcel_active_shipment': stateWith({ count: 2 }) } };
  assert.equal(card.findParcelEntity(hass), 'sensor.parcel_active_shipment');
});
test('falls back to the documented id with no hass at all', () => {
  assert.equal(card.findParcelEntity(undefined), 'sensor.parcel_raw_shipment_data');
  assert.equal(card.findParcelEntity({ states: {} }), 'sensor.parcel_raw_shipment_data');
});

console.log('delivered packages');
const deliveredSet = [
  { description: 'Landed today', tracking_number: 'D0', carrier_code: 'ups', status_code: 0,
    date_expected: '2026-08-20 00:00:00',
    events: [{ event: 'Delivered', date: '2026-08-20 08:30:00', location: 'Front desk' }] },
  { description: 'Landed yesterday', tracking_number: 'D1', carrier_code: 'ups', status_code: 0,
    date_expected: '2026-08-19 00:00:00',
    events: [{ event: 'Delivered', date: '2026-08-19 16:00:00', location: 'Porch' }] },
  { description: 'Landed three days ago', tracking_number: 'D3', carrier_code: 'ups', status_code: 0,
    date_expected: '2026-08-17 00:00:00',
    events: [{ event: 'Delivered', date: '2026-08-17 09:00:00', location: 'Porch' }] },
  { description: 'Arriving tomorrow', tracking_number: 'T1', carrier_code: 'ups', status_code: 2,
    date_expected: '2026-08-21 00:00:00' },
];
const kept = (n) => card.buildRows(deliveredSet, { hide_delivered_after: n }, NOW)
  .map((r) => r.tracking);

test('0 hides a delivery the moment it lands', () => {
  assert.deepEqual(kept(0), ['T1']);
});
test('1 keeps it for the rest of the delivery day only', () => {
  assert.deepEqual(kept(1), ['D0', 'T1']);
});
test('2 also keeps yesterday', () => {
  assert.deepEqual(kept(2), ['D1', 'D0', 'T1']);
});
test('4 reaches back three days', () => {
  assert.deepEqual(kept(4), ['D3', 'D1', 'D0', 'T1']);
});
test('rows read as one timeline, oldest first', () => {
  const order = card.buildRows(deliveredSet, { hide_delivered_after: 30 }, NOW);
  assert.deepEqual(order.map((r) => r.tracking), ['D3', 'D1', 'D0', 'T1']);
  const days = order.map((r) => r.sortDay);
  assert.deepEqual(days, [...days].sort((a, b) => a - b), 'sort keys must be monotonic');
  assert.deepEqual(days, [-3, -1, 0, 1]);
});
test('an overdue package interleaves with deliveries of the same age', () => {
  const mixed = [
    ...deliveredSet,
    { description: 'Overdue', tracking_number: 'OD', carrier_code: 'ups', status_code: 1,
      date_expected: '2026-08-19 00:00:00' },
  ];
  const order = card.buildRows(mixed, { hide_delivered_after: 30 }, NOW)
    .map((r) => r.tracking);
  // OD is due 19 Aug, the same day D1 landed: delivered leads within a day.
  assert.deepEqual(order, ['D3', 'D1', 'OD', 'D0', 'T1']);
});
test('a delivery precedes a same-day estimate', () => {
  const sameDay = [
    { description: 'Due today', tracking_number: 'DUE', status_code: 2, date_expected: '2026-08-20 00:00:00' },
    { description: 'Arrived today', tracking_number: 'GOT', status_code: 0,
      date_expected: '2026-08-20 00:00:00',
      events: [{ event: 'Delivered', date: '2026-08-20 09:15:00' }] },
  ];
  const order = card.buildRows(sameDay, { hide_delivered_after: 1 }, NOW).map((r) => r.tracking);
  assert.deepEqual(order, ['GOT', 'DUE']);
});
test('an undated delivery counts as having just landed', () => {
  const undated = [{ description: 'No dates', tracking_number: 'U', status_code: 0 }];
  assert.equal(card.buildRows(undated, { hide_delivered_after: 1 }, NOW).length, 1);
  assert.equal(card.buildRows(undated, { hide_delivered_after: 0 }, NOW).length, 0);
});
test('the retention window defaults to the delivery day', () => {
  assert.deepEqual(card.buildRows(deliveredSet, {}, NOW).map((r) => r.tracking), ['D0', 'T1']);
});
test('undated packages still sort last', () => {
  const withUndated = [
    ...deliveredSet,
    { description: 'No estimate', tracking_number: 'NE', status_code: 8 },
  ];
  const order = card.buildRows(withUndated, { hide_delivered_after: 30 }, NOW)
    .map((r) => r.tracking);
  assert.equal(order[order.length - 1], 'NE');
});
test('deliveredAt prefers the last tracking event over the estimate', () => {
  const d = deliveredSet[0];
  const at = card.deliveredAt(d, card.parseEta(d));
  assert.equal(at.getHours(), 8);
  assert.equal(at.getMinutes(), 30);
});
test('deliveredAt falls back to the estimate with no events', () => {
  const d = { status_code: 0, date_expected: '2026-08-19 00:00:00' };
  assert.equal(card.deliveredAt(d, card.parseEta(d)).getDate(), 19);
});
test('deliveredAt is null when nothing is dated', () => {
  assert.equal(card.deliveredAt({ status_code: 0 }, null), null);
});
test('show_no_eta does not strip an undated delivered package', () => {
  const undated = [{ description: 'No dates', tracking_number: 'U', status_code: 0 }];
  assert.equal(card.buildRows(undated, { show_no_eta: false, hide_delivered_after: 1 }, NOW).length, 1);
});

console.log('severity tiers');
test('exceptions and failed attempts are red', () => {
  assert.equal(card.countdownTone({ code: 6, days: 2 }), 'alert');
  assert.equal(card.countdownTone({ code: 7, days: 2 }), 'alert');
});
test('an overdue exception stays red rather than softening to amber', () => {
  assert.equal(card.countdownTone({ code: 7, days: -4 }), 'alert');
});
test('stalled and awaiting pickup are amber even when on time', () => {
  assert.equal(card.countdownTone({ code: 1, days: 3 }), 'warn');
  assert.equal(card.countdownTone({ code: 3, days: 3 }), 'warn');
});
test('merely overdue is amber, not red', () => {
  assert.equal(card.countdownTone({ code: 2, days: -3 }), 'warn');
  assert.equal(card.countdownGlyph({ code: 2, days: -3 }), '!');
});
test('not found is a muted question mark whatever its dates say', () => {
  for (const days of [-5, 0, 5, null]) {
    assert.equal(card.countdownGlyph({ code: 5, days }), '?');
    assert.equal(card.countdownTone({ code: 5, days }), 'muted');
  }
});
test('delivered outranks every other tier', () => {
  assert.equal(card.countdownTone({ code: 0, days: -9 }), 'done');
  assert.equal(card.countdownGlyph({ code: 0, days: -9 }), '✓');
});
test('ordinary statuses stay unstyled', () => {
  assert.equal(card.countdownTone({ code: 2, days: 4 }), '');
  assert.equal(card.countdownTone({ code: 4, days: 2 }), '');
  assert.equal(card.countdownTone({ code: 8, days: 9 }), '');
});

console.log('date and time display');
test('a date in another year carries the year', () => {
  const rows = card.buildRows([
    { tracking_number: 'NY', status_code: 8, date_expected: '2027-03-01 00:00:00' },
    { tracking_number: 'TY', status_code: 8, date_expected: '2026-09-01 00:00:00' },
  ], {}, NOW);
  const shown = rows.map((r) => new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(r.eta.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  }).format(r.eta));
  assert.ok(shown.some((t) => /2027/.test(t)), 'next year must show a year');
  assert.ok(shown.some((t) => !/20\d\d/.test(t)), 'this year must not');
});
test('an epoch landing on local midnight is treated as date-only', () => {
  const midnight = Math.floor(new Date(2026, 7, 23, 0, 0, 0).getTime() / 1000);
  assert.equal(card.etaHasTime({ timestamp_expected: midnight }), false);
});
test('an epoch with a real time still counts as timed', () => {
  const morning = Math.floor(new Date(2026, 7, 23, 9, 15, 0).getTime() / 1000);
  assert.equal(card.etaHasTime({ timestamp_expected: morning }), true);
});

console.log('re-render guard');
test('an ageing delivery changes the render signature', () => {
  const d = [{ tracking_number: 'X1', status_code: 0,
    events: [{ event: 'Delivered', date: '2026-08-20 09:00:00' }] }];
  const key = (now) => JSON.stringify(card.buildRows(d, { hide_delivered_after: 10 }, now)
    .map((r) => [r.id, r.name, r.days, r.sortDay, r.deliveredDays]));
  const onTheDay = key(NOW);
  const threeDaysOn = key(new Date(2026, 7, 23, 12, 0));
  assert.notEqual(onTheDay, threeDaysOn, 'subtitle would freeze on "Delivered · Today"');
});

console.log('delivery date resolution');
test('an ISO event date with an offset is understood', () => {
  const d = { status_code: 0, events: [{ event: 'Delivered', date: '2026-08-20T09:00:00+01:00' }] };
  const at = card.deliveredAt(d, null);
  assert.ok(at instanceof Date && !Number.isNaN(at.getTime()));
});
test('a date on an earlier event is used when the last one has none', () => {
  const d = { status_code: 0, events: [
    { event: 'Delivered', location: 'Porch' },
    { event: 'Out for delivery', date: '2026-08-20 07:00:00' },
  ] };
  assert.equal(card.deliveredAt(d, null).getDate(), 20);
});
test('the newest event date wins regardless of array order', () => {
  const d = { status_code: 0, events: [
    { event: 'Arrived', date: '2026-08-18 07:00:00' },
    { event: 'Delivered', date: '2026-08-20 11:00:00' },
    { event: 'Departed', date: '2026-08-19 07:00:00' },
  ] };
  assert.equal(card.deliveredAt(d, null).getDate(), 20);
});
test('unusable event dates fall through to the estimate', () => {
  const d = { status_code: 0, date_expected: '2026-08-19 00:00:00',
    events: [{ event: 'Delivered', date: 'sometime last week' }] };
  assert.equal(card.deliveredAt(d, card.parseEta(d)).getDate(), 19);
});
test('no dates anywhere still yields null', () => {
  assert.equal(card.deliveredAt({ status_code: 0, events: [{ event: 'Delivered' }] }, null), null);
});
test('eventDate rejects junk rather than inventing a date', () => {
  assert.equal(card.eventDate({ date: '' }), null);
  assert.equal(card.eventDate({ date: 'not a date' }), null);
  assert.equal(card.eventDate({}), null);
  assert.equal(card.eventDate(null), null);
});

console.log('real-world date formats');
// parcel-ha does not normalise event dates. All three of these appear in a
// single sensor payload, and two of them come from the same carrier.
const FORMATS = [
  ['2026-08-22 07:04:41', [2026, 7, 22, 7, 4, 41]],
  ['August 22, 2026 09:19', [2026, 7, 22, 9, 19, 0]],
  ['August 22, 2026 7:37 AM', [2026, 7, 22, 7, 37, 0]],
  ['August 22, 2026 12:05 AM', [2026, 7, 22, 0, 5, 0]],
  ['August 22, 2026 12:05 PM', [2026, 7, 22, 12, 5, 0]],
  ['August 22, 2026 1:55 PM', [2026, 7, 22, 13, 55, 0]],
  ['Aug 22 2026', [2026, 7, 22, 0, 0, 0]],
];
for (const [text, want] of FORMATS) {
  test(`parses ${text}`, () => {
    const d = card.parseLocalDateTime(text);
    assert.ok(d, 'must not be null');
    assert.deepEqual(
      [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()],
      want,
    );
  });
}
test('an offset-bearing string is read as an absolute instant', () => {
  assert.equal(card.parseLocalDateTime('2026-08-22T07:04:41Z').getTime(), Date.UTC(2026, 7, 22, 7, 4, 41));
});
test('garbage and impossible dates are still rejected', () => {
  for (const bad of ['not a date', '', 'August 45, 2026 09:19', '2026-02-31 00:00:00',
                     'Smarch 4, 2026', 'August 22, 2026 29:19']) {
    assert.equal(card.parseLocalDateTime(bad), null, bad);
  }
});

test('a delivered package with no estimate still reports its arrival day', () => {
  // FedEx: no date_expected at all, delivery time only in the event feed.
  const fedex = {
    carrier_code: 'fedex', description: 'Headphone amp', status_code: 0,
    tracking_number: 'FX0000000001',
    events: [
      { event: 'Delivered', date: 'August 20, 2026 09:19', location: 'New York, NY' },
      { event: 'On vehicle for delivery', date: 'August 20, 2026 07:10', location: 'Brooklyn, NY' },
      { event: 'Shipment information sent', date: 'August 17, 2026 09:39' },
    ],
  };
  const [row] = card.buildRows([fedex], { hide_delivered_after: 5 }, NOW);
  assert.ok(row, 'must survive the retention filter');
  assert.equal(row.eta, null, 'there is no estimate to fall back on');
  assert.ok(row.deliveredAt, 'arrival must come from the events');
  assert.equal(row.deliveredDays, 0);
  assert.equal(row.deliveredAt.getHours(), 9);
});
test('the newest event wins even when the feed mixes formats', () => {
  const mixed = { status_code: 2, tracking_number: 'MX1', events: [
    { event: 'older', date: 'August 19, 2026 11:00 PM' },
    { event: 'newest', date: '2026-08-20 06:30:00' },
    { event: 'oldest', date: 'Aug 18 2026' },
  ] };
  assert.equal(card.latestEvent(mixed).event, 'newest');
});

console.log(`\n${passed} assertions passed${process.exitCode ? ', with failures' : ''}`);
