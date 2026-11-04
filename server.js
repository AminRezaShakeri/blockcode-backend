import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import cookieParser from "cookie-parser";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import nodemailer from "nodemailer";
import pg from "pg";
import { ZarinPal } from "zarinpal-node-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_SSL = String(process.env.DATABASE_SSL ?? "true").toLowerCase() !== "false";
const DATABASE_SSL_CA = process.env.DATABASE_SSL_CA || "";
const MAIL_MODE = process.env.MAIL_MODE || "console";
const SMTP_URL = process.env.SMTP_URL || "";
const SMTP_FROM = process.env.SMTP_FROM || "BlokCode <no-reply@example.com>";
const ALLOW_DEVELOPMENT_VERIFICATION_LINKS = String(process.env.ALLOW_DEVELOPMENT_VERIFICATION_LINKS || "false").toLowerCase() === "true";
const MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || "";
const PAYMENT_SANDBOX = String(process.env.ZARINPAL_SANDBOX || "true").toLowerCase() !== "false";
const PAYMENTS_ENABLED = String(process.env.PAYMENTS_ENABLED || "false").toLowerCase() === "true" && Boolean(MERCHANT_ID);
const CARD_TRANSFER_REQUESTED = String(process.env.CARD_TRANSFER_ENABLED || "false").toLowerCase() === "true";
const CARD_TRANSFER_CARD_NUMBER = String(process.env.CARD_TRANSFER_CARD_NUMBER || "").replace(/\D/g, "");
const CARD_TRANSFER_CARD_HOLDER = String(process.env.CARD_TRANSFER_CARD_HOLDER || "").trim();
const CARD_TRANSFER_ENABLED = CARD_TRANSFER_REQUESTED && /^\d{16}$/.test(CARD_TRANSFER_CARD_NUMBER);
const PRICE_TOMANS = 10_000;
const PRICE_RIALS = PRICE_TOMANS * 10;
const TOKENS_PER_PURCHASE = 10;
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const COOKIE_NAME = "blokcode_session";
const scrypt = promisify(crypto.scrypt);

if (NODE_ENV === "production" && (MAIL_MODE !== "smtp" || !SMTP_URL) && !ALLOW_DEVELOPMENT_VERIFICATION_LINKS) {
  throw new Error("برای production، MAIL_MODE=smtp و SMTP_URL را تنظیم کنید.");
}
if (NODE_ENV === "production" && new URL(APP_URL).protocol !== "https:") {
  throw new Error("در production، APP_URL باید با https شروع شود.");
}
if (NODE_ENV === "production" && !DATABASE_SSL) {
  throw new Error("در production، اتصال رمزگذاری‌شده به پایگاه‌داده الزامی است.");
}
if (NODE_ENV === "production" && ALLOW_DEVELOPMENT_VERIFICATION_LINKS) {
  console.warn("Demo mode: verification links are shown to the registering user instead of being emailed.");
}

const { Pool } = pg;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL تنظیم نشده است؛ آدرس اتصال Supabase را در Environment سرور قرار بده.");
}

const databaseUrl = new URL(DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  throw new Error("DATABASE_URL باید یک نشانی PostgreSQL معتبر باشد.");
}
if (["sslcert", "sslkey", "sslrootcert"].some((key) => databaseUrl.searchParams.has(key))) {
  throw new Error("برای اتصال از گواهی SSL سفارشی، تنظیمات گواهی را جداگانه پیکربندی کن.");
}
// pg's connection-string parser can override the Pool SSL options when sslmode is present.
// Apply TLS explicitly so certificate verification remains enabled.
databaseUrl.searchParams.delete("sslmode");
const databaseSsl = DATABASE_SSL
  ? {
      rejectUnauthorized: true,
      ...(DATABASE_SSL_CA ? { ca: DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {})
    }
  : false;
const db = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: databaseSsl,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000
});
db.on("error", (error) => console.error("Unexpected PostgreSQL pool error:", error.message));

async function initializeDatabase() {
  await db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    email_verified_at BIGINT,
    verification_token_hash TEXT,
    verification_expires_at BIGINT,
    token_balance BIGINT NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
    created_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS daily_claims (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_date TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE (user_id, claim_date)
  );

  CREATE TABLE IF NOT EXISTS unlocked_secrets (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL,
    unlocked_at BIGINT NOT NULL,
    UNIQUE (user_id, secret_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_rials BIGINT NOT NULL,
    token_amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    authority TEXT UNIQUE,
    ref_id TEXT,
    created_at BIGINT NOT NULL,
    verified_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    product_name TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    customer_contact TEXT NOT NULL,
    tracking_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'delivered', 'rejected', 'cancelled')),
    delivery_code TEXT
  );
  ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON public.orders (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS orders_tracking_code_idx ON public.orders (tracking_code) WHERE tracking_code IS NOT NULL;
  CREATE INDEX IF NOT EXISTS orders_user_created_at_idx ON public.orders (user_id, created_at DESC);
  ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
  `);
}

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

async function withTransaction(work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("PostgreSQL rollback failed:", rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const result = await db.query(`
    SELECT s.user_id, u.email, u.name, u.token_balance, u.email_verified_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.email_verified_at IS NOT NULL
  `, [sha256(token), now()]);
  return result.rows[0] || null;
}

async function requireSession(req, res, next) {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: "برای ادامه وارد حساب تأییدشده‌ات شو." });
  req.account = session;
  next();
}

async function serializeAccount(account) {
  if (!account) return { authenticated: false };
  const userId = account.id ?? account.user_id;
  const [lastClaimResult, unlockedResult] = await Promise.all([
    db.query("SELECT MAX(claim_date) AS claim_date FROM daily_claims WHERE user_id = $1", [userId]),
    db.query("SELECT secret_id FROM unlocked_secrets WHERE user_id = $1 ORDER BY id", [userId])
  ]);
  const lastClaim = lastClaimResult.rows[0]?.claim_date || null;
  const unlocked = unlockedResult.rows.map((row) => row.secret_id);
  return {
    authenticated: true,
    account: { name: account.name, email: account.email },
    emailVerified: Boolean(account.email_verified_at),
    tokens: Number(account.token_balance),
    lastClaimDate: lastClaim,
    unlocked
  };
}

async function issueSession(res, userId) {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const createdAt = now();
  const expiresAt = createdAt + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)",
    [sha256(rawToken), userId, expiresAt, createdAt]);
  res.cookie(COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

async function clearSession(req, res) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
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

app.get("/api/health", async (_req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const account = await getSession(req);
  res.json(await serializeAccount(account));
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

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  const expiresAt = now() + VERIFY_HOURS * 60 * 60 * 1000;
  const result = await db.query(`INSERT INTO users
    (email, name, password_hash, password_salt, verification_token_hash, verification_expires_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (email) DO UPDATE SET
      name = EXCLUDED.name,
      password_hash = EXCLUDED.password_hash,
      password_salt = EXCLUDED.password_salt,
      verification_token_hash = EXCLUDED.verification_token_hash,
      verification_expires_at = EXCLUDED.verification_expires_at
    WHERE users.email_verified_at IS NULL
    RETURNING id`, [email, name, passwordHash, salt, tokenHash, expiresAt, now()]);
  if (!result.rowCount) {
    return res.status(409).json({ error: "این ایمیل قبلاً ثبت شده؛ از بخش ورود استفاده کن." });
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
  const accountResult = await db.query(`SELECT id, email, name, password_hash, password_salt,
    email_verified_at, token_balance FROM users WHERE email = $1`, [email]);
  const account = accountResult.rows[0];
  if (!account) return res.status(401).json({ error: "ایمیل یا رمز عبور درست نیست." });
  const candidateHash = (await scrypt(password, account.password_salt, 64)).toString("hex");
  if (!safeEqual(candidateHash, account.password_hash)) {
    return res.status(401).json({ error: "ایمیل یا رمز عبور درست نیست." });
  }
  if (!account.email_verified_at) {
    return res.status(403).json({ error: "اول ایمیلت را با پیوندی که برایت فرستادیم تأیید کن." });
  }
  await issueSession(res, account.id);
  res.json(await serializeAccount(account));
});

app.post("/api/auth/resend-verification", authLimiter, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const accountResult = await db.query("SELECT id, name, email_verified_at FROM users WHERE email = $1", [email]);
  const account = accountResult.rows[0];
  let developmentVerificationUrl;
  if (account && !account.email_verified_at) {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    await db.query(`UPDATE users SET verification_token_hash = $1, verification_expires_at = $2 WHERE id = $3`,
      [sha256(rawToken), now() + VERIFY_HOURS * 60 * 60 * 1000, account.id]);
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

app.post("/api/auth/logout", async (req, res) => {
  await clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/verify", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (token.length < 32 || token.length > 128) return res.redirect(303, "/?verified=invalid");
  const accountResult = await db.query(`SELECT id FROM users WHERE verification_token_hash = $1
    AND verification_expires_at > $2 AND email_verified_at IS NULL`, [sha256(token), now()]);
  const account = accountResult.rows[0];
  if (!account) return res.redirect(303, "/?verified=invalid");
  await db.query(`UPDATE users SET email_verified_at = $1, verification_token_hash = NULL,
    verification_expires_at = NULL WHERE id = $2`, [now(), account.id]);
  res.redirect(303, "/?verified=1");
});

app.post("/api/tokens/daily", requireSession, async (req, res) => {
  const claimDate = tehranDateKey();
  const claim = await withTransaction(async (client) => {
    const inserted = await client.query(`INSERT INTO daily_claims (user_id, claim_date, created_at)
      VALUES ($1, $2, $3) ON CONFLICT (user_id, claim_date) DO NOTHING RETURNING id`,
    [req.account.user_id, claimDate, now()]);
    if (!inserted.rowCount) return false;
    await client.query("UPDATE users SET token_balance = token_balance + 1 WHERE id = $1", [req.account.user_id]);
    return true;
  });
  if (!claim) return res.status(409).json({ error: "توکن امروز را قبلاً گرفته‌ای؛ فردا دوباره سر بزن." });
  const accountResult = await db.query("SELECT id, email, name, email_verified_at, token_balance FROM users WHERE id = $1",
    [req.account.user_id]);
  res.json({ ...await serializeAccount(accountResult.rows[0]), message: "یک توکن روزانه به کیف تو اضافه شد." });
});

app.post("/api/secrets/:id/unlock", requireSession, async (req, res) => {
  const secretId = req.params.id;
  if (!SECRET_IDS.has(secretId)) return res.status(404).json({ error: "این راز در فهرست سایت پیدا نشد." });
  const outcome = await withTransaction(async (client) => {
    const userResult = await client.query("SELECT token_balance FROM users WHERE id = $1 FOR UPDATE", [req.account.user_id]);
    const user = userResult.rows[0];
    if (!user) return "missing";
    const alreadyUnlocked = await client.query("SELECT 1 FROM unlocked_secrets WHERE user_id = $1 AND secret_id = $2",
      [req.account.user_id, secretId]);
    if (alreadyUnlocked.rowCount) return "already";
    if (Number(user.token_balance) < 10) return "insufficient";
    await client.query("UPDATE users SET token_balance = token_balance - 10 WHERE id = $1", [req.account.user_id]);
    await client.query("INSERT INTO unlocked_secrets (user_id, secret_id, unlocked_at) VALUES ($1, $2, $3)",
      [req.account.user_id, secretId, now()]);
    return "unlocked";
  });
  if (outcome === "missing") return res.status(401).json({ error: "حساب کاربری پیدا نشد؛ دوباره وارد شو." });
  if (outcome === "already") return res.status(409).json({ error: "این راز از قبل برای حسابت باز شده است." });
  if (outcome === "insufficient") return res.status(409).json({ error: "برای بازکردن این راز به ۱۰ توکن نیاز داری." });
  const accountResult = await db.query("SELECT id, email, name, email_verified_at, token_balance FROM users WHERE id = $1",
    [req.account.user_id]);
  res.json({ ...await serializeAccount(accountResult.rows[0]), message: "راز باز شد؛ حالا فرمانش را می‌بینی." });
});

app.post("/api/orders", requireSession, async (req, res) => {
  if (!CARD_TRANSFER_ENABLED) {
    return res.status(503).json({ error: "پرداخت کارت‌به‌کارت هنوز برای این سایت فعال نشده است." });
  }
  const customerContact = typeof req.body?.customer_contact === "string"
    ? req.body.customer_contact.trim()
    : "";
  const trackingCode = typeof req.body?.tracking_code === "string"
    ? req.body.tracking_code.trim()
    : "";
  if (customerContact.length < 3 || customerContact.length > 120) {
    return res.status(400).json({ error: "راه تماس را بین ۳ تا ۱۲۰ نویسه وارد کن." });
  }
  if (trackingCode.length < 4 || trackingCode.length > 120) {
    return res.status(400).json({ error: "کد پیگیری انتقال را بین ۴ تا ۱۲۰ نویسه وارد کن." });
  }

  const orderId = crypto.randomUUID();
  await db.query("INSERT INTO public.orders (id, user_id, product_name, amount, customer_contact, tracking_code, status) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [orderId, req.account.user_id, "بستهٔ ۱۰ توکن", PRICE_TOMANS, customerContact, trackingCode, "pending"]);
  res.status(201).json({
    orderId,
    status: "pending",
    message: "سفارش ثبت شد و در انتظار بررسی دستی است؛ هنوز توکنی به حسابت اضافه نشده است."
  });
});

app.post("/api/payments/create", requireSession, async (req, res) => {
  if (!PAYMENTS_ENABLED) {
    return res.status(503).json({ error: "پرداخت هنوز فعال نشده است. مدیر سایت باید شناسه پذیرنده را تنظیم کند." });
  }
  const orderId = crypto.randomUUID();
  const createdAt = now();
  await db.query(`INSERT INTO payments (order_id, user_id, amount_rials, token_amount, status, created_at)
    VALUES ($1, $2, $3, $4, 'pending', $5)`,
  [orderId, req.account.user_id, PRICE_RIALS, TOKENS_PER_PURCHASE, createdAt]);

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
    await db.query("UPDATE payments SET authority = $1 WHERE order_id = $2", [authority, orderId]);
    const redirectUrl = await zarinpal.payments.getRedirectUrl(authority);
    res.json({ redirectUrl });
  } catch (error) {
    await db.query("UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'pending'", [orderId]);
    console.error("ZarinPal request failed:", error.message);
    res.status(502).json({ error: "اتصال به زرین‌پال انجام نشد. چند دقیقه دیگر دوباره تلاش کن." });
  }
});

app.get("/api/payments/callback", async (req, res) => {
  const status = typeof req.query.Status === "string" ? req.query.Status : "";
  const authority = typeof req.query.Authority === "string" ? req.query.Authority : "";
  if (!authority || authority.length > 128) return res.redirect(303, "/?payment=failed");
  const orderResult = await db.query("SELECT * FROM payments WHERE authority = $1", [authority]);
  const order = orderResult.rows[0];
  if (!order) return res.redirect(303, "/?payment=failed");
  if (order.status === "paid") return res.redirect(303, "/?payment=success");
  if (status !== "OK" || order.status !== "pending") {
    await db.query("UPDATE payments SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [order.id]);
    return res.redirect(303, "/?payment=cancelled");
  }

  try {
    const zarinpal = makeZarinPal();
    const verification = await zarinpal.verifications.verify({
      amount: Number(order.amount_rials),
      authority
    });
    const data = verification?.data;
    const code = Number(data?.code);
    if (code !== 100 && code !== 101) {
      await db.query("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [order.id]);
      return res.redirect(303, "/?payment=failed");
    }

    const refId = data?.ref_id == null ? null : String(data.ref_id);
    await withTransaction(async (client) => {
      const pendingOrder = await client.query("SELECT status FROM payments WHERE id = $1 FOR UPDATE", [order.id]);
      if (pendingOrder.rows[0]?.status !== "pending") return;
      await client.query("UPDATE payments SET status = 'paid', ref_id = $1, verified_at = $2 WHERE id = $3",
        [refId, now(), order.id]);
      await client.query("UPDATE users SET token_balance = token_balance + $1 WHERE id = $2",
        [Number(order.token_amount), order.user_id]);
    });
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
      paymentSandbox: PAYMENT_SANDBOX,
      cardTransferEnabled: CARD_TRANSFER_ENABLED,
      cardTransferCardNumber: CARD_TRANSFER_ENABLED ? CARD_TRANSFER_CARD_NUMBER : "",
      cardTransferCardHolder: CARD_TRANSFER_ENABLED ? CARD_TRANSFER_CARD_HOLDER : ""
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

await initializeDatabase();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BlokCode server is running at ${APP_URL}`);
  console.log(`Payments: ${PAYMENTS_ENABLED ? (PAYMENT_SANDBOX ? "sandbox" : "live") : "disabled"}`);
  console.log(`Email: ${MAIL_MODE}`);
});
