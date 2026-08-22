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
test('shows delivered packages when asked', () => {
  const withDelivered = card.buildRows(deliveries, { show_delivered: true }, NOW);
  assert.equal(withDelivered.length, rows.length + 1);
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
  assert.equal(card.countdownTone({ code: 2, days: -1 }), 'alert');
  assert.equal(card.countdownTone({ code: 2, days: 0 }), 'soon');
  assert.equal(card.countdownTone({ code: 2, days: 1 }), 'soon');
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
  const hint = card.describeFilters(mixed, { show_no_eta: false });
  assert.match(hint, /1 delivered and 1 with no delivery estimate/);
});
test('falls back to a generic count when no filter explains it', () => {
  assert.match(card.describeFilters([{ status_code: 2 }], {}), /All 1 package is hidden/);
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

console.log(`\n${passed} assertions passed${process.exitCode ? ', with failures' : ''}`);
