const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "6123");
const APP_SECRET = String(process.env.APP_SECRET || "change-this-secret-now");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const LOCATION_RETENTION_DAYS = 30;
const MAX_LOCATION_POINTS = 5000;
const MIN_LOCATION_UPDATE_MS = 3000; // মোবাইল ট্র্যাকিং স্মুথ রাখতে ৩ সেকেন্ড করা হয়েছে

fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultDb() {
  return {
    registrations: [],
    settings: {
      telegramChatId: "",
      telegramBotTokenEncrypted: ""
    }
  };
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const db = defaultDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
      return db;
    }
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
      settings: {
        telegramChatId: parsed.settings?.telegramChatId || "",
        telegramBotTokenEncrypted: parsed.settings?.telegramBotTokenEncrypted || ""
      }
    };
  } catch {
    return defaultDb();
  }
}

function saveDb(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIsoFrom(baseIso, days) {
  const d = new Date(baseIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function locationPoint(latitude, longitude, accuracy) {
  const capturedAt = nowIso();
  return {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
    capturedAt,
    expiresAt: addDaysIsoFrom(capturedAt, LOCATION_RETENTION_DAYS)
  };
}

function cleanExpiredLocations(db) {
  const now = Date.now();
  let changed = false;

  for (const r of db.registrations) {
    if (!Array.isArray(r.locationHistory)) {
      r.locationHistory = r.location ? [{
        ...r.location,
        expiresAt: r.locationExpiresAt || addDaysIsoFrom(r.location.capturedAt || r.createdAt || nowIso(), LOCATION_RETENTION_DAYS)
      }] : [];
      changed = true;
    }

    const kept = r.locationHistory.filter(p => {
      const exp = new Date(p.expiresAt || 0).getTime();
      return Number.isFinite(exp) && exp > now;
    });

    if (kept.length !== r.locationHistory.length) {
      r.locationHistory = kept;
      changed = true;
    }

    const latest = kept.length ? kept[kept.length - 1] : null;
    const oldLat = r.location?.latitude;
    const newLat = latest?.latitude;

    if (oldLat !== newLat || (!!r.location !== !!latest)) {
      r.location = latest ? {
        latitude: latest.latitude,
        longitude: latest.longitude,
        accuracy: latest.accuracy,
        capturedAt: latest.capturedAt
      } : null;
      r.locationExpiresAt = latest?.expiresAt || null;
      r.locationExpired = !latest;
      changed = true;
    }
  }

  if (changed) saveDb(db);
  return db;
}

function validPhone(v) {
  return /^01[3-9]\d{8}$/.test(String(v || "").trim());
}

function normalizeText(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function getKey() {
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function encryptSecret(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(enc) {
  if (!enc) return "";
  try {
    const raw = Buffer.from(enc, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", APP_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", APP_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req).admin_session;
  const session = verifySession(token);
  if (!session || session.role !== "admin") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function hashTrackingToken(token) {
  return crypto.createHmac("sha256", APP_SECRET).update(String(token)).digest("hex");
}

function safeAdminRecord(r) {
  const { trackingTokenHash, ...safe } = r;
  return safe;
}

function validateLocation(loc) {
  if (!loc) return null;
  const latitude = Number(loc.latitude);
  const longitude = Number(loc.longitude);
  const accuracy = Number(loc.accuracy);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude, accuracy };
}

async function sendTelegram(text) {
  const db = loadDb();
  const token = decryptSecret(db.settings.telegramBotTokenEncrypted);
  const chatId = db.settings.telegramChatId;
  if (!token || !chatId) return { ok: false, skipped: true };

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(data.description || "Telegram send failed");
  }
  return { ok: true };
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/register/start", (req, res) => {
  const name = normalizeText(req.body?.name, 80);
  const address = normalizeText(req.body?.address, 200);
  const phone = normalizeText(req.body?.phone, 20);
  const age = Number(req.body?.age);
  const consent = req.body?.consent === true || req.body?.consent === "true";
  const loc = validateLocation(req.body?.location);

  if (name.length < 2) return res.status(400).json({ error: "সঠিক নাম দিন।" });
  if (address.length < 4) return res.status(400).json({ error: "সঠিক ঠিকানা দিন।" });
  if (!validPhone(phone)) return res.status(400).json({ error: "সঠিক মোবাইল নাম্বার দিন।" });
  if (!Number.isFinite(age) || age < 18 || age > 100) {
    return res.status(400).json({ error: "বয়স ১৮-১০০ এর মধ্যে হতে হবে।" });
  }
  if (!consent) return res.status(400).json({ error: "লোকেশন ও তথ্য শেয়ারের সম্মতি প্রয়োজন।" });
  if (!loc) return res.status(400).json({ error: "বৈধ লোকেশন পাওয়া যায়নি।" });

  const db = cleanExpiredLocations(loadDb());
  const id = crypto.randomUUID();
  const trackingToken = crypto.randomBytes(32).toString("base64url");
  const firstPoint = locationPoint(loc.latitude, loc.longitude, loc.accuracy);

  const record = {
    id,
    name,
    address,
    phone,
    age,
    location: {
      latitude: firstPoint.latitude,
      longitude: firstPoint.longitude,
      accuracy: firstPoint.accuracy,
      capturedAt: firstPoint.capturedAt
    },
    locationHistory: [firstPoint],
    locationConsent: true,
    locationExpiresAt: firstPoint.expiresAt,
    locationExpired: false,
    liveTrackingLastSeenAt: null,
    trackingTokenHash: hashTrackingToken(trackingToken),
    paymentMethod: "",
    paymentNumber: "",
    status: "awaiting_payment",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  db.registrations.unshift(record);
  saveDb(db);

  res.json({
    ok: true,
    registrationId: id,
    trackingToken,
    locationRetentionDays: LOCATION_RETENTION_DAYS
  });
});

app.post("/api/register/:id/location", (req, res) => {
  const token = String(req.get("X-Tracking-Token") || "");
  if (!token) return res.status(401).json({ error: "Tracking token required" });

  const consent = req.body?.consent === true || req.body?.consent === "true";
  const loc = validateLocation(req.body?.location);

  if (!consent) return res.status(400).json({ error: "Live location consent required" });
  if (!loc) return res.status(400).json({ error: "Invalid location" });

  const db = cleanExpiredLocations(loadDb());
  const record = db.registrations.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: "Registration not found" });

  const suppliedHash = hashTrackingToken(token);
  const savedHash = String(record.trackingTokenHash || "");
  const a = Buffer.from(suppliedHash);
  const b = Buffer.from(savedHash);
  if (!savedHash || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid tracking token" });
  }

  const lastMs = new Date(record.liveTrackingLastSeenAt || 0).getTime();
  if (Number.isFinite(lastMs) && Date.now() - lastMs < MIN_LOCATION_UPDATE_MS) {
    return res.status(429).json({ error: "Location update too frequent" });
  }

  const point = locationPoint(loc.latitude, loc.longitude, loc.accuracy);
  if (!Array.isArray(record.locationHistory)) record.locationHistory = [];
  record.locationHistory.push(point);
  if (record.locationHistory.length > MAX_LOCATION_POINTS) {
    record.locationHistory = record.locationHistory.slice(-MAX_LOCATION_POINTS);
  }

  record.location = {
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy,
    capturedAt: point.capturedAt
  };
  record.locationExpiresAt = point.expiresAt;
  record.locationExpired = false;
  record.liveTrackingLastSeenAt = point.capturedAt;
  record.updatedAt = nowIso();

  saveDb(db);
  res.json({ ok: true, capturedAt: point.capturedAt, expiresAt: point.expiresAt });
});

app.post("/api/register/:id/tracking-stop", (req, res) => {
  const token = String(req.get("X-Tracking-Token") || "");
  if (!token) return res.status(401).json({ error: "Tracking token required" });

  const db = loadDb();
  const record = db.registrations.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: "Registration not found" });

  const suppliedHash = hashTrackingToken(token);
  const savedHash = String(record.trackingTokenHash || "");
  const a = Buffer.from(suppliedHash);
  const b = Buffer.from(savedHash);
  if (!savedHash || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid tracking token" });
  }

  record.updatedAt = nowIso();
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/register/:id/payment", async (req, res) => {
  const method = normalizeText(req.body?.paymentMethod, 20);
  const number = normalizeText(req.body?.paymentNumber, 20);

  if (!["bKash", "Nagad"].includes(method)) {
    return res.status(400).json({ error: "bKash অথবা Nagad নির্বাচন করুন।" });
  }
  if (!validPhone(number)) {
    return res.status(400).json({ error: "সঠিক bKash/Nagad নাম্বার দিন।" });
  }

  const db = cleanExpiredLocations(loadDb());
  const record = db.registrations.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: "Registration not found" });

  record.paymentMethod = method;
  record.paymentNumber = number;
  record.status = "complete";
  record.updatedAt = nowIso();
  saveDb(db);

  try {
    await sendTelegram(registrationMessage(record));
  } catch (e) {
    console.error("Telegram Error:", e.message);
  }

  res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  const pin = String(req.body?.pin || "");
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: "ভুল PIN" });

  const token = signSession({
    role: "admin",
    exp: Date.now() + 8 * 60 * 60 * 1000
  });

  res.setHeader(
    "Set-Cookie",
    `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 60 * 60}`
  );
  res.json({ ok: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/registrations", requireAdmin, (req, res) => {
  const db = cleanExpiredLocations(loadDb());
  res.json({
    registrations: db.registrations.map(safeAdminRecord),
    total: db.registrations.length
  });
});

app.delete("/api/admin/registrations/:id", requireAdmin, (req, res) => {
  const db = loadDb();
  const before = db.registrations.length;
  db.registrations = db.registrations.filter(r => r.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true, deleted: before !== db.registrations.length });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({
    telegramChatId: db.settings.telegramChatId || "",
    hasTelegramBotToken: Boolean(db.settings.telegramBotTokenEncrypted)
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const db = loadDb();
  const chatId = normalizeText(req.body?.telegramChatId, 100);
  const token = normalizeText(req.body?.telegramBotToken, 300);

  db.settings.telegramChatId = chatId;
  if (token) db.settings.telegramBotTokenEncrypted = encryptSecret(token);

  saveDb(db);
  res.json({ ok: true, hasTelegramBotToken: Boolean(db.settings.telegramBotTokenEncrypted) });
});

app.post("/api/admin/telegram/test", requireAdmin, async (req, res) => {
  try {
    const result = await sendTelegram("✅ Telegram connection test successful.");
    if (result.skipped) {
      return res.status(400).json({ error: "Bot Token ও Chat ID আগে Save করুন।" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || "Telegram test failed" });
  }
});

setInterval(() => {
  try { cleanExpiredLocations(loadDb()); } catch {}
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
