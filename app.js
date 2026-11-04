(() => {
  "use strict";

  const CONFIG = window.BLOKCODE_CONFIG || { demoMode: true, cardTransferEnabled: false };
  const DEMO_MODE = CONFIG.demoMode !== false;
  const CARD_TRANSFER_ENABLED = CONFIG.cardTransferEnabled === true;
  const STORAGE_KEY = "blokcode-demo-v1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const SECRET_CARDS = $$(".secret-card[data-secret]");
  const SECRET_IDS = new Set(SECRET_CARDS.map((card) => card.dataset.secret).filter(Boolean));
  const accountDialog = $("#accountDialog");
  const purchaseDialog = $("#purchaseDialog");
  const cardTransferDialog = $("#cardTransferDialog");
  const toast = $("#toast");
  let state = DEMO_MODE ? readDemoState() : emptyState();
  let toastTimer;
  let authMode = "signup";

  function emptyState() {
    return { profile: null, tokens: 0, lastClaimDate: null, unlocked: [] };
  }

  function readDemoState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return emptyState();
      return {
        profile: saved.profile && typeof saved.profile.name === "string" ? saved.profile : null,
        tokens: Number.isFinite(Number(saved.tokens)) ? Math.max(0, Number(saved.tokens)) : 0,
        lastClaimDate: typeof saved.lastClaimDate === "string" ? saved.lastClaimDate : null,
        unlocked: Array.isArray(saved.unlocked)
          ? Array.from(new Set(saved.unlocked.filter((id) => SECRET_IDS.has(id))))
          : []
      };
    } catch (_) {
      return emptyState();
    }
  }

  function syncDemoState() {
    if (DEMO_MODE) state = readDemoState();
  }

  function saveDemoState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      showToast("مرورگر اجازه‌ی ذخیره‌ی نمونه را نداد.");
    }
  }

  function tehranDateKey() {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function numberFa(value) {
    return new Intl.NumberFormat("fa-IR").format(value);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  async function api(url, options = {}) {
    const request = {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    };
    const response = await fetch(url, request);
    let payload = {};
    try { payload = await response.json(); } catch (_) { /* Error below uses a safe default. */ }
    if (!response.ok) {
      const error = new Error(payload.error || "ارتباط با سرور انجام نشد.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function applyServerState(payload) {
    if (!payload?.authenticated) {
      state = emptyState();
      render();
      return;
    }
    state = {
      profile: { name: payload.account.name, email: payload.account.email },
      tokens: Math.max(0, Number(payload.tokens) || 0),
      lastClaimDate: typeof payload.lastClaimDate === "string" ? payload.lastClaimDate : null,
      unlocked: Array.isArray(payload.unlocked)
        ? Array.from(new Set(payload.unlocked.filter((id) => SECRET_IDS.has(id))))
        : []
    };
    render();
  }

  async function refreshServerState(showError = false) {
    if (DEMO_MODE) return;
    try {
      applyServerState(await api("/api/me"));
    } catch (error) {
      if (showError) showToast(error.message);
    }
  }

  function setAuthMode(mode) {
    authMode = DEMO_MODE ? "signup" : mode;
    const isLogin = authMode === "login";
    const nicknameField = $("#nicknameField");
    const emailField = $("#emailField");
    const passwordField = $("#passwordField");
    const toggle = $("#authModeToggle");
    const resendButton = $("#resendVerificationButton");
    const verificationLink = $("#devVerificationLink");

    nicknameField.hidden = DEMO_MODE || isLogin;
    emailField.hidden = DEMO_MODE;
    passwordField.hidden = DEMO_MODE;
    $("#nicknameInput").required = !DEMO_MODE && !isLogin;
    $("#emailInput").required = !DEMO_MODE;
    $("#passwordInput").required = !DEMO_MODE;
    $("#passwordInput").autocomplete = isLogin ? "current-password" : "new-password";
    toggle.hidden = DEMO_MODE;
    resendButton.hidden = DEMO_MODE || !isLogin;
    verificationLink.hidden = true;

    if (DEMO_MODE) {
      $("#authKicker").textContent = "حساب آزمایشی";
      $("#accountTitle").textContent = "حساب آزمایشی بساز";
      $("#authDescription").textContent = "یک نام نمایشی وارد کن؛ حساب و موجودی فقط روی همین مرورگر ذخیره می‌شود.";
      $("#authSubmitButton").textContent = "ساخت حساب آزمایشی ←";
      $("#authFootnote").textContent = "در نسخه‌ی نمایشی، ایمیل یا رمز عبور از تو نمی‌خواهیم.";
    } else if (isLogin) {
      $("#authKicker").textContent = "خوش برگشتی";
      $("#accountTitle").textContent = "ورود به حساب";
      $("#authDescription").textContent = "با ایمیل تأییدشده و رمز عبورت وارد شو.";
      $("#authSubmitButton").textContent = "ورود ←";
      $("#authFootnote").textContent = "اگر هنوز ایمیلت را تأیید نکرده‌ای، پیوند داخل ایمیل را باز کن.";
      toggle.textContent = "حساب نداری؟ ثبت‌نام کن";
    } else {
      $("#authKicker").textContent = "خوش اومدی به دنیای کدها";
      $("#accountTitle").textContent = "ساخت حساب";
      $("#authDescription").textContent = "ایمیلت را تأیید کن تا موجودی توکن و رازهای بازشده به حسابت وصل شوند.";
      $("#authSubmitButton").textContent = "ساخت حساب و فرستادن پیوند تأیید ←";
      $("#authFootnote").textContent = "رمز عبور با هش امن ذخیره می‌شود؛ اطلاعات کارت بانکی را در فرم سایت وارد نکن.";
      toggle.textContent = "حساب داری؟ وارد شو";
    }
  }

  function updateEnvironmentText() {
    $("#siteModeLabel").textContent = DEMO_MODE ? "نسخه‌ی نمایشی بلوک‌کُد" : "باشگاه فرمان‌های بلوک‌کُد";
    $("#siteModeBadge").textContent = DEMO_MODE ? "آزمایشی" : "حساب سروری";
    $("#walletNote").textContent = DEMO_MODE
      ? "ⓘ  در نسخه‌ی نمایشی، حساب و موجودی فقط روی همین مرورگر ذخیره می‌شود."
      : "ⓘ  موجودی و رازهای بازشده در حساب سرور ذخیره می‌شوند.";
    $("#buyButton").disabled = !DEMO_MODE && !CARD_TRANSFER_ENABLED;
    $("#paymentNote").textContent = DEMO_MODE
      ? "▣  خرید بالا فقط نمایشی است؛ پولی دریافت نمی‌شود."
      : CARD_TRANSFER_ENABLED
        ? "▣  پرداخت با کارت‌به‌کارت انجام می‌شود؛ سفارش پس از بررسی دستی تأیید خواهد شد."
        : "▣  کارت‌به‌کارت هنوز توسط مدیر سایت فعال نشده است.";
    $("#demoPurchaseButton").hidden = !DEMO_MODE;
    $("#purchaseDescription").textContent = "این نسخه خرید را فقط شبیه‌سازی می‌کند؛ هیچ پولی دریافت نمی‌شود.";
    $("#purchaseTitle").textContent = "۱۰ توکن آزمایشی";
    $("#purchaseFootnote").textContent = "این دکمه فقط برای آزمایش نمونه‌کار است.";
  }
  function render() {
    const balance = numberFa(state.tokens);
    $("#headerTokenCount").textContent = balance;
    $("#dashboardTokenCount").textContent = balance;
    $("#dialogTokenCount").textContent = balance;
    $("#accountButtonLabel").textContent = state.profile ? state.profile.name : "ورود / ثبت‌نام";
    $("#signupView").hidden = Boolean(state.profile);
    $("#profileView").hidden = !state.profile;
    if (state.profile) {
      $("#profileGreeting").textContent = `سلام، ${state.profile.name}!`;
      $("#profileKicker").textContent = DEMO_MODE ? "حساب روی این دستگاه" : "حساب تأییدشده";
      $("#profileDescription").textContent = DEMO_MODE
        ? "موجودی آزمایشی تو روی همین مرورگر نگهداری می‌شود."
        : state.profile.email;
      $("#logoutButton").textContent = DEMO_MODE ? "خروج از حساب آزمایشی" : "خروج از حساب";
    }

    const progress = Math.min(state.tokens, 10);
    $("#tokenProgress").style.width = `${progress * 10}%`;
    $("#progressLabel").textContent = `${numberFa(progress)} از ۱۰`;

    const claimedToday = state.lastClaimDate === tehranDateKey();
    $("#dailyButton").disabled = claimedToday;
    $("#dailyButtonLabel").textContent = claimedToday ? "توکن امروز گرفته شد" : "گرفتن توکن امروز";

    $$(".secret-card").forEach((card) => {
      const unlocked = state.unlocked.includes(card.dataset.secret);
      card.classList.toggle("unlocked", unlocked);
      $(".secret-copy", card).hidden = !unlocked;
      $(".lock-label", card).hidden = unlocked;
      const button = $(".unlock-button", card);
      button.textContent = unlocked ? "راز باز شده — فرمان را کپی کن" : "بازکردن راز با ۱۰ توکن";
      button.disabled = unlocked;
    });

    const commandCards = $$(".command-card");
    $$('[data-filter-count]').forEach((badge) => {
      const filter = badge.dataset.filterCount;
      const count = filter === "all"
        ? commandCards.length
        : commandCards.filter((card) => card.dataset.category === filter).length;
      badge.textContent = numberFa(count);
    });
  }

  function openAccountDialog() {
    if (DEMO_MODE) syncDemoState();
    render();
    if (!state.profile) setAuthMode(authMode);
    openDialog(accountDialog);
    if (!DEMO_MODE) refreshServerState();
  }

  function registerDemo(name) {
    state.profile = { name: name.trim() };
    saveDemoState();
    closeDialog(accountDialog);
    render();
    showToast(`حساب آزمایشی ساخته شد. خوش اومدی ${state.profile.name}!`);
  }

  async function submitAuthentication(event) {
    event.preventDefault();
    if (DEMO_MODE) {
      const name = $("#nicknameInput").value.trim();
      if (name.length < 2) return showToast("اسم بازیکن باید دست‌کم دو حرف داشته باشد.");
      registerDemo(name);
      return;
    }

    const email = $("#emailInput").value.trim();
    const password = $("#passwordInput").value;
    const body = authMode === "login"
      ? { email, password }
      : { name: $("#nicknameInput").value.trim(), email, password };
    $("#authSubmitButton").disabled = true;
    try {
      const payload = await api(authMode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body
      });
      if (authMode === "login") {
        applyServerState(payload);
        closeDialog(accountDialog);
        showToast("وارد حسابت شدی.");
      } else {
        const link = $("#devVerificationLink");
        if (payload.developmentVerificationUrl) {
          link.href = payload.developmentVerificationUrl;
          link.textContent = "حالت توسعه: برای فعال‌کردن حساب اینجا بزن";
          link.hidden = false;
        }
        showToast(payload.message);
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      $("#authSubmitButton").disabled = false;
    }
  }

  async function claimDailyToken() {
    if (!state.profile) {
      showToast(DEMO_MODE ? "برای گرفتن توکن، اول حساب آزمایشی بساز." : "برای گرفتن توکن، اول وارد حسابت شو.");
      openAccountDialog();
      return;
    }
    if (state.lastClaimDate === tehranDateKey()) {
      showToast("توکن امروزت را قبلاً گرفتی؛ فردا دوباره سر بزن.");
      return;
    }
    const button = $("#dailyButton");
    button.disabled = true;
    if (DEMO_MODE) {
      state.tokens += 1;
      state.lastClaimDate = tehranDateKey();
      saveDemoState();
      render();
      showToast("یک توکن تازه به کیف اضافه شد!");
      return;
    }
    try {
      const payload = await api("/api/tokens/daily", { method: "POST", body: {} });
      applyServerState(payload);
      showToast(payload.message);
    } catch (error) {
      await refreshServerState();
      showToast(error.message);
    } finally {
      button.disabled = false;
      render();
    }
  }

  async function unlockSecret(id) {
    if (!SECRET_IDS.has(id)) return showToast("این راز در فهرست سایت پیدا نشد.");
    if (!state.profile) {
      showToast(DEMO_MODE ? "برای بازکردن راز، اول حساب آزمایشی بساز." : "برای بازکردن راز، اول وارد حسابت شو.");
      openAccountDialog();
      return;
    }
    if (state.unlocked.includes(id)) return showToast("این راز از قبل برایت باز شده است.");
    if (state.tokens < 10) return showToast("برای این راز به ۱۰ توکن نیاز داری.");

    const button = $(`.secret-card[data-secret="${CSS.escape(id)}"] .unlock-button`);
    if (button) button.disabled = true;
    if (DEMO_MODE) {
      state.tokens -= 10;
      state.unlocked.push(id);
      saveDemoState();
      render();
      showToast("راز باز شد؛ فرمان را کپی کن!");
      return;
    }
    try {
      const payload = await api(`/api/secrets/${encodeURIComponent(id)}/unlock`, { method: "POST", body: {} });
      applyServerState(payload);
      showToast(payload.message);
    } catch (error) {
      await refreshServerState();
      showToast(error.message);
    } finally {
      render();
    }
  }

  async function copyCommand(command, button) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(command);
        showToast(`فرمان کپی شد: ${command}`);
        return;
      } catch (_) { /* Select the visible command when clipboard access is unavailable. */ }
    }
    const card = button.closest(".command-card, .secret-card");
    const code = card?.querySelector("code");
    if (!code || typeof window.getSelection !== "function" || typeof document.createRange !== "function") {
      showToast("کپی خودکار در دسترس نیست؛ فرمان را دستی انتخاب کن.");
      return;
    }
    const selection = window.getSelection();
    if (!selection) return showToast("فرمان را دستی انتخاب کن.");
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    showToast("فرمان انتخاب شد؛ با Ctrl+C یا گزینه‌ی کپی آن را بردار.");
  }

  async function logout() {
    if (DEMO_MODE) {
      syncDemoState();
      state.profile = null;
      saveDemoState();
      closeDialog(accountDialog);
      render();
      showToast("از حساب آزمایشی خارج شدی.");
      return;
    }
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
      state = emptyState();
      closeDialog(accountDialog);
      render();
      showToast("از حسابت خارج شدی.");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function resendVerification() {
    const email = $("#emailInput").value.trim();
    if (!email) return showToast("اول ایمیلت را وارد کن.");
    try {
      const payload = await api("/api/auth/resend-verification", {
        method: "POST",
        body: { email }
      });
      const link = $("#devVerificationLink");
      if (payload.developmentVerificationUrl) {
        link.href = payload.developmentVerificationUrl;
        link.textContent = "حالت توسعه: برای فعال‌کردن حساب اینجا بزن";
        link.hidden = false;
      }
      showToast(payload.message);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function startPurchase() {
    if (!state.profile) {
      closeDialog(purchaseDialog);
      showToast("برای خرید اول وارد حسابت شو.");
      openAccountDialog();
      return;
    }
    if (!DEMO_MODE) return showToast("خرید آزمایشی فقط در نسخه‌ی نمایشی در دسترس است.");
    state.tokens += 10;
    saveDemoState();
    closeDialog(purchaseDialog);
    render();
    showToast("۱۰ توکن تستی اضافه شد؛ پولی دریافت نشد.");
  }

  function formatCardNumber(value) {
    return String(value || "").replace(/\D/g, "").replace(/(.{4})/g, "$1 ").trim();
  }

  function openCardTransferDialog() {
    if (!state.profile) {
      closeDialog(purchaseDialog);
      showToast("برای خرید اول وارد حسابت شو.");
      openAccountDialog();
      return;
    }
    if (!CARD_TRANSFER_ENABLED || !CONFIG.cardTransferCardNumber) {
      showToast("پرداخت کارت‌به‌کارت هنوز فعال نشده است.");
      return;
    }
    $("#cardTransferCardNumber").textContent = formatCardNumber(CONFIG.cardTransferCardNumber);
    const holder = String(CONFIG.cardTransferCardHolder || "").trim();
    $("#cardTransferCardHolder").textContent = holder;
    $("#cardTransferHolderRow").hidden = !holder;
    $("#cardTransferForm").reset();
    $("#cardTransferForm").hidden = false;
    $("#cardTransferResult").hidden = true;
    closeDialog(purchaseDialog);
    openDialog(cardTransferDialog);
  }

  async function submitCardTransferOrder(event) {
    event.preventDefault();
    if (!state.profile) {
      closeDialog(cardTransferDialog);
      showToast("برای ثبت سفارش اول وارد حسابت شو.");
      openAccountDialog();
      return;
    }
    const form = $("#cardTransferForm");
    const button = $("#submitCardTransferButton");
    button.disabled = true;
    try {
      const formData = new FormData(form);
      const payload = await api("/api/payments/card-transfer", {
        method: "POST",
        body: {
          customer_contact: String(formData.get("customer_contact") || "").trim(),
          payment_reference: String(formData.get("payment_reference") || "").trim()
        }
      });
      if (!payload.orderId) throw new Error("شناسه‌ی سفارش از سرور دریافت نشد.");
      form.reset();
      form.hidden = true;
      const result = $("#cardTransferResult");
      result.textContent = "سفارش ثبت شد. شناسه‌ی سفارش: " + payload.orderId + ". پس از بررسی رسید، نتیجه اعلام می‌شود؛ هنوز توکنی اضافه نشده است.";
      result.hidden = false;
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function handleReturnMessage() {
    const params = new URLSearchParams(window.location.search);
    const verified = params.get("verified");
    if (!verified) return;
    if (verified === "1") {
      setAuthMode("login");
      openAccountDialog();
      showToast("ایمیلت تأیید شد؛ حالا وارد حسابت شو.");
    } else if (verified === "invalid") {
      showToast("پیوند تأیید معتبر نیست یا مهلتش تمام شده است.");
    }
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }

  updateEnvironmentText();
  setAuthMode("signup");
  $("#signupForm").addEventListener("submit", submitAuthentication);
  $("#authModeToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
  $("#resendVerificationButton").addEventListener("click", resendVerification);
  $("#accountButton").addEventListener("click", openAccountDialog);
  $$('[data-open-account]').forEach((button) => button.addEventListener("click", openAccountDialog));
  $("#dailyButton").addEventListener("click", claimDailyToken);
  $("#logoutButton").addEventListener("click", logout);
  $("#buyButton").addEventListener("click", () => {
    if (!DEMO_MODE && !CARD_TRANSFER_ENABLED) return showToast("پرداخت کارت‌به‌کارت هنوز فعال نشده است.");
    if (!state.profile) {
      showToast("برای خرید اول وارد حسابت شو.");
      openAccountDialog();
      return;
    }
    if (DEMO_MODE) openDialog(purchaseDialog);
    else openCardTransferDialog();
  });
  $("#demoPurchaseButton").addEventListener("click", startPurchase);
  $("#copyCardNumberButton").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(String(CONFIG.cardTransferCardNumber || "").replace(/\D/g, ""));
      showToast("شماره کارت کپی شد.");
    } catch (_) {
      showToast("کپی خودکار در این مرورگر در دسترس نیست؛ شماره کارت را دستی انتخاب کن.");
    }
  });
  $("#cardTransferForm").addEventListener("submit", submitCardTransferOrder);

  $$(".unlock-button").forEach((button) => button.addEventListener("click", () => {
    const card = button.closest(".secret-card[data-secret]");
    if (card) unlockSecret(card.dataset.secret);
  }));
  $$(".copy-button").forEach((button) => button.addEventListener("click", () => {
    const card = button.closest(".command-card, .secret-card");
    const code = card?.querySelector("code");
    if (code) copyCommand(code.textContent.trim(), button);
  }));
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
  [accountDialog, purchaseDialog, cardTransferDialog].forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  }));

  if (DEMO_MODE) {
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        syncDemoState();
        render();
      }
    });
  }
  window.addEventListener("focus", () => {
    if (DEMO_MODE) {
      syncDemoState();
      render();
    } else refreshServerState();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !DEMO_MODE) refreshServerState();
  });

  $$(".filter").forEach((button) => button.addEventListener("click", () => {
    $$(".filter").forEach((item) => item.classList.toggle("active", item === button));
    const filter = button.dataset.filter;
    $$(".command-card").forEach((card) => {
      card.hidden = filter !== "all" && card.dataset.category !== filter;
    });
  }));

  const menuButton = $("#menuButton");
  const mainNav = $("#mainNav");
  menuButton.addEventListener("click", () => {
    const expanded = mainNav.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(expanded));
  });
  $$("#mainNav a").forEach((link) => link.addEventListener("click", () => {
    mainNav.classList.remove("open");
    menuButton.setAttribute("aria-expanded", "false");
  }));

  render();
  if (!DEMO_MODE) refreshServerState();
  handleReturnMessage();
})();
