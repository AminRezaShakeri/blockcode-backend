import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import cookieParser from "cookie-parser";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import nodemailer from "nodemailer";
import { ZarinPal } from "zarinpal-node-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const MAIL_MODE = process.env.MAIL_MODE || "console";
const SMTP_URL = process.env.SMTP_URL || "";
const SMTP_FROM = process.env.SMTP_FROM || "BlokCode <no-reply@example.com>";
const MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || "";
const PAYMENT_SANDBOX = String(process.env.ZARINPAL_SANDBOX || "true").toLowerCase() !== "false";
const PAYMENTS_ENABLED = String(process.env.PAYMENTS_ENABLED || "false").toLowerCase() === "true" && Boolean(MERCHANT_ID);
const PRICE_RIALS = 100_000;
const TOKENS_PER_PURCHASE = 10;
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const COOKIE_NAME = "blokcode_session";
const scrypt = promisify(crypto.scrypt);

if (NODE_ENV === "production" && (MAIL_MODE !== "smtp" || !SMTP_URL)) {
  throw new Error("برای production، MAIL_MODE=smtp و SMTP_URL را تنظیم کنید.");
}
if (NODE_ENV === "production" && new URL(APP_URL).protocol !== "https:") {
  throw new Error("در production، APP_URL باید با https شروع شود.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "blokcode.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    email_verified_at INTEGER,
    verification_token_hash TEXT,
    verification_expires_at INTEGER,
    token_balance INTEGER NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS daily_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, claim_date)
  );

  CREATE TABLE IF NOT EXISTS unlocked_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    UNIQUE (user_id, secret_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_rials INTEGER NOT NULL,
    token_amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    authority TEXT UNIQUE,
    ref_id TEXT,
    created_at INTEGER NOT NULL,
    verified_at INTEGER
  );
`);

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const SECRET_IDS = new Set(
  Array.from(html.matchAll(/data-secret="([a-z0-9_-]+)"/gi), (match) => match[1])
);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", NODE_ENV === "production" ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));
app.use(cookieParser());
app.use(express.json({ limit: "16kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "تعداد تلاش‌ها زیاد است. چند دقیقه دیگر دوباره امتحان کن." }
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

function now() {
  return Date.now();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tehranDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sameOriginWrite(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return res.status(403).json({ error: "درخواست معتبر نیست؛ صفحه را دوباره باز کن." });
  try {
    const expected = `${req.protocol}://${req.get("host")}`;
    if (new URL(origin).origin !== expected) {
      return res.status(403).json({ error: "درخواست از مبدأ نامعتبر رد شد." });
    }
  } catch {
    return res.status(403).json({ error: "درخواست معتبر نیست." });
  }
  next();
}

function getSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.user_id, u.email, u.name, u.token_balance, u.email_verified_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.email_verified_at IS NOT NULL
  `).get(sha256(token), now());
  return row || null;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "برای ادامه وارد حساب تأییدشده‌ات شو." });
  req.account = session;
  next();
}

function serializeAccount(account) {
  if (!account) return { authenticated: false };
  const lastClaim = db.prepare("SELECT MAX(claim_date) AS claim_date FROM daily_claims WHERE user_id = ?")
    .get(account.id || account.user_id)?.claim_date || null;
  const unlocked = db.prepare("SELECT secret_id FROM unlocked_secrets WHERE user_id = ? ORDER BY id")
    .all(account.id || account.user_id).map((row) => row.secret_id);
  return {
    authenticated: true,
    account: { name: account.name, email: account.email },
    emailVerified: Boolean(account.email_verified_at),
    tokens: Number(account.token_balance),
    lastClaimDate: lastClaim,
    unlocked
  };
}

function issueSession(res, userId) {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const createdAt = now();
  const expiresAt = createdAt + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(sha256(rawToken), userId, expiresAt, createdAt);
  res.cookie(COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

function clearSession(req, res) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}

function makeZarinPal() {
  if (!MERCHANT_ID) throw new Error("شناسه پذیرنده زرین‌پال تنظیم نشده است.");
  return new ZarinPal({ merchantId: MERCHANT_ID, sandbox: PAYMENT_SANDBOX });
}

async function sendVerification(email, name, rawToken) {
  const verificationUrl = `${APP_URL}/api/auth/verify?token=${encodeURIComponent(rawToken)}`;
  if (MAIL_MODE === "console") {
    console.log(`\n[BlokCode] لینک تأیید ایمیل ${email}:\n${verificationUrl}\n`);
    return verificationUrl;
  }
  const transport = nodemailer.createTransport(SMTP_URL);
  await transport.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: "تأیید ایمیل حساب بلوک‌کُد",
    text: `سلام ${name}،\n\nبرای تأیید ایمیل و فعال‌کردن حسابت این پیوند را باز کن:\n${verificationUrl}\n\nاین پیوند تا ۲۴ ساعت معتبر است.`,
    html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;line-height:2"><p>سلام ${escapeHtml(name)}،</p><p>برای تأیید ایمیل و فعال‌کردن حسابت روی دکمه بزن.</p><p><a href="${verificationUrl}">تأیید ایمیل</a></p><small>این پیوند تا ۲۴ ساعت معتبر است.</small></div>`
  });
  return null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

app.use("/api", writeLimiter, sameOriginWrite);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/me", (req, res) => {
  const account = getSession(req);
  res.json(serializeAccount(account));
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 24) {
    return res.status(400).json({ error: "نام نمایشی باید بین ۲ تا ۲۴ نویسه باشد." });
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "ایمیل را درست وارد کن." });
  }
  if (password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: "رمز عبور باید دست‌کم ۱۰ نویسه باشد." });
  }

  const existing = db.prepare("SELECT id, email_verified_at FROM users WHERE email = ?").get(email);
  if (existing?.email_verified_at) {
    return res.status(409).json({ error: "این ایمیل قبلاً ثبت شده؛ از بخش ورود استفاده کن." });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  const expiresAt = now() + VERIFY_HOURS * 60 * 60 * 1000;
  let userId;
  if (existing) {
    userId = existing.id;
    db.prepare(`UPDATE users SET name = ?, password_hash = ?, password_salt = ?,
      verification_token_hash = ?, verification_expires_at = ? WHERE id = ?`)
      .run(name, passwordHash, salt, tokenHash, expiresAt, userId);
  } else {
    const result = db.prepare(`INSERT INTO users
      (email, name, password_hash, password_salt, verification_token_hash, verification_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(email, name, passwordHash, salt, tokenHash, expiresAt, now());
    userId = Number(result.lastInsertRowid);
  }

  try {
    const developmentVerificationUrl = await sendVerification(email, name, rawToken);
    res.status(201).json({
      message: "حساب ساخته شد. برای فعال‌کردن آن، پیوند تأیید را از ایمیلت باز کن.",
      ...(developmentVerificationUrl ? { developmentVerificationUrl } : {})
    });
  } catch (error) {
    console.error("Email delivery failed:", error.message);
    res.status(503).json({ error: "ارسال ایمیل تأیید انجام نشد. تنظیمات ایمیل سرور را بررسی کن و دوباره ثبت‌نام کن." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const account = db.prepare(`SELECT id, email, name, password_hash, password_salt,
    email_verified_at, token_balance FROM users WHERE email = ?`).get(email);
  if (!account) return res.status(401).json({ error: "ایمیل یا رمز عبور درست نیست." });
  const candidateHash = (await scrypt(password, account.password_salt, 64)).toString("hex");
  if (!safeEqual(candidateHash, account.password_hash)) {
    return res.status(401).json({ error: "ایمیل یا رمز عبور درست نیست." });
  }
  if (!account.email_verified_at) {
    return res.status(403).json({ error: "اول ایمیلت را با پیوندی که برایت فرستادیم تأیید کن." });
  }
  issueSession(res, account.id);
  res.json(serializeAccount(account));
});

app.post("/api/auth/resend-verification", authLimiter, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const account = db.prepare("SELECT id, name, email_verified_at FROM users WHERE email = ?").get(email);
  let developmentVerificationUrl;
  if (account && !account.email_verified_at) {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    db.prepare(`UPDATE users SET verification_token_hash = ?, verification_expires_at = ? WHERE id = ?`)
      .run(sha256(rawToken), now() + VERIFY_HOURS * 60 * 60 * 1000, account.id);
    try {
      developmentVerificationUrl = await sendVerification(email, account.name, rawToken);
    } catch (error) {
      console.error("Verification email resend failed:", error.message);
      return res.status(503).json({ error: "ارسال ایمیل انجام نشد؛ تنظیمات ایمیل سرور را بررسی کن." });
    }
  }
  res.json({
    message: "اگر این ایمیل حساب تأییدنشده‌ای داشته باشد، پیوند تازه برایش فرستاده شد.",
    ...(developmentVerificationUrl ? { developmentVerificationUrl } : {})
  });
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/verify", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (token.length < 32 || token.length > 128) return res.redirect(303, "/?verified=invalid");
  const account = db.prepare(`SELECT id FROM users WHERE verification_token_hash = ?
    AND verification_expires_at > ? AND email_verified_at IS NULL`).get(sha256(token), now());
  if (!account) return res.redirect(303, "/?verified=invalid");
  db.prepare(`UPDATE users SET email_verified_at = ?, verification_token_hash = NULL,
    verification_expires_at = NULL WHERE id = ?`).run(now(), account.id);
  res.redirect(303, "/?verified=1");
});

app.post("/api/tokens/daily", requireSession, (req, res) => {
  const claimDate = tehranDateKey();
  const claim = db.transaction(() => {
    const inserted = db.prepare(`INSERT OR IGNORE INTO daily_claims (user_id, claim_date, created_at)
      VALUES (?, ?, ?)`).run(req.account.user_id, claimDate, now());
    if (!inserted.changes) return false;
    db.prepare("UPDATE users SET token_balance = token_balance + 1 WHERE id = ?").run(req.account.user_id);
    return true;
  })();
  if (!claim) return res.status(409).json({ error: "توکن امروز را قبلاً گرفته‌ای؛ فردا دوباره سر بزن." });
  const account = db.prepare("SELECT id, email, name, email_verified_at, token_balance FROM users WHERE id = ?")
    .get(req.account.user_id);
  res.json({ ...serializeAccount(account), message: "یک توکن روزانه به کیف تو اضافه شد." });
});

app.post("/api/secrets/:id/unlock", requireSession, (req, res) => {
  const secretId = req.params.id;
  if (!SECRET_IDS.has(secretId)) return res.status(404).json({ error: "این راز در فهرست سایت پیدا نشد." });
  const outcome = db.transaction(() => {
    const alreadyUnlocked = db.prepare("SELECT 1 FROM unlocked_secrets WHERE user_id = ? AND secret_id = ?")
      .get(req.account.user_id, secretId);
    if (alreadyUnlocked) return "already";
    const user = db.prepare("SELECT token_balance FROM users WHERE id = ?").get(req.account.user_id);
    if (user.token_balance < 10) return "insufficient";
    db.prepare("UPDATE users SET token_balance = token_balance - 10 WHERE id = ?").run(req.account.user_id);
    db.prepare("INSERT INTO unlocked_secrets (user_id, secret_id, unlocked_at) VALUES (?, ?, ?)")
      .run(req.account.user_id, secretId, now());
    return "unlocked";
  })();
  if (outcome === "already") return res.status(409).json({ error: "این راز از قبل برای حسابت باز شده است." });
  if (outcome === "insufficient") return res.status(409).json({ error: "برای بازکردن این راز به ۱۰ توکن نیاز داری." });
  const account = db.prepare("SELECT id, email, name, email_verified_at, token_balance FROM users WHERE id = ?")
    .get(req.account.user_id);
  res.json({ ...serializeAccount(account), message: "راز باز شد؛ حالا فرمانش را می‌بینی." });
});

app.post("/api/payments/create", requireSession, async (req, res) => {
  if (!PAYMENTS_ENABLED) {
    return res.status(503).json({ error: "پرداخت هنوز فعال نشده است. مدیر سایت باید شناسه پذیرنده را تنظیم کند." });
  }
  const orderId = crypto.randomUUID();
  const createdAt = now();
  db.prepare(`INSERT INTO payments (order_id, user_id, amount_rials, token_amount, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)`).run(orderId, req.account.user_id, PRICE_RIALS, TOKENS_PER_PURCHASE, createdAt);

  try {
    const zarinpal = makeZarinPal();
    const callbackUrl = `${APP_URL}/api/payments/callback`;
    const payment = await zarinpal.payments.create({
      amount: PRICE_RIALS,
      currency: "IRR",
      callback_url: callbackUrl,
      description: `خرید ${TOKENS_PER_PURCHASE} توکن بلوک‌کُد - ${orderId.slice(0, 8)}`,
      email: req.account.email
    });
    const data = payment?.data;
    const authority = data?.authority;
    if (Number(data?.code) !== 100 || typeof authority !== "string" || authority.length > 128) {
      throw new Error("درگاه درخواست پرداخت را نپذیرفت.");
    }
    db.prepare("UPDATE payments SET authority = ? WHERE order_id = ?").run(authority, orderId);
    const redirectUrl = await zarinpal.payments.getRedirectUrl(authority);
    res.json({ redirectUrl });
  } catch (error) {
    db.prepare("UPDATE payments SET status = 'failed' WHERE order_id = ? AND status = 'pending'").run(orderId);
    console.error("ZarinPal request failed:", error.message);
    res.status(502).json({ error: "اتصال به زرین‌پال انجام نشد. چند دقیقه دیگر دوباره تلاش کن." });
  }
});

app.get("/api/payments/callback", async (req, res) => {
  const status = typeof req.query.Status === "string" ? req.query.Status : "";
  const authority = typeof req.query.Authority === "string" ? req.query.Authority : "";
  if (!authority || authority.length > 128) return res.redirect(303, "/?payment=failed");
  const order = db.prepare("SELECT * FROM payments WHERE authority = ?").get(authority);
  if (!order) return res.redirect(303, "/?payment=failed");
  if (order.status === "paid") return res.redirect(303, "/?payment=success");
  if (status !== "OK" || order.status !== "pending") {
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(order.id);
    return res.redirect(303, "/?payment=cancelled");
  }

  try {
    const zarinpal = makeZarinPal();
    const verification = await zarinpal.verifications.verify({
      amount: order.amount_rials,
      authority
    });
    const data = verification?.data;
    const code = Number(data?.code);
    if (code !== 100 && code !== 101) {
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(order.id);
      return res.redirect(303, "/?payment=failed");
    }

    const refId = data?.ref_id == null ? null : String(data.ref_id);
    db.transaction(() => {
      const pendingOrder = db.prepare("SELECT status FROM payments WHERE id = ?").get(order.id);
      if (pendingOrder?.status !== "pending") return;
      db.prepare("UPDATE payments SET status = 'paid', ref_id = ?, verified_at = ? WHERE id = ?")
        .run(refId, now(), order.id);
      db.prepare("UPDATE users SET token_balance = token_balance + ? WHERE id = ?")
        .run(order.token_amount, order.user_id);
    })();
    res.redirect(303, "/?payment=success");
  } catch (error) {
    console.error("ZarinPal verification failed:", error.message);
    res.redirect(303, "/?payment=failed");
  }
});

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store").send(
    `window.BLOKCODE_CONFIG = ${JSON.stringify({
      demoMode: false,
      paymentsEnabled: PAYMENTS_ENABLED,
      paymentSandbox: PAYMENT_SANDBOX
    })};`
  );
});

const staticOptions = {
  dotfiles: "deny",
  etag: true,
  maxAge: NODE_ENV === "production" ? "1h" : 0
};
app.get(["/", "/index.html"], (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.get("/app.js", (_req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.use("/assets", express.static(path.join(__dirname, "assets"), staticOptions));
app.use((_req, res) => res.status(404).json({ error: "این نشانی پیدا نشد." }));

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "خطای داخلی رخ داد. دوباره تلاش کن." });
});

app.listen(PORT, () => {
  console.log(`BlokCode server is running at ${APP_URL}`);
  console.log(`Payments: ${PAYMENTS_ENABLED ? (PAYMENT_SANDBOX ? "sandbox" : "live") : "disabled"}`);
  console.log(`Email: ${MAIL_MODE}`);
});
