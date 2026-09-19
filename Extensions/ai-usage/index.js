"use strict";

// DeepSeek 余额展示。
//
// 数据来自原生 provider（SuperIsland.system.getAIUsage().deepseek），本扩展只
// 负责渲染，不发任何网络请求，因此不需要 network 权限，也不接触 API Key。
//
// DeepSeek 官方只提供余额接口（金额），没有配额百分比，所以圆环进度是
// 「余额 / 用户设置的充值参考值」的折算结果，仅驱动填充与颜色分级；
// 显示的数值始终是真实余额。

const LOW_THRESHOLD = 25;
const VERY_LOW_THRESHOLD = 10;
const DEFAULT_BUDGET = 100;
const SETTING_SHOW = "showDeepSeek";
const SETTING_BUDGET = "deepseekBudget";

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

function colorForRemaining(remainingPercent) {
  if (remainingPercent <= VERY_LOW_THRESHOLD) return "red";
  if (remainingPercent <= LOW_THRESHOLD) return "orange";
  return "green";
}

function settingValue(key) {
  try {
    return SuperIsland.settings.get(key);
  } catch (error) {
    return null;
  }
}

function settingBool(key, fallback) {
  const value = settingValue(key);
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function budgetValue() {
  const budget = toNumber(settingValue(SETTING_BUDGET), DEFAULT_BUDGET);
  return budget > 0 ? budget : DEFAULT_BUDGET;
}

// 原生 provider 的凭据来源，便于确认 Key 是从哪儿读到的。
function sourceLabel(source) {
  switch (source) {
    case "environment":
      return "环境变量";
    case "file":
      return "本地文件";
    case "keychain":
      return "钥匙串";
    case "settings":
      return "扩展设置";
    case "loading":
      return "加载中";
    default:
      return null;
  }
}

function currencySymbol(currency) {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return "";
}

function formatMoney(amount, currency, compact) {
  const symbol = currencySymbol(currency);
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "--";

  if (compact) {
    // compact 槽位窄，金额超过三位数就压缩显示。
    if (amount >= 1000) return `${symbol}${(amount / 1000).toFixed(1)}k`;
    if (amount >= 100) return `${symbol}${Math.round(amount)}`;
    return `${symbol}${amount.toFixed(1)}`;
  }
  return `${symbol}${amount.toFixed(2)}`;
}

function deepseekSnapshot() {
  const usage = SuperIsland.system.getAIUsage();
  const deepseek = usage && typeof usage === "object" ? usage.deepseek : null;
  return deepseek && typeof deepseek === "object" ? deepseek : null;
}

// 返回 null 表示用户在设置里关闭了该模块。
function balanceModel() {
  if (!settingBool(SETTING_SHOW, true)) return null;

  const snapshot = deepseekSnapshot();
  const source = snapshot && typeof snapshot.source === "string" ? snapshot.source : null;
  const label = sourceLabel(source);
  const budget = budgetValue();
  const currency =
    (snapshot && typeof snapshot.currency === "string" && snapshot.currency) || "CNY";
  const total = toNumber(snapshot && snapshot.totalBalance, null);
  const available = !!(snapshot && snapshot.available === true && total !== null);

  if (!available) {
    const error =
      snapshot && typeof snapshot.error === "string" && snapshot.error ? snapshot.error : null;
    return {
      text: "--",
      compactText: "--",
      remaining: 0,
      progress: 0,
      color: "gray",
      currency,
      total: null,
      granted: null,
      toppedUp: null,
      budget,
      detail: error || label || "不可用"
    };
  }

  const remaining = clamp((total / budget) * 100, 0, 100);
  const insufficient = snapshot.sufficient === false;

  return {
    text: formatMoney(total, currency, false),
    compactText: formatMoney(total, currency, true),
    remaining,
    progress: remaining / 100,
    color: insufficient ? "red" : colorForRemaining(remaining),
    currency,
    total,
    granted: toNumber(snapshot.grantedBalance, null),
    toppedUp: toNumber(snapshot.toppedUpBalance, null),
    budget,
    detail: [insufficient ? "余额不足，无法调用" : null, label ? `Key 来源 ${label}` : null]
      .filter(Boolean)
      .join(" | ")
  };
}

function balanceRing(model, lineWidth) {
  return View.circularProgress(model.progress, {
    total: 1,
    lineWidth,
    color: model.color
  });
}

SuperIsland.registerModule({
  compact() {
    const model = balanceModel();
    if (!model) return View.text("");

    return View.hstack([
      balanceRing(model, 2.5),
      View.text(model.compactText, { style: "monospacedSmall", color: model.color }),
      View.spacer()
    ], { spacing: 5, align: "center" });
  },

  minimalCompact: {
    leading() {
      const model = balanceModel();
      if (!model) return View.text("");
      return balanceRing(model, 3);
    },

    trailing() {
      const model = balanceModel();
      if (!model) return View.text("");
      return View.frame(
        View.text(model.compactText, { style: "monospacedSmall", color: model.color }),
        { maxWidth: 1000, alignment: "trailing" }
      );
    }
  },

  expanded() {
    const model = balanceModel();
    if (!model) {
      return View.text("DeepSeek 余额已隐藏", { style: "footnote", color: "gray" });
    }

    return View.hstack([
      View.text("DeepSeek 余额", { style: "caption", color: "gray" }),
      View.hstack([
        balanceRing(model, 4),
        View.text(model.text, { style: "monospaced", color: model.color })
      ], { spacing: 8, align: "center" })
    ], { spacing: 10, align: "center" });
  },

  fullExpanded() {
    const model = balanceModel();
    if (!model) {
      return View.text("DeepSeek 余额已隐藏", { style: "footnote", color: "gray" });
    }

    const footnote = [`参考值 ${formatMoney(model.budget, model.currency, false)}`];
    if (model.detail) footnote.push(model.detail);

    return View.vstack([
      View.text("DeepSeek 余额", { style: "title", color: "white" }),
      View.hstack([
        balanceRing(model, 8),
        View.vstack([
          View.text(model.text, { style: "monospaced", color: model.color }),
          View.text(`充值 ${formatMoney(model.toppedUp, model.currency, false)}`, {
            style: "footnote",
            color: "gray"
          }),
          View.text(`赠送 ${formatMoney(model.granted, model.currency, false)}`, {
            style: "footnote",
            color: "gray"
          })
        ], { spacing: 2, align: "leading" })
      ], { spacing: 10, align: "center" }),
      View.text(footnote.join(" | "), { style: "footnote", color: "gray" })
    ], { spacing: 8, align: "center" });
  }
});
