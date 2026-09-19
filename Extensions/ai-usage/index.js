"use strict";

const LOW_THRESHOLD = 25;
const VERY_LOW_THRESHOLD = 10;

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
// 余额变动很慢，5 分钟拉一次足够，避免打爆 API。
const DEEPSEEK_REFRESH_MS = 5 * 60 * 1000;
const DEEPSEEK_STALE_MS = 5 * 60 * 1000;
// 失败后 60 秒内不重试，防止「渲染时补拉」退化成重试风暴。
const DEEPSEEK_ERROR_BACKOFF_MS = 60 * 1000;
const DEEPSEEK_DEFAULT_BUDGET = 100;
const DEEPSEEK_SETTING_SHOW = "showDeepSeek";
const DEEPSEEK_SETTING_API_KEY = "deepseekApiKey";
const DEEPSEEK_SETTING_BUDGET = "deepseekBudget";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function colorForRemaining(remainingPercent) {
  if (remainingPercent <= VERY_LOW_THRESHOLD) return "red";
  if (remainingPercent <= LOW_THRESHOLD) return "orange";
  return "green";
}

function formatPercent(value) {
  return `${Math.round(clamp(value, 0, 100))}%`;
}

function percentLabel(value) {
  if (value === null || value === undefined) return "--%";
  return `${Math.round(clamp(value, 0, 100))}%`;
}

function sourceLabel(source) {
  switch (source) {
    case "oauth-api":
      return "OAuth API";
    case "local-summary":
      return "本地摘要";
    case "auth-token":
      return "认证令牌";
    case "stats-cache":
      return "统计缓存";
    case "unavailable":
      return "不可用";
    default:
      return null;
  }
}

function withSource(detail, source) {
  const sourceText = sourceLabel(source);
  if (!sourceText) return detail;
  return detail ? `${detail} | ${sourceText}` : sourceText;
}

function pickCodexWindow(codex) {
  const primary = asObject(codex.primary);
  const secondary = asObject(codex.secondary);

  if (!primary && !secondary) return null;
  if (primary && !secondary) return primary;
  if (!primary && secondary) return secondary;

  const primaryRemaining = toNumber(primary.remainingPercent, 101);
  const secondaryRemaining = toNumber(secondary.remainingPercent, 101);
  return primaryRemaining <= secondaryRemaining ? primary : secondary;
}

function codexRemainingPercent(codexWindow) {
  if (!codexWindow) return null;

  const remaining = toNumber(codexWindow.remainingPercent, null);
  if (remaining !== null) return clamp(remaining, 0, 100);

  const used = toNumber(codexWindow.usedPercent, null);
  if (used !== null) return clamp(100 - used, 0, 100);

  return null;
}

function codexUsageStats(codex) {
  const windows = [];
  const primary = asObject(codex.primary);
  const secondary = asObject(codex.secondary);

  [primary, secondary].forEach((window) => {
    if (!window) return;
    const remainingPercent = codexRemainingPercent(window);
    if (remainingPercent === null) return;
    windows.push({
      remainingPercent,
      windowMinutes: toNumber(window.windowMinutes, 0)
    });
  });

  if (windows.length === 0) {
    return { weeklyRemaining: null, sessionRemaining: null };
  }

  windows.sort((a, b) => a.windowMinutes - b.windowMinutes);
  const session = windows[0];
  const weekly = windows[windows.length - 1];

  return {
    weeklyRemaining: weekly ? Math.round(clamp(weekly.remainingPercent, 0, 100)) : null,
    sessionRemaining: session ? Math.round(clamp(session.remainingPercent, 0, 100)) : null
  };
}

function codexModel(usage) {
  const codex = asObject(usage && usage.codex);
  const source = codex && typeof codex.source === "string" ? codex.source : null;
  if (!codex || codex.available !== true) {
    return {
      title: "Codex",
      text: "--",
      remaining: 0,
      progress: 0,
      color: "gray",
      weeklyRemaining: null,
      sessionRemaining: null,
      detail: withSource("不可用", source)
    };
  }

  if (codex.unlimited === true) {
    return {
      title: "Codex",
      text: "∞",
      remaining: 100,
      progress: 1,
      color: "green",
      weeklyRemaining: 100,
      sessionRemaining: 100,
      detail: withSource("无限", source)
    };
  }

  const window = pickCodexWindow(codex);
  const remaining = codexRemainingPercent(window);
  const usageStats = codexUsageStats(codex);

  if (remaining === null) {
    return {
      title: "Codex",
      text: "--",
      remaining: 0,
      progress: 0,
      color: "gray",
      weeklyRemaining: usageStats.weeklyRemaining,
      sessionRemaining: usageStats.sessionRemaining,
      detail: withSource("无窗口数据", source)
    };
  }

  return {
    title: "Codex",
    text: formatPercent(remaining),
    remaining,
    progress: remaining / 100,
    color: colorForRemaining(remaining),
    weeklyRemaining: usageStats.weeklyRemaining,
    sessionRemaining: usageStats.sessionRemaining,
    detail: withSource(window && window.windowLabel ? window.windowLabel : "用量窗口", source)
  };
}

function claudeModel(usage) {
  const claude = asObject(usage && usage.claude);
  const source = claude && typeof claude.source === "string" ? claude.source : null;
  if (!claude || claude.available !== true) {
    return {
      title: "Claude",
      text: "--",
      remaining: 0,
      progress: 0,
      color: "gray",
      weeklyRemaining: null,
      sessionRemaining: null,
      detail: withSource("不可用", source)
    };
  }

  const status = typeof claude.status === "string" ? claude.status : "allowed";
  const statusLabel = typeof claude.statusLabel === "string" ? claude.statusLabel : null;
  const explicitRemaining = toNumber(claude.remainingPercent, null);
  const explicitWeeklyRemaining = toNumber(claude.weeklyRemainingPercent, null);
  const explicitSessionRemaining = toNumber(claude.currentSessionRemainingPercent, null);
  const hoursTillReset = toNumber(claude.hoursTillReset, null);

  let remaining;
  let detail;

  if (explicitRemaining !== null) {
    remaining = clamp(explicitRemaining, 0, 100);
    detail = statusLabel || "用量数据";
  } else if (status === "rejected") {
    remaining = 0;
    detail = statusLabel || "已阻止";
  } else if (status === "allowed_warning") {
    const warningLooksLow = statusLabel && /(low|limit|blocked|exceeded|critical)/i.test(statusLabel);
    if (warningLooksLow) {
      remaining = 20;
      detail = statusLabel || "剩余较低";
    } else if (hoursTillReset !== null) {
      if (hoursTillReset <= 1) {
        remaining = 8;
      } else if (hoursTillReset <= 3) {
        remaining = 22;
      } else {
        remaining = 55;
      }
      detail = statusLabel || `约 ${Math.ceil(hoursTillReset)} 小时后重置`;
    } else {
      remaining = 55;
      detail = statusLabel || "警告";
    }
  } else if (hoursTillReset !== null) {
    if (hoursTillReset <= 1) {
      remaining = 8;
    } else if (hoursTillReset <= 3) {
      remaining = 22;
    } else {
      remaining = 65;
    }
    detail = statusLabel || `约 ${Math.ceil(hoursTillReset)} 小时后重置`;
  } else {
    remaining = 65;
    detail = statusLabel || "可用";
  }

  return {
    title: "Claude",
    text: formatPercent(remaining),
    remaining,
    progress: remaining / 100,
    color: colorForRemaining(remaining),
    weeklyRemaining: explicitWeeklyRemaining !== null ? Math.round(clamp(explicitWeeklyRemaining, 0, 100)) : null,
    sessionRemaining: explicitSessionRemaining !== null ? Math.round(clamp(explicitSessionRemaining, 0, 100)) : null,
    detail: withSource(detail, source)
  };
}

// ---------------------------------------------------------------------------
// 设置读取
// ---------------------------------------------------------------------------

function settingValue(key) {
  try {
    return SuperIsland.settings.get(key);
  } catch (error) {
    return null;
  }
}

function settingString(key, fallback) {
  const value = settingValue(key);
  return typeof value === "string" ? value : fallback;
}

function settingBool(key, fallback) {
  const value = settingValue(key);
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function settingNumber(key, fallback) {
  return toNumber(settingValue(key), fallback);
}

// ---------------------------------------------------------------------------
// DeepSeek 余额
//
// DeepSeek 官方只提供余额查询（GET /user/balance），没有用量/配额接口，
// 因此拿不到「本周 / 本次会话」这类百分比数据。圆环进度是
// 「余额 / 用户设置的充值参考值」的折算结果，只用于驱动填充与颜色分级；
// 环旁文字始终显示真实金额，避免被误读成官方配额百分比。
// ---------------------------------------------------------------------------

var deepseekCache = {
  status: "idle", // idle | loading | ok | error
  balance: null,
  currency: null,
  granted: null,
  toppedUp: null,
  sufficient: null,
  fetchedAt: 0,
  retryNotBefore: 0,
  error: null
};

var deepseekPollTimer = 0;
var deepseekInFlight = false;

function deepseekApiKey() {
  return settingString(DEEPSEEK_SETTING_API_KEY, "").trim();
}

function deepseekBudget() {
  const budget = settingNumber(DEEPSEEK_SETTING_BUDGET, DEEPSEEK_DEFAULT_BUDGET);
  return budget > 0 ? budget : DEEPSEEK_DEFAULT_BUDGET;
}

// 只有「开关打开」且「填了 API Key」时才占用灵动岛槽位，
// 未配置的用户布局与改造前完全一致（仍是 Codex + Claude 两个环）。
function deepseekEnabled() {
  if (!settingBool(DEEPSEEK_SETTING_SHOW, true)) return false;
  return deepseekApiKey().length > 0;
}

function resetDeepSeekCache() {
  deepseekInFlight = false;
  deepseekCache.status = "idle";
  deepseekCache.balance = null;
  deepseekCache.currency = null;
  deepseekCache.granted = null;
  deepseekCache.toppedUp = null;
  deepseekCache.sufficient = null;
  deepseekCache.fetchedAt = 0;
  deepseekCache.retryNotBefore = 0;
  deepseekCache.error = null;
}

function deepseekShouldRefresh() {
  if (!deepseekEnabled() || deepseekInFlight) return false;

  const now = Date.now();
  if (deepseekCache.status === "ok" && now - deepseekCache.fetchedAt < DEEPSEEK_STALE_MS) {
    return false;
  }
  return now >= deepseekCache.retryNotBefore;
}

function applyDeepSeekFailure(message) {
  deepseekCache.status = "error";
  deepseekCache.error = message || "请求失败";
  deepseekCache.balance = null;
  deepseekCache.sufficient = null;
  deepseekCache.retryNotBefore = Date.now() + DEEPSEEK_ERROR_BACKOFF_MS;
}

function pickDeepSeekBalanceInfo(balanceInfos) {
  if (!Array.isArray(balanceInfos) || balanceInfos.length === 0) return null;

  const cny = balanceInfos.find((info) => asObject(info) && info.currency === "CNY");
  if (cny) return cny;

  return balanceInfos.find((info) => asObject(info)) || null;
}

function applyDeepSeekResponse(response) {
  if (response && response.error) {
    applyDeepSeekFailure(String(response.error));
    return;
  }

  const status = toNumber(response && response.status, 0);
  if (status < 200 || status >= 300) {
    if (status === 401 || status === 403) {
      applyDeepSeekFailure("API Key 无效或无权限");
    } else if (status === 429) {
      applyDeepSeekFailure("请求过于频繁");
    } else {
      applyDeepSeekFailure(`HTTP ${status}`);
    }
    return;
  }

  const payload = asObject(response && response.data);
  if (!payload) {
    applyDeepSeekFailure("响应解析失败");
    return;
  }

  const info = pickDeepSeekBalanceInfo(payload.balance_infos);
  if (!info) {
    applyDeepSeekFailure("返回数据中没有余额");
    return;
  }

  const balance = toNumber(info.total_balance, null);
  if (balance === null) {
    applyDeepSeekFailure("余额字段缺失");
    return;
  }

  deepseekCache.status = "ok";
  deepseekCache.balance = balance;
  deepseekCache.currency = typeof info.currency === "string" ? info.currency : "CNY";
  deepseekCache.granted = toNumber(info.granted_balance, null);
  deepseekCache.toppedUp = toNumber(info.topped_up_balance, null);
  deepseekCache.sufficient = typeof payload.is_available === "boolean" ? payload.is_available : null;
  deepseekCache.fetchedAt = Date.now();
  deepseekCache.retryNotBefore = 0;
  deepseekCache.error = null;
}

function requestDeepSeekBalance() {
  if (deepseekInFlight) return;

  const apiKey = deepseekApiKey();
  if (!apiKey) return;

  deepseekInFlight = true;
  if (deepseekCache.status !== "ok") {
    deepseekCache.status = "loading";
  }

  const handleResponse = (response) => {
    deepseekInFlight = false;
    try {
      applyDeepSeekResponse(response);
    } catch (error) {
      applyDeepSeekFailure("响应解析失败");
    }
  };

  const handleFailure = (error) => {
    deepseekInFlight = false;
    applyDeepSeekFailure(String((error && error.message) || error || "请求失败"));
  };

  try {
    SuperIsland.http
      .fetch(DEEPSEEK_BALANCE_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + apiKey
        }
      })
      .then(handleResponse, handleFailure);
  } catch (error) {
    handleFailure(error);
  }
}

function stopDeepSeekPolling() {
  if (deepseekPollTimer) {
    clearInterval(deepseekPollTimer);
    deepseekPollTimer = 0;
  }
}

function startDeepSeekPolling() {
  stopDeepSeekPolling();
  if (!deepseekEnabled()) return;

  requestDeepSeekBalance();
  deepseekPollTimer = setInterval(() => {
    if (!deepseekEnabled()) {
      stopDeepSeekPolling();
      return;
    }
    requestDeepSeekBalance();
  }, DEEPSEEK_REFRESH_MS);
}

// 宿主在省电模式下会挂起扩展定时器，所以渲染时再补一次新鲜度检查，
// 保证只要这个模块在显示，余额就不会长期停在旧值。
function maybeRefreshDeepSeek() {
  if (deepseekShouldRefresh()) {
    requestDeepSeekBalance();
  }
}

function deepseekCurrencySymbol(currency) {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return "";
}

function formatMoney(amount, currency, compact) {
  const symbol = deepseekCurrencySymbol(currency);
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "--";

  if (compact) {
    // compact 槽位很窄，金额超过三位数就压缩显示。
    if (amount >= 1000) return `${symbol}${(amount / 1000).toFixed(1)}k`;
    if (amount >= 100) return `${symbol}${Math.round(amount)}`;
    return `${symbol}${amount.toFixed(1)}`;
  }
  return `${symbol}${amount.toFixed(2)}`;
}

function deepseekModel() {
  if (!deepseekEnabled()) return null;

  const budget = deepseekBudget();
  const currency = deepseekCache.currency || "CNY";
  const balance = deepseekCache.balance;

  if (deepseekCache.status === "error" || typeof balance !== "number") {
    const isError = deepseekCache.status === "error";
    return {
      title: "DeepSeek",
      text: "--",
      shortText: "--",
      remaining: 0,
      progress: 0,
      color: "gray",
      currency,
      balance: null,
      granted: null,
      toppedUp: null,
      sufficient: null,
      detail: isError ? deepseekCache.error : "正在获取余额"
    };
  }

  const remaining = clamp((balance / budget) * 100, 0, 100);
  const insufficient = deepseekCache.sufficient === false;

  return {
    title: "DeepSeek",
    text: formatMoney(balance, currency, false),
    shortText: formatMoney(balance, currency, true),
    remaining,
    progress: remaining / 100,
    color: insufficient ? "red" : colorForRemaining(remaining),
    currency,
    balance,
    granted: deepseekCache.granted,
    toppedUp: deepseekCache.toppedUp,
    sufficient: deepseekCache.sufficient,
    detail: insufficient
      ? `余额不足，无法调用 | 参考值 ${formatMoney(budget, currency, false)}`
      : `参考值 ${formatMoney(budget, currency, false)}`
  };
}

function ringWithText(model, lineWidth, text) {
  return View.hstack([
    View.circularProgress(model.progress, {
      total: 1,
      lineWidth,
      color: model.color
    }),
    View.text(text, {
      style: "monospacedSmall",
      color: model.color
    })
  ], { spacing: 5, align: "center" });
}

function ringWithPercent(model, lineWidth) {
  return ringWithText(model, lineWidth, model.text);
}

// compact 槽位窄，DeepSeek 用短金额（¥110），Codex/Claude 仍用百分比。
function compactRing(model, lineWidth) {
  return ringWithText(model, lineWidth, model.shortText || model.text);
}

function usageSnapshot() {
  const usage = SuperIsland.system.getAIUsage();
  return usage && typeof usage === "object" ? usage : null;
}

function expandedColumn(model) {
  return View.vstack([
    View.text(model.title, { style: "caption", color: "gray" }),
    View.hstack([
      View.circularProgress(model.progress, { total: 1, lineWidth: 4, color: model.color }),
      View.text(model.text, { style: "monospaced", color: model.color })
    ], { spacing: 8, align: "center" })
  ], { spacing: 4, align: "center" });
}

function fullExpandedColumn(model) {
  return View.vstack([
    View.circularProgress(model.progress, { total: 1, lineWidth: 6, color: model.color }),
    View.text(model.title, { style: "caption", color: "gray" }),
    View.text(model.text, { style: "monospaced", color: model.color }),
    View.text(model.footnotePrimary || `本周 ${percentLabel(model.weeklyRemaining)}`, {
      style: "footnote",
      color: "gray"
    }),
    View.text(model.footnoteSecondary || `本次会话 ${percentLabel(model.sessionRemaining)}`, {
      style: "footnote",
      color: "gray"
    })
  ], { spacing: 4, align: "center" });
}

// Codex/Claude 的明细是「本周 / 本次会话」百分比；
// DeepSeek 没有配额概念，改为显示充值余额与赠送余额。
function fullExpandedModels(usage) {
  return activeModels(usage).map((model) => {
    if (model.title !== "DeepSeek") return model;
    return {
      title: model.title,
      text: model.text,
      progress: model.progress,
      color: model.color,
      footnotePrimary: `充值 ${formatMoney(model.toppedUp, model.currency, false)}`,
      footnoteSecondary: `赠送 ${formatMoney(model.granted, model.currency, false)}`
    };
  });
}

function activeModels(usage) {
  const models = [codexModel(usage), claudeModel(usage)];
  const deepseek = deepseekModel();
  if (deepseek) models.push(deepseek);
  return models;
}

SuperIsland.registerModule({
  onActivate() {
    startDeepSeekPolling();
  },

  onDeactivate() {
    stopDeepSeekPolling();
  },

  onSettingsChanged(key) {
    if (key !== DEEPSEEK_SETTING_SHOW &&
        key !== DEEPSEEK_SETTING_API_KEY &&
        key !== DEEPSEEK_SETTING_BUDGET) {
      return;
    }
    resetDeepSeekCache();
    startDeepSeekPolling();
  },

  compact() {
    maybeRefreshDeepSeek();

    const usage = usageSnapshot();
    const codex = codexModel(usage);
    const claude = claudeModel(usage);
    const deepseek = deepseekModel();

    if (!deepseek) {
      return View.hstack([
        ringWithPercent(codex, 2.5),
        View.spacer(),
        ringWithPercent(claude, 2.5)
      ], { spacing: 8, align: "center" });
    }

    return View.hstack([
      ringWithPercent(codex, 2.5),
      View.spacer(),
      ringWithPercent(claude, 2.5),
      View.spacer(),
      compactRing(deepseek, 2.5)
    ], { spacing: 8, align: "center" });
  },

  minimalCompact: {
    leading() {
      const usage = usageSnapshot();
      const codex = codexModel(usage);
      return View.circularProgress(codex.progress, {
        total: 1,
        lineWidth: 3,
        color: codex.color
      });
    },

    trailing() {
      const usage = usageSnapshot();
      const claude = claudeModel(usage);
      return View.frame(
        View.circularProgress(claude.progress, {
          total: 1,
          lineWidth: 3,
          color: claude.color
        }),
        { maxWidth: 1000, alignment: "trailing" }
      );
    }
  },

  expanded() {
    maybeRefreshDeepSeek();

    const usage = usageSnapshot();
    const models = activeModels(usage);

    return View.hstack(models.map(expandedColumn), {
      spacing: 12,
      align: "center",
      distribution: "fillEqually"
    });
  },

  fullExpanded() {
    maybeRefreshDeepSeek();

    const usage = usageSnapshot();
    const models = fullExpandedModels(usage);

    return View.vstack([
      View.text("AI 用量", { style: "title", color: "white" }),
      View.hstack(models.map(fullExpandedColumn), {
        spacing: 20,
        align: "center",
        distribution: "fillEqually"
      })
    ], { spacing: 10, align: "center" });
  }
});
