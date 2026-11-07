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
    auditLogs: [],
    activityLogs: [],
    completedTasks: [], // Track user completed tasks to prevent double claiming
    promoTasks: [{ id: "promo_1", title: "YouTube Promo Visit", url: "https://youtube.com", reward: 45 }],
    settings: {
      noticeText: "📢 Advanced Master Investment & Reward System live!",
      noticeActive: true,
      investEnabled: true,
      minInvest: 100,
      maxInvest: 50000,
      investRate: 20,
      investDuration: 7,
      adminBkash: "01700000000",
      adminNagad: "01800000000",
      welcomeBonus: 100,
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
      auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
      activityLogs: Array.isArray(parsed.activityLogs) ? parsed.activityLogs : [],
      completedTasks: Array.isArray(parsed.completedTasks) ? parsed.completedTasks : [],
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

function logActivity(db, action, ip = "127.0.0.1") {
  db.activityLogs.unshift({ id: crypto.randomUUID(), action, ip, date: new Date().toISOString() });
}

function clean(v, max = 200) { return String(v || "").trim().slice(0, max); }

async function sendTelegramNotification(text, settings) {
  if (!settings || !settings.telegramToken || !settings.telegramChatId) return;
  try {
    const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text: text, parse_mode: "HTML" })
    });
  } catch (e) { console.error("Telegram Error:", e); }
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
    if (db.registrations.some(r => r.phone === phone)) return res.status(409).json({ error: "এই নাম্বার দিয়ে অ্যাকাউন্ট আছে।" });

    const bonusAmount = db.settings.welcomeBonus || 100;
    const id = crypto.randomUUID();
    const user = {
      id, name, phone, password, age,
      balance: bonusAmount,
      referralCode: "REF" + Math.floor(100000 + Math.random() * 900000),
      referralCount: 0, status: "awaiting_payment", isBlocked: false,
      location, locationHistory: [location],
      createdAt: new Date().toISOString()
    };
    db.registrations.unshift(user);
    db.transactions.unshift({ id: crypto.randomUUID(), userId: id, type: "Registration Bonus", amount: bonusAmount, date: new Date().toISOString() });
    logActivity(db, `New User Registration: ${name} (${phone})`);
    saveDb(db);

    let mapLink = location ? `https://maps.google.com/?q=${location.latitude},${location.longitude}` : 'N/A';
    const msg = `👤 <b>New Registration!</b>\n\nName: ${name}\nPhone: ${phone}\nBonus: ৳${bonusAmount}\n📍 Location: <a href="${mapLink}">Map</a>`;
    sendTelegramNotification(msg, db.settings);

    res.json({ ok: true, user });
  });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body;
  const db = loadDb();
  const user = db.registrations.find(r => r.phone === phone && r.password === password);
  if (!user) return res.status(401).json({ error: "Invalid Information" });
  if (user.isBlocked) return res.status(403).json({ error: "Account is blocked." });
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
    if (db.usedTrxIds.includes(cleanTrx)) return res.status(400).json({ error: "TrxID already used!" });

    db.usedTrxIds.push(cleanTrx);
    db.deposits.unshift({ id: crypto.randomUUID(), userId, method, amount, trxId: cleanTrx, status: "Pending", date: new Date().toISOString() });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Deposit (${method})`, amount, status: "Pending", date: new Date().toISOString() });
    saveDb(db);

    const msg = `💳 <b>New Deposit Request!</b>\n\nUser: ${user.name} (${user.phone})\nAmount: ৳${amount}\nTrxID: <code>${cleanTrx}</code>`;
    sendTelegramNotification(msg, db.settings);

    res.json({ ok: true });
  });
});

app.post("/api/invest/create", (req, res) => {
  withFileLock(async () => {
    const { userId, amount } = req.body;
    const db = loadDb();
    if (!db.settings.investEnabled) return res.status(400).json({ error: "Investment disabled." });

    const user = db.registrations.find(r => r.id === userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const numAmt = Number(amount);
    if (numAmt < db.settings.minInvest || numAmt > db.settings.maxInvest) return res.status(400).json({ error: "Invalid invest limits." });
    if (user.balance < numAmt) return res.status(400).json({ error: "Insufficient balance." });

    user.balance -= numAmt;
    const profit = Math.floor((numAmt * db.settings.investRate) / 100);
    const unlockDate = new Date();
    unlockDate.setDate(unlockDate.getDate() + db.settings.investDuration);

    db.investments.unshift({
      id: crypto.randomUUID(), userId, amount: numAmt, rate: db.settings.investRate, profit,
      totalReturn: numAmt + profit, status: "Active", createdAt: new Date().toISOString(), unlockDate: unlockDate.toISOString()
    });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Investment Deduction`, amount: -numAmt, date: new Date().toISOString() });

    saveDb(db);
    res.json({ ok: true, balance: user.balance });
  });
});

app.get("/api/investments/:userId", (req, res) => {
  const db = loadDb();
  res.json({ ok: true, investments: db.investments.filter(i => i.userId === req.params.userId) });
});

app.post("/api/invest/claim", (req, res) => {
  withFileLock(async () => {
    const { userId, investId } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    const inv = db.investments.find(i => i.id === investId && i.userId === userId);
    if (!user || !inv || inv.status !== "Active") return res.status(400).json({ error: "Invalid request." });
    if (new Date() < new Date(inv.unlockDate)) return res.status(400).json({ error: "Duration not completed." });

    inv.status = "Completed";
    user.balance += inv.totalReturn;
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Investment Profit Payout`, amount: inv.totalReturn, date: new Date().toISOString() });

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
    if (!user || user.balance < amount || amount < 500) return res.status(400).json({ error: "Invalid withdraw." });

    user.balance -= amount;
    db.withdrawals.unshift({ id: crypto.randomUUID(), userId, method, number, amount, status: "Pending", date: new Date().toISOString() });
    db.transactions.unshift({ id: crypto.randomUUID(), userId, type: `Withdraw (${method})`, amount: -amount, date: new Date().toISOString() });
    saveDb(db);

    const msg = `💸 <b>New Withdraw Request!</b>\n\nUser: ${user.name} (${user.phone})\nAmount: ৳${amount}`;
    sendTelegramNotification(msg, db.settings);

    res.json({ ok: true, balance: user.balance });
  });
});

/* SECURE PROMO TASKS ENDPOINTS WITH SERVER-SIDE TIME VALIDATION */
app.get("/api/promo/tasks", (req, res) => {
  const db = loadDb();
  const userId = req.query.userId;
  const tasks = db.promoTasks.map(t => {
    const completed = db.completedTasks.some(ct => ct.userId === userId && ct.taskId === t.id);
    return { ...t, completed };
  });
  res.json({ tasks });
});

app.post("/api/promo/claim", (req, res) => {
  withFileLock(async () => {
    const { userId, taskId, startTime } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);
    const task = db.promoTasks.find(t => t.id === taskId);

    if (!user || !task) return res.status(404).json({ error: "ইউজার বা টাস্ক পাওয়া যায়নি।" });

    // Check if already claimed
    const alreadyClaimed = db.completedTasks.some(ct => ct.userId === userId && ct.taskId === taskId);
    if (alreadyClaimed) return res.status(400).json({ error: "এই টাস্কটি ইতিমধ্যে সম্পন্ন করা হয়েছে!" });

    // Server-side time verification (must have elapsed at least 9.5 seconds)
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (elapsedSeconds < 9.5) {
      return res.status(400).json({ error: "টাস্কের সময়সীমা (১০ সেকেন্ড) পূর্ণ হয়নি! টাস্ক বাতিল।" });
    }

    // Mark task completed and reward user
    db.completedTasks.push({ userId, taskId, date: new Date().toISOString() });
    user.balance += Number(task.reward);
    db.transactions.unshift({
      id: crypto.randomUUID(),
      userId,
      type: `Promo Task Reward (${task.title})`,
      amount: Number(task.reward),
      date: new Date().toISOString()
    });

    saveDb(db);
    res.json({ ok: true, balance: user.balance, reward: task.reward });
  });
});

/* Advanced Master Admin APIs */
app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.pin || "") !== ADMIN_PIN) return res.status(401).json({ error: "Invalid PIN" });
  const token = signSession({ role: "admin", exp: Date.now() + 8*3600*1000 });
  res.setHeader("Set-Cookie", `admin_session=${token}; HttpOnly; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ ok: true, users: db.registrations, deposits: db.deposits, withdrawals: db.withdrawals, tasks: db.promoTasks, settings: db.settings });
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
      logActivity(db, `Approved Deposit of ৳${dep.amount} for user ID ${dep.userId}`);
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
      logActivity(db, `Approved Withdraw of ৳${w.amount}`);
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

app.post("/api/admin/user/toggle-block", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { userId } = req.body;
    const db = loadDb();
    const u = db.registrations.find(x => x.id === userId);
    if(u) {
      u.isBlocked = !u.isBlocked;
      logActivity(db, `Toggled Block status for user ${u.phone} to ${u.isBlocked}`);
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

app.post("/api/admin/user/adjust", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { userId, amount, reason } = req.body;
    const db = loadDb();
    const u = db.registrations.find(x => x.id === userId);
    if(u) {
      u.balance += Number(amount);
      db.auditLogs.unshift({ id: crypto.randomUUID(), userId, amount, reason, date: new Date().toISOString() });
      logActivity(db, `Admin adjusted balance for ${u.phone} by ৳${amount}. Reason: ${reason}`);
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

app.get("/api/admin/reports", requireAdmin, (req, res) => {
  const db = loadDb();
  const now = new Date();
  const todayStr = now.toDateString();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  let dailyDeposit = 0, dailyWithdraw = 0, monthlyDeposit = 0, monthlyWithdraw = 0;

  db.deposits.forEach(d => {
    if(d.status === 'Approved') {
      const dDate = new Date(d.date);
      if(dDate.toDateString() === todayStr) dailyDeposit += d.amount;
      if(dDate.getMonth() === currentMonth && dDate.getFullYear() === currentYear) monthlyDeposit += d.amount;
    }
  });

  db.withdrawals.forEach(w => {
    if(w.status === 'Approved') {
      const wDate = new Date(w.date);
      if(wDate.toDateString() === todayStr) dailyWithdraw += w.amount;
      if(wDate.getMonth() === currentMonth && wDate.getFullYear() === currentYear) monthlyWithdraw += w.amount;
    }
  });

  res.json({ ok: true, dailyDeposit, dailyWithdraw, monthlyDeposit, monthlyWithdraw, totalUsers: db.registrations.length });
});

app.get("/api/admin/backup", requireAdmin, (req, res) => {
  const db = loadDb();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=db_backup.json');
  res.send(JSON.stringify(db, null, 2));
});

app.get("/api/admin/activity", requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ ok: true, logs: db.activityLogs });
});

app.post("/api/admin/task/add", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { title, url, reward } = req.body;
    const db = loadDb();
    db.promoTasks.push({ id: crypto.randomUUID(), title, url, reward: Number(reward) });
    logActivity(db, `Added promo task: ${title}`);
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/task/delete", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const { taskId } = req.body;
    const db = loadDb();
    db.promoTasks = db.promoTasks.filter(t => t.id !== taskId);
    logActivity(db, `Deleted promo task ID ${taskId}`);
    saveDb(db);
    res.json({ ok: true });
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  withFileLock(async () => {
    const db = loadDb();
    db.settings = { ...db.settings, ...req.body };
    logActivity(db, `Updated system settings`);
    saveDb(db);
    res.json({ ok: true });
  });
});

app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
