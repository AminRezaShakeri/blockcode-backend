(() => {
  "use strict";

  const CONFIG = window.BLOKCODE_CONFIG || { demoMode: true, cardTransferEnabled: false };
  const I18N = window.BLOKCODE_I18N || { text: {}, commands: [], secrets: {}, messages: {} };
  const DEMO_MODE = CONFIG.demoMode !== false;
  const CARD_TRANSFER_ENABLED = CONFIG.cardTransferEnabled === true;
  const STORAGE_KEY = "blokcode-demo-v1";
  const LANGUAGE_STORAGE_KEY = "blokcode-language-v1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  function readLanguage() {
    try { return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "fa"; }
    catch (_) { return "fa"; }
  }
  let currentLanguage = readLanguage();
  function t(key, values = {}) {
    const entry = I18N.text?.[key];
    let value = entry?.[currentLanguage] || entry?.fa || key;
    return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  }
  function localizedMessage(message) {
    if (currentLanguage !== "en" || typeof message !== "string") return message;
    const entries = Object.entries(I18N.text || {})
      .filter(([, entry]) => entry?.fa && entry?.en)
      .map(([, entry]) => [entry.fa, entry.en]);
    entries.push(...Object.entries(I18N.messages || {}));
    for (const [fa, en] of entries) {
      const names = [];
      const marked = fa.replace(/\{(\w+)\}/g, (_, name) => {
        names.push(name);
        return `__BLOCKCODE_${names.length - 1}__`;
      });
      const source = marked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/__BLOCKCODE_\d+__/g, "(.+?)");
      const match = message.match(new RegExp("^" + source + "$"));
      if (match) {
        const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
        return en.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
      }
    }
    return message;
  }
  function applyCommandTranslation(card, key) {
    const index = Number(key.split(".")[1]) - 1;
    const entry = I18N.commands?.[index];
    if (!entry) return;
    const english = currentLanguage === "en";
    const top = $(".card-top", card);
    const category = top && Array.from(top.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (category) category.textContent = ` ${entry[english ? 1 : 0]} `;
    $("h3", card).textContent = entry[english ? 3 : 2];
    $("p", card).textContent = entry[english ? 5 : 4];
    const foot = $(".card-foot", card);
    const player = foot.querySelector("bdi");
    foot.textContent = entry[english ? 7 : 6];
    if (player) foot.append(" ", player);
    if (index === 22) $("code", card).textContent = english ? "/say Hello, world!" : "/say سلام دنیا!";
    $(".copy-button", card).setAttribute("aria-label", t("command.copy"));
  }
  function applySecretTranslation(card, id) {
    const entry = I18N.secrets?.[id];
    if (!entry) return;
    const english = currentLanguage === "en";
    const order = Array.from(card.parentElement.querySelectorAll(".secret-card")).indexOf(card) + 1;
    const meta = $(".secret-meta", card);
    const numberNode = Array.from(meta.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (numberNode) numberNode.textContent = ` ${t("secret.number", { number: new Intl.NumberFormat(english ? "en-US" : "fa-IR", { minimumIntegerDigits: 2, useGrouping: false }).format(order) })} `;
    $("h3", card).textContent = entry[english ? 1 : 0];
    $("p", card).textContent = entry[english ? 3 : 2];
    $(".lock-label", card).textContent = `${new Intl.NumberFormat(english ? "en-US" : "fa-IR").format(10)} ◆`;
    const unlocked = card.classList.contains("unlocked");
    $(".unlock-button", card).textContent = unlocked ? t("secret.unlocked") : t("secret.lock");
    $(".copy-button", card).setAttribute("aria-label", t("command.copy"));
  }
  function applyStaticTranslations() {
    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = currentLanguage === "fa" ? "rtl" : "ltr";
    document.title = t("page.title");
    const description = $('meta[name="description"]');
    if (description) description.content = t("page.description");
    $$('[data-i18n]').forEach((element) => {
      const key = element.dataset.i18n;
      if (key.startsWith("command.")) return applyCommandTranslation(element, key);
      if (key.startsWith("secret.")) return applySecretTranslation(element, key.slice("secret.".length));
      if (I18N.text?.[key]) element.textContent = t(key);
    });
    $$('[data-i18n-placeholder]').forEach((element) => {
      const key = element.dataset.i18nPlaceholder;
      if (I18N.text?.[key]) element.setAttribute("placeholder", t(key));
    });
    $$('[data-i18n-aria]').forEach((element) => {
      const key = element.dataset.i18nAria;
      if (!I18N.text?.[key]) return;
      element.setAttribute(element.tagName === "IMG" ? "alt" : "aria-label", t(key));
    });
    $$('[data-set-language]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.setLanguage === currentLanguage)));
  }
  function setLanguage(language, persist = true) {
    currentLanguage = language === "en" ? "en" : "fa";
    if (persist) {
      try { localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage); } catch (_) { /* Language still changes for this page. */ }
    }
    applyStaticTranslations();
    updateEnvironmentText();
    setAuthMode(authMode);
    render();
  }
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
    return new Intl.NumberFormat(currentLanguage === "fa" ? "fa-IR" : "en-US").format(value);
  }

  function showToast(message) {
    toast.textContent = localizedMessage(message);
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
      const error = new Error(localizedMessage(payload.error) || t("errors.server"));
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
      $("#authKicker").textContent = t("auth.demo.kicker");
      $("#accountTitle").textContent = t("auth.demo.title");
      $("#authDescription").textContent = t("auth.demo.description");
      $("#authSubmitButton").textContent = t("auth.demo.submit");
      $("#authFootnote").textContent = t("auth.demo.footnote");
    } else if (isLogin) {
      $("#authKicker").textContent = t("auth.login.kicker");
      $("#accountTitle").textContent = t("auth.login.title");
      $("#authDescription").textContent = t("auth.login.description");
      $("#authSubmitButton").textContent = t("auth.login.submit");
      $("#authFootnote").textContent = t("auth.login.footnote");
      toggle.textContent = t("auth.login.toggle");
    } else {
      $("#authKicker").textContent = t("auth.signup.kicker");
      $("#accountTitle").textContent = t("auth.signup.title");
      $("#authDescription").textContent = t("auth.signup.description");
      $("#authSubmitButton").textContent = t("auth.signup.submit");
      $("#authFootnote").textContent = t("auth.signup.footnote");
      toggle.textContent = t("auth.signup.toggle");
    }
  }

  function updateEnvironmentText() {
    $("#siteModeLabel").textContent = t(DEMO_MODE ? "site.mode.demo" : "site.mode.server");
    $("#siteModeBadge").textContent = t(DEMO_MODE ? "site.badge.demo" : "site.badge.server");
    $("#walletNote").textContent = t(DEMO_MODE ? "wallet.demo" : "wallet.server");
    $("#buyButton").disabled = !DEMO_MODE && !CARD_TRANSFER_ENABLED;
    $("#paymentNote").textContent = DEMO_MODE
      ? t("payment.demo")
      : CARD_TRANSFER_ENABLED
        ? t("payment.card")
        : t("payment.disabled");
    $("#demoPurchaseButton").hidden = !DEMO_MODE;
    $("#purchaseDescription").textContent = t("demo.purchase.description");
    $("#purchaseTitle").textContent = t("demo.purchase.title");
    $("#purchaseFootnote").textContent = t("demo.purchase.footnote");
    $("#buyButton").querySelector("strong").textContent = t("price");
    $("#purchaseDialog .purchase-summary strong").textContent = t("price");
  }
  function render() {
    const balance = numberFa(state.tokens);
    $("#headerTokenCount").textContent = balance;
    $("#dashboardTokenCount").textContent = balance;
    $("#dialogTokenCount").textContent = balance;
    $("#accountButtonLabel").textContent = state.profile ? state.profile.name : t("account.signin");
    $("#signupView").hidden = Boolean(state.profile);
    $("#profileView").hidden = !state.profile;
    if (state.profile) {
      $("#profileGreeting").textContent = t("profile.hello", { name: state.profile.name });
      $("#profileKicker").textContent = t(DEMO_MODE ? "demo.profile" : "server.profile");
      $("#profileDescription").textContent = DEMO_MODE
        ? t("profile.demo.description")
        : state.profile.email;
      $("#logoutButton").textContent = t(DEMO_MODE ? "demo.logout" : "server.logout");
    }

    const progress = Math.min(state.tokens, 10);
    $("#tokenProgress").style.width = `${progress * 10}%`;
    $("#progressLabel").textContent = t("club.progress.label", { count: numberFa(progress) });

    const claimedToday = state.lastClaimDate === tehranDateKey();
    $("#dailyButton").disabled = claimedToday;
    $("#dailyButtonLabel").textContent = t(claimedToday ? "daily.claimed" : "daily.claim");

    $$(".secret-card").forEach((card) => {
      const unlocked = state.unlocked.includes(card.dataset.secret);
      card.classList.toggle("unlocked", unlocked);
      $(".secret-copy", card).hidden = !unlocked;
      $(".lock-label", card).hidden = unlocked;
      const button = $(".unlock-button", card);
      button.textContent = t(unlocked ? "secret.unlocked" : "secret.lock");
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
          link.textContent = t("auth.devlink");
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
        link.textContent = t("auth.devlink");
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
      result.textContent = localizedMessage("سفارش ثبت شد. شناسه‌ی سفارش: " + payload.orderId + ". پس از بررسی رسید، نتیجه اعلام می‌شود؛ هنوز توکنی اضافه نشده است.");
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

  applyStaticTranslations();
  $$('[data-set-language]').forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.setLanguage)));
  window.addEventListener("storage", (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY) setLanguage(event.newValue === "en" ? "en" : "fa", false);
  });
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
