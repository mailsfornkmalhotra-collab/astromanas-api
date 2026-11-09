// Vedic (sidereal, Lahiri) birth chart computed locally with astronomy-engine.
// Free, no API key, deterministic. Whole-sign houses, mean lunar node, Vimshottari dasha.
const A = require("astronomy-engine");

const rad = Math.PI / 180;
const norm = (x) => ((x % 360) + 360) % 360;

function tzOffsetMinutes(utcMs, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

function localToUtcMs(y, mo, d, hh, mm, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let utc = guess - tzOffsetMinutes(guess, tz) * 60000;
  utc = guess - tzOffsetMinutes(utc, tz) * 60000;
  return utc;
}

// Lahiri ayanamsa (approx., within about an arc-minute for modern dates).
function lahiri(date) {
  const years = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (365.2425 * 86400000);
  return 23.853 + 0.013969 * years;
}

function tropicalLon(body, date) {
  const v = A.GeoVector(body, date, true);
  return norm(A.Ecliptic(v).elon);
}

function meanNode(date) {
  const T = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (36525 * 86400000);
  return norm(125.04452 - 1934.136261 * T);
}

function ascendant(date, lat, lon) {
  const T = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (36525 * 86400000);
  const eps = (23.439291 - 0.0130042 * T) * rad;
  const lst = norm((A.SiderealTime(date) * 15) + lon); // degrees
  const ramc = lst * rad;
  const phi = lat * rad;
  const asc = Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps)));
  return norm(asc / rad);
}

const NAK_SPAN = 360 / 27;
const DASHA = [
  ["ketu", 7], ["venus", 20], ["sun", 6], ["moon", 10], ["mars", 7],
  ["rahu", 18], ["jupiter", 16], ["saturn", 19], ["mercury", 17],
];

function dashas(moonSid, birthMs) {
  const nak = Math.floor(moonSid / NAK_SPAN);
  const frac = (moonSid % NAK_SPAN) / NAK_SPAN;
  const startIdx = nak % 9;
  const YEAR = 365.2425 * 86400000;
  const list = [];
  let t = birthMs;
  for (let i = 0; i < 9; i++) {
    const [lord, yrs] = DASHA[(startIdx + i) % 9];
    const len = (i === 0 ? yrs * (1 - frac) : yrs) * YEAR;
    list.push({ lord, start: new Date(t).toISOString().slice(0, 10), end: new Date(t + len).toISOString().slice(0, 10) });
    t += len;
  }
  const today = new Date().toISOString().slice(0, 10);
  const current = list.find((d) => d.start <= today && today < d.end) || null;
  return { current, list };
}

/**
 * @param {{year:number,month:number,day:number,hour:number,minute:number,lat:number,lon:number,tz:string}} p
 */
function computeKundli(p) {
  const utcMs = localToUtcMs(p.year, p.month, p.day, p.hour, p.minute, p.tz);
  const date = new Date(utcMs);
  const ayan = lahiri(date);
  const sid = (x) => norm(x - ayan);

  const bodies = [
    ["sun", A.Body.Sun], ["moon", A.Body.Moon], ["mars", A.Body.Mars], ["mercury", A.Body.Mercury],
    ["jupiter", A.Body.Jupiter], ["venus", A.Body.Venus], ["saturn", A.Body.Saturn],
  ];
  const raw = bodies.map(([id, b]) => {
    const l = tropicalLon(b, date);
    let retro = false;
    if (!["sun", "moon"].includes(id)) {
      const next = tropicalLon(b, new Date(utcMs + 86400000));
      retro = ((next - l + 540) % 360) - 180 < 0;
    }
    return { id, lon: sid(l), retro };
  });
  const rahu = sid(meanNode(date));
  raw.push({ id: "rahu", lon: rahu, retro: true }, { id: "ketu", lon: norm(rahu + 180), retro: true });

  const asc = sid(ascendant(date, p.lat, p.lon));
  const lagnaSign = Math.floor(asc / 30);

  const planets = raw.map((r) => {
    const sign = Math.floor(r.lon / 30);
    return {
      id: r.id,
      sign,
      deg: Math.round((r.lon % 30) * 100) / 100,
      house: ((sign - lagnaSign + 12) % 12) + 1,
      nakshatra: Math.floor(r.lon / NAK_SPAN),
      pada: Math.floor((r.lon % NAK_SPAN) / (NAK_SPAN / 4)) + 1,
      retro: r.retro,
    };
  });

  const moon = raw.find((r) => r.id === "moon").lon;
  return {
    lagna: { sign: lagnaSign, deg: Math.round((asc % 30) * 100) / 100 },
    planets,
    dasha: dashas(moon, utcMs),
    ayanamsa: Math.round(ayan * 1000) / 1000,
    utc: date.toISOString(),
  };
}

module.exports = { computeKundli, tzOffsetMinutes };
