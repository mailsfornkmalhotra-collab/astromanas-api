// Server-side plan enforcement: who is on Plus, and how many chat questions each install has used today.
// The phone shows counters too, but this is the source of truth, so clearing app data does not reset the limit.
const fs = require("fs");
const path = require("path");

const FREE = Number(process.env.FREE_CHATS_PER_DAY) || 5;
const PLUS = Number(process.env.PLUS_CHATS_PER_DAY) || 50;
const RC_SECRET = process.env.REVENUECAT_SECRET_KEY || "";
const TRUST_CLIENT_PLUS = process.env.DEV_TRUST_PLUS === "1"; // local testing only, never set in production
const ENTITLEMENT = "plus";
// Watching a rewarded video gives free users extra questions, at most BONUS_GRANTS_PER_DAY times a day.
const BONUS_QUESTIONS = Number(process.env.BONUS_QUESTIONS) || 3;
const BONUS_GRANTS_PER_DAY = Number(process.env.BONUS_GRANTS_PER_DAY) || 2;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, "usage.json");

// India day, so the limit resets at midnight IST.
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const usage = new Map(); // installId -> { day, n, b } (n = questions used, b = bonus videos claimed)
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(FILE, "utf8")))) usage.set(k, v);
} catch {}

// ---- Optional Redis (Upstash REST) so counters survive restarts on hosts without a disk (e.g. Render free).
// Without these two variables the server keeps counters in memory and in usage.json, as before.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "redis " + r.status);
  return j.result;
}
async function loadUsage(id) {
  if (REDIS_URL) {
    try {
      const v = await redis(["GET", "u:" + id]);
      return v ? JSON.parse(v) : undefined;
    } catch (e) {
      console.error("Redis read failed:", e.message);
    }
  }
  return usage.get(id);
}
async function saveUsage(id, v) {
  usage.set(id, v);
  dirty = true;
  if (REDIS_URL) {
    try {
      await redis(["SET", "u:" + id, JSON.stringify(v), "EX", 172800]);
    } catch (e) {
      console.error("Redis write failed:", e.message);
    }
  }
}

/** Counts one Gemini call for today across all users and returns the new total (cost protection). */
let aiDay = "", aiLocal = 0;
async function countAiCall() {
  const d = today();
  if (REDIS_URL) {
    try {
      const key = "ai:" + d;
      const n = await redis(["INCR", key]);
      if (n === 1) await redis(["EXPIRE", key, 172800]);
      return n;
    } catch (e) {
      console.error("Redis count failed:", e.message);
    }
  }
  if (aiDay !== d) { aiDay = d; aiLocal = 0; }
  return ++aiLocal;
}

let dirty = false;
setInterval(() => {
  const d = today();
  for (const [k, v] of usage) if (v.day !== d) usage.delete(k);
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(usage)));
  } catch {}
}, 30 * 1000).unref();

const plusCache = new Map(); // installId -> { plus, at }
async function isPlus(id, claimed) {
  if (!RC_SECRET) return TRUST_CLIENT_PLUS && claimed;
  const hit = plusCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.plus;
  try {
    const r = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${RC_SECRET}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("rc " + r.status);
    const j = await r.json();
    const e = j?.subscriber?.entitlements?.[ENTITLEMENT];
    const plus = !!e && (e.expires_date === null || Date.parse(e.expires_date) > Date.now());
    plusCache.set(id, { plus, at: Date.now() });
    if (plusCache.size > 5000) plusCache.delete(plusCache.keys().next().value);
    return plus;
  } catch (err) {
    console.error("RevenueCat check failed:", err.message);
    return hit ? hit.plus : false; // be strict: unknown means free
  }
}

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const installId = (req) => {
  const id = req.get("x-install-id");
  return id && ID_RE.test(id) ? id : null;
};

/** Returns { id, plus, limit, left } for this request. */
async function status(req) {
  const id = installId(req);
  if (!id) return null;
  const plus = await isPlus(id, req.get("x-plus") === "1");
  const u = await loadUsage(id);
  const live = u && u.day === today();
  const used = live ? u.n : 0;
  const bonus = !plus && live ? (u.b || 0) * BONUS_QUESTIONS : 0;
  const limit = (plus ? PLUS : FREE) + bonus;
  return { id, plus, limit, left: Math.max(0, limit - used) };
}

async function consume(id) {
  const d = today();
  const u = await loadUsage(id);
  const live = u && u.day === d;
  await saveUsage(id, { day: d, n: (live ? u.n : 0) + 1, b: live ? u.b || 0 : 0 });
}

/** Called after the user watched a rewarded video. Returns false when today's grants are used up (or user is Plus). */
async function grantBonus(st) {
  if (!st || st.plus) return false;
  const d = today();
  const u = await loadUsage(st.id);
  const live = u && u.day === d;
  const b = live ? u.b || 0 : 0;
  if (b >= BONUS_GRANTS_PER_DAY) return false;
  await saveUsage(st.id, { day: d, n: live ? u.n : 0, b: b + 1 });
  return true;
}

module.exports = { status, consume, grantBonus, countAiCall, installId };
