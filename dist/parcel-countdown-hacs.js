/**
 * parcel-countdown-card
 *
 * A Home Assistant custom Lovelace card that renders incoming packages from the
 * `parcel-ha` integration as a countdown list: a large day-count on the left,
 * the package name on the right.
 *
 * Zero dependencies, zero build step. Plain ES module, vanilla custom element.
 */

const CARD_TYPE = 'parcel-countdown-card';
const EDITOR_TYPE = 'parcel-countdown-card-editor';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/**
 * Status codes published by the Parcel App API via `parcel-ha`, each with the
 * tone it lends a row. Red is reserved for something actually going wrong;
 * amber means it needs a nudge; a parcel the carrier cannot find stays quiet.
 */
const STATUS = {
  0: { label: 'Delivered', tone: 'done' },
  1: { label: 'Stalled', tone: 'warn' },
  2: { label: 'In transit', tone: '' },
  3: { label: 'Awaiting pickup', tone: 'warn' },
  4: { label: 'Out for delivery', tone: '' },
  5: { label: 'Not found', tone: 'muted' },
  6: { label: 'Failed attempt', tone: 'alert' },
  7: { label: 'Exception', tone: 'alert' },
  8: { label: 'Label created', tone: '' },
};

const DELIVERED = 0;
const NOT_FOUND = 5;

const DEFAULTS = {
  entity: 'sensor.parcel_raw_shipment_data',
  columns: 1,
  max: 0,
  number_size: 32,
  show_no_eta: true,
  hide_delivered_after: 1,
  carriers: {},
};

const DAY_MS = 86400000;

/** Config bounds, shared by `setConfig` and the GUI editor. */
const LIMITS = {
  columns: { min: 1, max: 3 },
  max: { min: 0, max: 999 },
  number_size: { min: 12, max: 96 },
  hide_delivered_after: { min: 0, max: 30 },
};

/**
 * Carrier tracking pages, keyed by `carrier_code` normalised to lowercase
 * alphanumerics. Unlisted carriers fall back to a web search for the tracking
 * number. Extend or override with the `carriers` config option.
 */
const TRACKING_URLS = {
  ups: 'https://www.ups.com/track?loc=en_US&tracknum={tracking}',
  usps: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking}',
  fedex: 'https://www.fedex.com/fedextrack/?trknbr={tracking}',
  dhl: 'https://www.dhl.com/en/express/tracking.html?AWB={tracking}&brand=DHL',
  dhlexpress: 'https://www.dhl.com/en/express/tracking.html?AWB={tracking}&brand=DHL',
  royalmail: 'https://www.royalmail.com/track-your-item#/tracking-results/{tracking}',
  evri: 'https://www.evri.com/track/parcel/{tracking}',
  hermes: 'https://www.evri.com/track/parcel/{tracking}',
  dpd: 'https://track.dpd.co.uk/parcels/{tracking}',
  gls: 'https://gls-group.eu/EU/en/parcel-tracking?match={tracking}',
  canadapost: 'https://www.canadapost-postescanada.ca/track-reperage/en#/resultList?searchFor={tracking}',
  auspost: 'https://auspost.com.au/mypost/track/details/{tracking}',
  postnl: 'https://postnl.nl/tracktrace/?B={tracking}',
  ontrac: 'https://www.ontrac.com/tracking/?number={tracking}',
  purolator: 'https://www.purolator.com/en/shipping/tracker?pin={tracking}',
  yodel: 'https://www.yodel.co.uk/track/{tracking}',
  tnt: 'https://www.tnt.com/express/en_us/site/tracking.html?searchType=con&cons={tracking}',
  aramex: 'https://www.aramex.com/us/en/track/results?ShipmentNumber={tracking}',
};

const TRACKING_FALLBACK = 'https://www.google.com/search?q={tracking}';

/**
 * `carriers` templates come from user config, so a `javascript:` or `data:`
 * template must never reach an href.
 */
const SAFE_URL = /^https?:\/\//i;


/* ------------------------------------------------------------------------- *
 * Data layer — pure functions, no DOM. Exported for the Node fixture tests.
 * ------------------------------------------------------------------------- */

/**
 * Resolve the expected delivery date for one delivery.
 *
 * Prefers `timestamp_expected` (epoch, only present when the carrier gave a
 * full date/time/tz). Otherwise parses `date_expected`, which arrives as
 * "YYYY-MM-DD HH:MM:SS" with no timezone and must be read as *local* time —
 * `new Date(string)` is not reliable for that shape across engines.
 *
 * @returns {Date|null}
 */
export function parseEta(delivery) {
  if (!delivery || typeof delivery !== 'object') return null;

  const raw = delivery.timestamp_expected;
  if (raw !== null && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      // Epoch seconds vs. milliseconds: anything below ~1973-in-ms is seconds.
      const date = new Date(n < 1e11 ? n * 1000 : n);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }

  return parseLocalDateTime(delivery.date_expected);
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Build a local date, rejecting impossible ones JS would silently roll over. */
function localDate(year, month, day, hour, minute, second) {
  const date = new Date(year, month, day, hour || 0, minute || 0, second || 0);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

/**
 * Parse the date shapes `parcel-ha` actually emits. They are not consistent —
 * even two packages from the same carrier can differ:
 *
 *   2026-08-22 07:04:41       `date_expected`, and some event feeds
 *   August 22, 2026 09:19     FedEx events, 24-hour
 *   August 22, 2026 7:37 AM   USPS events, 12-hour
 *
 * All are timezone-less and read as local wall-clock time. A string that does
 * carry an offset is handed to the engine so the offset is honoured.
 *
 * @returns {Date|null}
 */
export function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // Explicit offset or Z: an absolute instant, not wall-clock.
  if (/\d(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const absolute = new Date(text);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }

  const numeric = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (numeric) {
    return localDate(
      Number(numeric[1]),
      Number(numeric[2]) - 1,
      Number(numeric[3]),
      Number(numeric[4] || 0),
      Number(numeric[5] || 0),
      Number(numeric[6] || 0),
    );
  }

  // "August 22, 2026 09:19" / "Aug 22 2026 7:37 AM" / "August 22, 2026"
  const worded = text.match(
    /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]?\.?)?)?$/,
  );
  if (!worded) return null;

  const month = MONTHS[worded[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  let hour = Number(worded[4] || 0);
  const meridiem = worded[7] && worded[7].toLowerCase();
  if (meridiem === 'a' && hour === 12) hour = 0;
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (hour > 23) return null;

  return localDate(
    Number(worded[3]),
    month,
    Number(worded[2]),
    hour,
    Number(worded[5] || 0),
    Number(worded[6] || 0),
  );
}

/**
 * End of the delivery window, expressed on the same clock as `eta`.
 *
 * `eta` may come from `timestamp_expected` — an absolute instant — while
 * `date_expected_end` is local wall-clock text with no timezone. Using them
 * together mixes two clocks and can be hours out, so when both ends of the
 * window are wall-clock, carry the window's duration onto `eta` instead.
 *
 * @returns {Date|null}
 */
export function etaWindowEnd(delivery, eta) {
  if (!delivery || typeof delivery !== 'object') return null;
  if (!(eta instanceof Date) || Number.isNaN(eta.getTime())) return null;

  const end = parseLocalDateTime(delivery.date_expected_end);
  if (!end) return null;

  const start = parseLocalDateTime(delivery.date_expected);
  if (start) {
    const span = end.getTime() - start.getTime();
    return span > 0 ? new Date(eta.getTime() + span) : null;
  }

  // No wall-clock start to measure against; only usable if it stands on its own.
  return end.getTime() > eta.getTime() ? end : null;
}

/** True when the ETA carries a meaningful time-of-day, not just a date. */
export function etaHasTime(delivery) {
  if (!delivery || typeof delivery !== 'object') return false;

  const raw = delivery.timestamp_expected;
  if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
    // Some carriers stamp a date-only estimate as local midnight.
    const at = parseEta(delivery);
    if (!at) return false;
    return at.getHours() !== 0 || at.getMinutes() !== 0 || at.getSeconds() !== 0;
  }
  return /[T ]\d{2}:\d{2}/.test(String(delivery.date_expected || '')) &&
    !/[T ]00:00(:00)?$/.test(String(delivery.date_expected || '').trim());
}

/**
 * Calendar-day difference between two dates, measured at local midnight, so
 * "tomorrow at 00:30" is 1 day away rather than 0. DST-safe via rounding.
 *
 * @returns {number|null}
 */
export function daysUntil(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((to - from) / DAY_MS);
}

/**
 * Date on a tracking event.
 *
 * Unlike `date_expected`, whose shape `parcel-ha` documents, event dates come
 * from the carriers themselves and vary. Try the documented wall-clock shape
 * first, then let the engine attempt anything else it recognises — an ISO
 * string with an offset, say — rather than dropping the event entirely.
 *
 * @returns {Date|null}
 */
export function eventDate(event) {
  if (!event || typeof event !== 'object') return null;

  const local = parseLocalDateTime(event.date);
  if (local) return local;

  if (typeof event.date === 'string' && event.date.trim()) {
    const parsed = new Date(event.date.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/** Most recent tracking event, tolerating unsorted or undated event arrays. */
export function latestEvent(delivery) {
  const events = delivery && Array.isArray(delivery.events) ? delivery.events : [];
  if (!events.length) return null;

  let best = null;
  let bestTime = -Infinity;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const parsed = eventDate(event);
    const time = parsed ? parsed.getTime() : -Infinity;
    if (best === null || time > bestTime) {
      best = event;
      bestTime = time;
    }
  }
  return best;
}

/**
 * When a delivered package was delivered.
 *
 * Scans every event for the newest usable date rather than trusting the last
 * one to carry it — a carrier that logs its delivery scan without a date would
 * otherwise hide a perfectly good timestamp sitting on an earlier event.
 * Falls back to the expected date.
 *
 * @returns {Date|null}
 */
export function deliveredAt(delivery, eta) {
  const events = delivery && Array.isArray(delivery.events) ? delivery.events : [];

  let newest = null;
  for (const event of events) {
    const at = eventDate(event);
    if (at && (newest === null || at > newest)) newest = at;
  }

  return newest || eta || null;
}

/**
 * Turn the raw `deliveries` attribute into sorted, filtered view rows.
 *
 * Sort order: one chronological timeline — furthest in the past first, running
 * forward into the future, undated packages last. Delivered packages are
 * placed by when they arrived, so they lead naturally rather than by rule.
 *
 * @returns {Array<{id:string,name:string,days:number|null,eta:Date|null,
 *   hasTime:boolean,code:number|null,carrier:string,tracking:string,
 *   event:object|null,window:Date|null}>}
 */
export function buildRows(deliveries, config = {}, now = new Date()) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  const showNoEta = config.show_no_eta !== false;
  const hideAfter = Number.isFinite(Number(config.hide_delivered_after))
    ? Math.max(0, Number(config.hide_delivered_after))
    : DEFAULTS.hide_delivered_after;

  const rows = [];
  list.forEach((delivery, index) => {
    if (!delivery || typeof delivery !== 'object') return;

    const code = Number.isFinite(Number(delivery.status_code))
      ? Number(delivery.status_code)
      : null;

    const eta = parseEta(delivery);
    const delivered = code === DELIVERED;
    const settled = delivered ? deliveredAt(delivery, eta) : null;

    if (delivered) {
      // `hide_delivered_after` counts calendar days: 0 hides on arrival, 1
      // keeps it for the rest of the delivery day. An undated delivery is
      // treated as having just landed.
      const since = settled ? -daysUntil(settled, now) : 0;
      if (since >= hideAfter) return;
    } else if (eta === null && !showNoEta) {
      return;
    }

    const tracking = String(delivery.tracking_number || '').trim();
    const name = String(delivery.description || '').trim() || tracking || 'Package';

    rows.push({
      id: tracking || `${name}-${index}`,
      name,
      days: daysUntil(eta, now),
      eta,
      hasTime: etaHasTime(delivery),
      window: etaWindowEnd(delivery, eta),
      delivered,
      deliveredAt: settled,
      deliveredDays: settled ? daysUntil(settled, now) : null,
      // One timeline: a delivered package is placed by when it arrived, a
      // pending one by when it is due. An undated delivery counts as now.
      sortDay: delivered ? (settled ? daysUntil(settled, now) : 0) : daysUntil(eta, now),
      sortAt: delivered ? settled || now : eta,
      code,
      carrier: String(delivery.carrier_code || '').trim(),
      tracking,
      event: latestEvent(delivery),
    });
  });

  // Oldest first, running forward into the future; undated packages last.
  rows.sort((a, b) => {
    if (a.sortDay === null || b.sortDay === null) {
      if (a.sortDay === b.sortDay) return a.name.localeCompare(b.name);
      return a.sortDay === null ? 1 : -1;
    }
    if (a.sortDay !== b.sortDay) return a.sortDay - b.sortDay;

    // Same day: what already arrived precedes what is still due, since a
    // date-only estimate reads as midnight and would otherwise jump ahead.
    if (a.delivered !== b.delivered) return a.delivered ? -1 : 1;

    const at = a.sortAt ? a.sortAt.getTime() : 0;
    const bt = b.sortAt ? b.sortAt.getTime() : 0;
    return at - bt || a.name.localeCompare(b.name);
  });

  const max = Number(config.max) || 0;
  return max > 0 ? rows.slice(0, max) : rows;
}

/**
 * Why a non-empty `deliveries` array produced no visible rows.
 */
export function describeFilters(deliveries, config = {}, now = new Date()) {
  const list = Array.isArray(deliveries) ? deliveries.filter(Boolean) : [];
  const hideAfter = Number.isFinite(Number(config.hide_delivered_after))
    ? Math.max(0, Number(config.hide_delivered_after))
    : DEFAULTS.hide_delivered_after;

  // Count only what the filters actually dropped, using the same arithmetic
  // `buildRows` applies, so the hint cannot claim credit for a package that is
  // simply too old to be interesting.
  const staleDelivered = list.filter((d) => {
    if (Number(d.status_code) !== DELIVERED) return false;
    const settled = deliveredAt(d, parseEta(d));
    const since = settled ? -daysUntil(settled, now) : 0;
    return since >= hideAfter;
  }).length;

  const noEta =
    config.show_no_eta === false
      ? list.filter((d) => Number(d.status_code) !== DELIVERED && parseEta(d) === null).length
      : 0;

  const parts = [];
  if (staleDelivered) {
    parts.push(
      hideAfter === 0
        ? `${staleDelivered} already delivered`
        : `${staleDelivered} delivered more than ${hideAfter} day${hideAfter === 1 ? '' : 's'} ago`,
    );
  }
  if (noEta) parts.push(`${noEta} with no delivery estimate`);

  if (!parts.length) {
    return `All ${list.length} package${list.length === 1 ? ' is' : 's are'} hidden.`;
  }
  return `${parts.join(' and ')} hidden by this card's settings.`;
}

/**
 * Decide what the card should show for a given entity state: either rows, or a
 * message naming what is wrong and what to do about it.
 *
 * @returns {{rows: Array, message: {text: string, hint: string, alert: boolean}|null}}
 */
export function resolveView(entityId, state, config = {}, now = new Date()) {
  if (!state) {
    return {
      rows: [],
      message: {
        text: `Entity not found: ${entityId}`,
        hint:
          'It does not exist, or it is disabled. parcel-ha ships the raw ' +
          'shipment sensor disabled by default — enable it under Settings → ' +
          'Devices & services → Parcel App → show disabled entities.',
        alert: true,
      },
    };
  }

  if (state.state === 'unavailable' || state.state === 'unknown') {
    return {
      rows: [],
      message: {
        text: `${entityId} is ${state.state}`,
        hint: 'The Parcel App integration is not reporting data right now.',
        alert: true,
      },
    };
  }

  const deliveries = state.attributes ? state.attributes.deliveries : undefined;
  if (!Array.isArray(deliveries)) {
    return {
      rows: [],
      message: {
        text: `${entityId} has no "deliveries" attribute`,
        hint:
          'This card reads the package list from that attribute. Point it at ' +
          'the Parcel raw shipment data sensor — the active/recent shipment ' +
          'sensors only publish a count.',
        alert: true,
      },
    };
  }

  const rows = buildRows(deliveries, config, now);
  if (rows.length) return { rows, message: null };

  if (!deliveries.length) {
    return {
      rows,
      message: {
        text: 'No packages',
        hint: 'The Parcel App is not tracking anything right now.',
        alert: false,
      },
    };
  }

  return {
    rows,
    message: {
      text: 'Nothing to show',
      hint: describeFilters(deliveries, config, now),
      alert: false,
    },
  };
}

/** `carrier_code` reduced to lowercase alphanumerics, so "Royal-Mail" == "royalmail". */
export function normalizeCarrier(code) {
  return String(code === null || code === undefined ? '' : code)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The carrier's tracking page for one row, or null when there is no tracking
 * number to look up. `carriers` (from config) overrides the built-in map, and
 * its keys are normalised the same way, so casing and punctuation do not matter.
 *
 * @returns {string|null}
 */
export function trackingUrl(row, carriers) {
  if (!row || !row.tracking) return null;

  const overrides = {};
  if (carriers && typeof carriers === 'object') {
    Object.keys(carriers).forEach((key) => {
      if (typeof carriers[key] === 'string' && carriers[key]) {
        overrides[normalizeCarrier(key)] = carriers[key];
      }
    });
  }

  const key = normalizeCarrier(row.carrier);
  const template = overrides[key] || TRACKING_URLS[key] || TRACKING_FALLBACK;
  const url = String(template)
    .replace(/\{tracking\}/g, encodeURIComponent(row.tracking))
    .replace(/\{carrier\}/g, encodeURIComponent(row.carrier || ''));

  return SAFE_URL.test(url) ? url : null;
}

/**
 * Big-number glyph: `✓` delivered, `?` the carrier cannot find it, `!` overdue,
 * `–` no estimate, otherwise the day count.
 */
export function countdownGlyph(row) {
  if (row.code === DELIVERED) return '✓';
  if (row.code === NOT_FOUND) return '?';
  if (row.days === null) return '–';
  if (row.days < 0) return '!';
  return String(row.days);
}

/**
 * Tone class for the big number. Status severity outranks timing, so an
 * overdue exception stays red rather than softening to amber, and a package
 * the carrier cannot find stays quiet whatever its dates claim.
 */
export function countdownTone(row) {
  if (row.code === DELIVERED) return 'done';
  if (row.code === NOT_FOUND) return 'muted';
  if (statusTone(row.code) === 'alert') return 'alert';
  if (row.days === null) return 'muted';
  if (row.days < 0 || statusTone(row.code) === 'warn') return 'warn';
  if (row.days === 0) return 'soon';
  return '';
}

/**
 * Best guess at the entity holding the package list, for the card picker.
 *
 * `parcel-ha` also publishes `parcel_active_shipment` and
 * `parcel_recent_shipment`, which match on name but carry only a count, so a
 * `deliveries` array beats a name match.
 */
export function findParcelEntity(hass) {
  const states = (hass && hass.states) || {};
  const ids = Object.keys(states);

  const hasDeliveries = (id) =>
    states[id] && states[id].attributes && Array.isArray(states[id].attributes.deliveries);

  return (
    ids.find((id) => id === DEFAULTS.entity && hasDeliveries(id)) ||
    ids.find((id) => id.startsWith('sensor.') && hasDeliveries(id)) ||
    ids.find((id) => id === DEFAULTS.entity) ||
    ids.find((id) => id.startsWith('sensor.') && id.includes('parcel')) ||
    DEFAULTS.entity
  );
}

/* ------------------------------------------------------------------------- *
 * Formatting helpers
 * ------------------------------------------------------------------------- */

function localeOf(hass) {
  return (hass && hass.locale && hass.locale.language) || undefined;
}

function formatDate(date, hass) {
  // "Sat, Mar 1" is ambiguous once a date leaves the current year.
  const sameYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(localeOf(hass), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date);
  } catch (err) {
    return date.toDateString();
  }
}

function formatTime(date, hass) {
  try {
    return new Intl.DateTimeFormat(localeOf(hass), {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  } catch (err) {
    return '';
  }
}

/** "Today" / "Tomorrow" / "Yesterday", else a short date. */
function relativeDay(date, days, hass) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return formatDate(date, hass);
}

/** Human-readable ETA line, e.g. "Tomorrow, 09:00 – 13:00". */
function formatEta(row, hass) {
  if (!row.eta) return 'No delivery estimate';

  const label = relativeDay(row.eta, row.days, hass);

  if (!row.hasTime) return label;

  let time = formatTime(row.eta, hass);
  if (row.window) {
    const end = formatTime(row.window, hass);
    if (end) time = `${time} – ${end}`;
  }
  return time ? `${label}, ${time}` : label;
}

/**
 * Secondary line under the package name. A delivered package reports when it
 * arrived; an estimate is meaningless once it is in your hands.
 */
function rowSubtitle(row, hass) {
  const label = statusLabel(row.code);

  if (row.delivered) {
    if (!row.deliveredAt) return label;
    return `${label} · ${relativeDay(row.deliveredAt, row.deliveredDays, hass)}`;
  }

  return `${label} · ${formatEta(row, hass)}`;
}

function statusLabel(code) {
  return (STATUS[code] && STATUS[code].label) || 'Unknown status';
}

/** Tone the status alone lends a row, ignoring timing. */
function statusTone(code) {
  const tone = STATUS[code] && STATUS[code].tone;
  return tone === 'alert' || tone === 'warn' ? tone : '';
}

function formatEventDate(value, hass) {
  const date = eventDate({ date: value });
  if (!date) return '';
  return `${formatDate(date, hass)}, ${formatTime(date, hass)}`;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/** Clamp a config value to its declared bounds, falling back to the default. */
function clampTo(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS[key];
  return Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, Math.round(n)));
}

/* ------------------------------------------------------------------------- *
 * Styles — HA CSS custom properties only, no hardcoded colours or font stacks.
 * ------------------------------------------------------------------------- */

const STYLES = `
  :host { display: block; }

  ha-card {
    overflow: hidden;
  }

  .card-header {
    color: var(--ha-card-header-color, var(--primary-text-color));
    font-size: var(--ha-card-header-font-size, 24px);
    font-weight: var(--ha-font-weight-normal, 400);
    line-height: 1.2em;
    letter-spacing: -0.012em;
    padding: 12px 16px 4px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(var(--pcc-columns, 1), minmax(0, 1fr));
    column-gap: 8px;
    padding: 4px 0;
  }

  .row {
    display: block;
    border-top: 1px solid var(--divider-color);
    color: inherit;
    text-decoration: none;
    outline: none;
  }
  a.row { cursor: pointer; }

  a.row:hover .line { background: var(--secondary-background-color); }
  /* Hide the divider above the first row of every column. */
  .grid.cols-1 .row:nth-child(-n + 1),
  .grid.cols-2 .row:nth-child(-n + 2),
  .grid.cols-3 .row:nth-child(-n + 3) { border-top: none; }

  .row:focus-visible .line {
    background: var(--secondary-background-color);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    min-height: 40px;
    box-sizing: border-box;
  }

  .count {
    flex: 0 0 auto;
    margin-left: -4px;
    min-width: calc(var(--pcc-number-size, 32px) * 1.2);
    text-align: center;
    font-size: var(--pcc-number-size, 32px);
    line-height: 1;
    font-weight: var(--ha-font-weight-medium, 500);
    letter-spacing: -0.04em;
    color: var(--primary-text-color);
    font-variant-numeric: tabular-nums;
  }
  .count.soon { color: var(--primary-color); }
  .count.alert { color: var(--error-color); }
  .count.done { color: var(--success-color, var(--label-badge-green)); }
  .count.warn { color: var(--warning-color, var(--label-badge-yellow)); }
  .count.muted { color: var(--secondary-text-color); }

  .text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .name {
    color: var(--primary-text-color);
    font-size: var(--ha-font-size-m, 14px);
    font-weight: var(--ha-font-weight-medium, 500);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub.alert { color: var(--error-color); }
  .sub.warn { color: var(--warning-color, var(--label-badge-yellow)); }

  .chevron {
    flex: 0 0 auto;
    color: var(--secondary-text-color);
    font-size: 12px;
    line-height: 1;
  }
  .row:not(a) .chevron { visibility: hidden; }

  .empty {
    padding: 16px;
  }

  .empty-text {
    color: var(--primary-text-color);
    font-size: var(--ha-font-size-m, 14px);
    line-height: 1.4;
  }
  .empty.alert .empty-text { color: var(--error-color); }

  .empty-hint {
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
    line-height: 1.45;
    margin-top: 6px;
    max-width: 46em;
  }
`;

/* ------------------------------------------------------------------------- *
 * The card
 * ------------------------------------------------------------------------- */

class ParcelCountdownCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._signature = null;
    this._timer = null;
    this._built = false;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TYPE);
  }

  static getStubConfig(hass) {
    return { type: `custom:${CARD_TYPE}`, entity: findParcelEntity(hass), title: 'Packages' };
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid configuration');
    }
    if (!config.entity) {
      throw new Error('You need to define an entity');
    }
    if (typeof config.entity !== 'string' || !config.entity.startsWith('sensor.')) {
      throw new Error('`entity` must be a sensor entity');
    }

    this._config = {
      ...DEFAULTS,
      ...config,
      columns: clampTo('columns', config.columns),
      max: clampTo('max', config.max),
      number_size: clampTo('number_size', config.number_size),
      show_no_eta: config.show_no_eta !== false,
      hide_delivered_after: clampTo('hide_delivered_after', config.hide_delivered_after),
      carriers:
        config.carriers && typeof config.carriers === 'object' ? config.carriers : {},
    };
    this._signature = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    // Day counts roll over at midnight even when no state change arrives.
    if (!this._timer) {
      this._timer = setInterval(() => this._render(), 60000);
    }
  }

  disconnectedCallback() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getCardSize() {
    const rows = this._rows ? this._rows.length : 3;
    const columns = this._config ? this._config.columns : 1;
    return 1 + Math.ceil(rows / columns);
  }

  getGridOptions() {
    return { rows: 'auto', columns: 'full', min_columns: 6 };
  }

  /* -- rendering -- */

  _render() {
    if (!this._config) return;

    // Nothing to say until the first hass update arrives.
    const view = this._hass
      ? resolveView(
          this._config.entity,
          this._hass.states ? this._hass.states[this._config.entity] : undefined,
          this._config,
          new Date(),
        )
      : { rows: [], message: null };
    const { rows, message } = view;

    this._rows = rows;

    const signature = JSON.stringify([
      this._config,
      message,
      rows.map((r) => [r.id, r.name, r.days, r.sortDay, r.deliveredDays,
        r.code, r.carrier, r.tracking,
        r.eta ? r.eta.getTime() : null, r.hasTime,
        r.window ? r.window.getTime() : null,
        r.event ? [r.event.event, r.event.date, r.event.location, r.event.additional] : null]),
    ]);
    if (this._built && signature === this._signature) return;
    this._signature = signature;

    this._build();
    this._paint(rows, message);
  }

  _build() {
    if (this._built) return;
    const style = document.createElement('style');
    style.textContent = STYLES;
    this._card = document.createElement('ha-card');
    this.shadowRoot.replaceChildren(style, this._card);
    this._built = true;
  }

  _paint(rows, message) {
    const cfg = this._config;
    const header = cfg.title
      ? `<div class="card-header">${escapeHtml(cfg.title)}</div>`
      : '';

    let body;
    if (message) {
      const hint = message.hint
        ? `<div class="empty-hint">${escapeHtml(message.hint)}</div>`
        : '';
      body =
        `<div class="empty${message.alert ? ' alert' : ''}">` +
        `<div class="empty-text">${escapeHtml(message.text)}</div>${hint}</div>`;
    } else if (!rows.length) {
      body = '';
    } else {
      body =
        `<div class="grid cols-${cfg.columns}">` +
        rows.map((row) => this._rowHtml(row)).join('') +
        '</div>';
    }

    this._card.style.setProperty('--pcc-columns', String(cfg.columns));
    this._card.style.setProperty('--pcc-number-size', `${cfg.number_size}px`);
    this._card.innerHTML = header + body;
  }

  _rowHtml(row) {
    const hass = this._hass;
    const sub = rowSubtitle(row, hass);
    const href = trackingUrl(row, this._config.carriers);

    // The tooltip carries only what the row does not already show.
    const tooltip = [];
    if (row.tracking) {
      tooltip.push(row.carrier ? `${row.tracking} (${row.carrier})` : row.tracking);
    }
    if (row.event) {
      const parts = [
        String(row.event.event || row.event.additional || '').trim(),
        String(row.event.location || '').trim(),
        formatEventDate(row.event.date, hass),
      ].filter(Boolean);
      if (parts.length) tooltip.push(parts.join(' · '));
    }

    const open = href
      ? `<a class="row" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"`
      : '<div class="row"';

    return (
      `${open}${tooltip.length ? ` title="${escapeHtml(tooltip.join('\n'))}"` : ''} ` +
      `aria-label="${escapeHtml(`${row.name}, ${sub}`)}">` +
      '<div class="line">' +
      `<div class="count ${countdownTone(row)}">${countdownGlyph(row)}</div>` +
      '<div class="text">' +
      `<div class="name">${escapeHtml(row.name)}</div>` +
      `<div class="sub${statusTone(row.code) ? ` ${statusTone(row.code)}` : ''}">` +
      `${escapeHtml(sub)}</div>` +
      '</div>' +
      '<div class="chevron">❯</div>' +
      '</div>' +
      `${href ? '</a>' : '</div>'}`
    );
  }
}

/* ------------------------------------------------------------------------- *
 * GUI editor — built on HA's own `ha-form` + selectors.
 * ------------------------------------------------------------------------- */

const FORM_SCHEMA = [
  { name: 'entity', required: true, selector: { entity: { domain: 'sensor' } } },
  { name: 'title', selector: { text: {} } },
  {
    type: 'grid',
    name: '',
    schema: [
      {
        name: 'columns',
        selector: { number: { ...LIMITS.columns, mode: 'box' } },
      },
      { name: 'max', selector: { number: { ...LIMITS.max, mode: 'box' } } },
    ],
  },
  {
    name: 'number_size',
    selector: {
      number: { ...LIMITS.number_size, step: 2, mode: 'slider', unit_of_measurement: 'px' },
    },
  },
  {
    name: 'hide_delivered_after',
    selector: {
      number: {
        ...LIMITS.hide_delivered_after,
        step: 1,
        mode: 'slider',
        unit_of_measurement: 'days',
      },
    },
  },
  { name: 'show_no_eta', selector: { boolean: {} } },
  { name: 'carriers', selector: { object: {} } },
];

const FORM_LABELS = {
  entity: 'Parcel entity (required)',
  title: 'Title',
  columns: 'Columns',
  max: 'Max packages (0 = all)',
  number_size: 'Number size',
  show_no_eta: 'Show packages with no ETA',
  hide_delivered_after: 'Hide delivered after (0 = as soon as it arrives)',
  carriers: 'Carrier tracking URLs (advanced) — carrier_code: template with {tracking}',
};

class ParcelCountdownCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = { ...DEFAULTS, ...(config || {}) };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._render();
  }

  async _render() {
    if (!this.shadowRoot) return;
    if (!customElements.get('ha-form')) {
      // The card-editor dialog defines `ha-form`.
      await customElements.whenDefined('ha-form');
      if (!this.isConnected) return;
    }

    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (schema) => FORM_LABELS[schema.name] || schema.name;
      this._form.addEventListener('value-changed', (ev) => this._valueChanged(ev));
      this.shadowRoot.replaceChildren(this._form);
    }

    this._form.hass = this._hass;
    this._form.schema = FORM_SCHEMA;
    this._form.data = this._config;
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    const value = { ...this._config, ...(ev.detail ? ev.detail.value : {}) };

    // Drop empty/defaulted keys so the YAML round-trip stays clean.
    const config = { type: `custom:${CARD_TYPE}`, entity: value.entity };
    if (value.title !== undefined && String(value.title).trim() !== '') {
      config.title = String(value.title);
    }
    const columns = clampTo('columns', value.columns);
    if (columns !== DEFAULTS.columns) config.columns = columns;

    const max = clampTo('max', value.max);
    if (max !== DEFAULTS.max) config.max = max;

    const size = clampTo('number_size', value.number_size);
    if (size !== DEFAULTS.number_size) config.number_size = size;

    if (value.show_no_eta === false) config.show_no_eta = false;

    const keepDelivered = clampTo('hide_delivered_after', value.hide_delivered_after);
    if (keepDelivered !== DEFAULTS.hide_delivered_after) {
      config.hide_delivered_after = keepDelivered;
    }

    if (
      value.carriers &&
      typeof value.carriers === 'object' &&
      Object.keys(value.carriers).length
    ) {
      config.carriers = value.carriers;
    }

    this._config = { ...DEFAULTS, ...config };
    this.dispatchEvent(
      new CustomEvent('config-changed', {
        detail: { config },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Registration
 * ------------------------------------------------------------------------- */

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, ParcelCountdownCard);
}
if (!customElements.get(EDITOR_TYPE)) {
  customElements.define(EDITOR_TYPE, ParcelCountdownCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: 'Parcel Countdown Card',
    description: 'Incoming packages as a countdown list, from the parcel-ha integration.',
    preview: true,
    documentationURL: 'https://github.com/phlntn/parcel-countdown-hacs',
  });
}

console.info(
  '%c PARCEL-COUNTDOWN-CARD ',
  'color: white; background: #3f51b5; font-weight: 700;',
);
