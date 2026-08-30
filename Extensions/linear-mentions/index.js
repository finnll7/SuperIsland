"use strict";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_APP_NAME = "Linear";
const LINEAR_AUTHORIZE_URL = "https://api.supercmd.sh/auth/linear/authorize?app=superisland";
const MAX_VISIBLE_MENTIONS = 8;
const MAX_PERSISTED_MENTION_IDS = 200;
const GRAPHQL_FETCH_LIMIT = 50;
const PREVIEW_LIMIT_COMPACT = 34;
const PREVIEW_LIMIT_EXPANDED = 84;
const PREVIEW_LIMIT_NOTIFICATION = 160;
const MIN_POLL_GAP_MS = 4 * 1000;

const POLL_INTERVAL_OPTIONS_SECONDS = [300, 600, 900, 1800, 2700, 3600];
const DEFAULT_POLL_INTERVAL_SECONDS = 300;

function renderInputComposer(options) {
  if (SuperIsland.components && typeof SuperIsland.components.inputComposer === "function") {
    return SuperIsland.components.inputComposer(options);
  }

  return View.inputBox(
    options.placeholder || "",
    options.text || "",
    options.action || "",
    {
      id: options.id || "",
      autoFocus: options.autoFocus !== false,
      minHeight: options.minHeight || 64,
      showsEmojiButton: options.showsEmojiButton === true
    }
  );
}

const LIST_MENTIONS_QUERY = `
query SuperIslandLinearMentions($first: Int!) {
  notifications(first: $first, orderBy: updatedAt) {
    nodes {
      __typename
      id
      type
      createdAt
      updatedAt
      readAt
      archivedAt
      actor {
        id
        name
        displayName
        avatarUrl
        url
      }
      ... on IssueNotification {
        issueId
        commentId
        parentCommentId
        issue {
          id
          identifier
          title
          description
          url
        }
        comment {
          id
          body
          url
          parentId
        }
        parentComment {
          id
          body
        }
      }
    }
  }
}
`;

const CREATE_COMMENT_MUTATION = `
mutation SuperIslandLinearReply($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
    }
  }
}
`;

let state = {
  status: "needsAuth",
  statusText: "连接 Linear 以开始关注提及。",
  error: "",
  connected: false,
  mentions: [],
  lastSyncAt: 0
};

let replyComposer = null;
let pollTimer = 0;
let pollInFlight = false;
let lastPollStartedAt = 0;
let activePollIntervalMs = 0;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  if (lowered === "undefined" || lowered === "null" || lowered === "(null)") return "";
  return trimmed;
}

function normalizeWhitespace(value) {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function cleanMarkdown(value) {
  let text = normalizeText(value);
  if (!text) return "";
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/[*_~]+/g, "");
  return normalizeWhitespace(text);
}

function truncate(value, limit) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}...`;
}

function parseTimestamp(value) {
  const raw = normalizeText(value);
  if (!raw) return 0;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.floor(timestamp / 1000);
}

function timeAgoLabel(timestamp) {
  if (!timestamp) return "刚刚";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function settingBoolean(key, fallback) {
  const value = SuperIsland.settings.get(key);
  return typeof value === "boolean" ? value : fallback;
}

function pollIntervalSeconds() {
  const raw = SuperIsland.settings.get("pollIntervalSeconds");
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && POLL_INTERVAL_OPTIONS_SECONDS.indexOf(parsed) !== -1) {
    return parsed;
  }
  return DEFAULT_POLL_INTERVAL_SECONDS;
}

function pollIntervalMs() {
  return pollIntervalSeconds() * 1000;
}

function pollIntervalLabel() {
  const seconds = pollIntervalSeconds();
  if (seconds < 60) return `每 ${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  return `每 ${Math.round(minutes / 60)} 小时`;
}

function readOAuthSession() {
  const oauth = asObject(SuperIsland.store.get("oauth"));
  if (!oauth) return null;

  const accessToken = normalizeText(oauth.accessToken || oauth.access_token);
  if (!accessToken) return null;

  const tokenType = normalizeText(oauth.tokenType || oauth.token_type) || "Bearer";
  const scope = normalizeText(oauth.scope);
  const callbackURL = normalizeText(oauth.callbackURL);
  const receivedAt = Number(oauth.receivedAt);
  const expiresIn = Number(oauth.expiresIn ?? oauth.expires_in);

  return {
    accessToken,
    tokenType,
    scope,
    callbackURL,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : 0,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0
  };
}

function oauthSessionState() {
  const session = readOAuthSession();
  if (!session) {
    return { connected: false, expired: false, session: null };
  }

  const expiresAt = session.receivedAt > 0 && session.expiresIn > 0
    ? session.receivedAt + session.expiresIn
    : 0;
  const expired = expiresAt > 0 ? Math.floor(Date.now() / 1000) >= expiresAt - 60 : false;
  return { connected: !expired, expired, session };
}

function configuredAccessToken() {
  const oauth = oauthSessionState();
  return oauth.connected && oauth.session ? oauth.session.accessToken : "";
}

function tokenSignature(token) {
  const normalized = normalizeText(token);
  if (!normalized) return "";
  return `${normalized.length}:${normalized.slice(-8)}`;
}

function readStringArray(key) {
  const stored = SuperIsland.store.get(key);
  if (!Array.isArray(stored)) return [];
  return stored.map((value) => normalizeText(value)).filter(Boolean);
}

function writeStringArray(key, values, limit) {
  const deduped = [];
  const seen = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = normalizeText(values[index]);
    if (!value || seen[value]) continue;
    seen[value] = true;
    deduped.push(value);
    if (deduped.length >= limit) break;
  }
  SuperIsland.store.set(key, deduped);
}

function mentionTypeLabel(type) {
  if (type === "issueCommentMention") return "评论提及";
  if (type === "issueMention") return "问题提及";
  return "提及";
}

function mentionHeadline(mention) {
  const identifier = normalizeText(mention && mention.issueIdentifier);
  const title = normalizeText(mention && mention.issueTitle);
  if (identifier && title && identifier !== title) {
    return `${identifier} - ${title}`;
  }
  return identifier || title || "Linear 问题";
}

function latestMention() {
  return state.mentions.length > 0 ? state.mentions[0] : null;
}

function buildMentionFromNotification(node) {
  const row = asObject(node);
  if (!row) return null;

  const type = normalizeText(row.type);
  if (type !== "issueCommentMention" && type !== "issueMention") return null;
  if (normalizeText(row.archivedAt)) return null;

  const issue = asObject(row.issue);
  const issueId = normalizeText(row.issueId) || normalizeText(issue && issue.id);
  if (!issueId) return null;

  const comment = asObject(row.comment);
  const parentComment = asObject(row.parentComment);
  const actor = asObject(row.actor);

  const issueIdentifier = normalizeText(issue && issue.identifier);
  const issueTitle = normalizeText(issue && issue.title) || issueIdentifier || "无标题问题";
  const issueDescription = cleanMarkdown(issue && issue.description);
  const issueURL = normalizeText(issue && issue.url);
  const commentId = normalizeText(row.commentId) || normalizeText(comment && comment.id);
  const parentCommentId =
    normalizeText(row.parentCommentId) ||
    normalizeText(comment && comment.parentId) ||
    normalizeText(parentComment && parentComment.id);
  const commentBody = cleanMarkdown(comment && comment.body);
  const parentCommentBody = cleanMarkdown(parentComment && parentComment.body);
  const commentURL = normalizeText(comment && comment.url);
  const actorName =
    normalizeText(actor && actor.displayName) ||
    normalizeText(actor && actor.name) ||
    LINEAR_APP_NAME;
  const actorAvatarURL = normalizeText(actor && actor.avatarUrl);
  const preview =
    commentBody ||
    parentCommentBody ||
    issueDescription ||
    `在 ${issueIdentifier || "某个 Linear 问题"} 中${mentionTypeLabel(type)}`;
  const createdAt = parseTimestamp(row.createdAt || row.updatedAt);

  return {
    notificationKey: commentId ? `comment:${commentId}` : `notification:${normalizeText(row.id)}`,
    notificationID: normalizeText(row.id),
    notificationSourceID: `linear:${normalizeText(row.id)}`,
    type,
    createdAt,
    updatedAt: parseTimestamp(row.updatedAt || row.createdAt),
    issueId,
    issueIdentifier,
    issueTitle,
    issueURL,
    commentId,
    commentURL,
    replyParentId: parentCommentId || commentId,
    preview,
    actorName,
    actorAvatarURL
  };
}

function sortMentionsDescending(items) {
  return items.slice().sort((left, right) => {
    if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
    return left.notificationID < right.notificationID ? 1 : -1;
  });
}

function persistPushedMentionKeys(currentMentions, priorKeys) {
  const currentKeys = currentMentions.map((mention) => mention.notificationKey);
  writeStringArray("pushedMentionKeys", currentKeys.concat(priorKeys), MAX_PERSISTED_MENTION_IDS);
}

function resetBaselineForToken(signature) {
  SuperIsland.store.set("linearTokenSignature", signature);
  SuperIsland.store.set("linearBaselineReady", false);
  SuperIsland.store.set("seenMentionNotificationIDs", []);
  SuperIsland.store.set("pushedMentionKeys", []);
}

async function graphqlRequest(query, variables) {
  const oauth = oauthSessionState();
  if (!oauth.connected || !oauth.session) {
    return { ok: false, error: oauth.expired ? "Linear 登录已过期。" : "缺少 Linear 登录信息。" };
  }

  const response = await SuperIsland.http.fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `${oauth.session.tokenType} ${oauth.session.accessToken}`,
      "public-file-urls-expire-in": "60"
    },
    body: JSON.stringify({ query, variables: variables || {} })
  });

  if (response && response.error) {
    return { ok: false, error: normalizeText(response.error) || "网络错误。" };
  }

  const payload = asObject(response && response.data);
  if (!payload) {
    const text = normalizeText(response && response.text);
    return {
      ok: false,
      error: text || `来自 Linear 的意外响应（${Number(response && response.status) || 0}）。`
    };
  }

  const errors = asArray(payload.errors)
    .map((entry) => normalizeText(asObject(entry) && asObject(entry).message))
    .filter(Boolean);
  if (errors.length > 0) {
    return { ok: false, error: errors[0] };
  }

  const status = Number(response && response.status) || 0;
  if (status < 200 || status >= 300) {
    return { ok: false, error: `Linear API 返回 HTTP ${status}。` };
  }

  return { ok: true, data: asObject(payload.data) || {} };
}

function mentionNotificationPayload(mention) {
  return {
    notificationID: mention.notificationID,
    notificationSourceID: mention.notificationSourceID,
    type: mention.type,
    issueId: mention.issueId,
    issueIdentifier: mention.issueIdentifier,
    issueTitle: mention.issueTitle,
    issueURL: mention.issueURL,
    commentId: mention.commentId,
    commentURL: mention.commentURL,
    replyParentId: mention.replyParentId,
    preview: mention.preview,
    actorName: mention.actorName,
    actorAvatarURL: mention.actorAvatarURL
  };
}

function sendMentionNotification(mention) {
  SuperIsland.notifications.send({
    id: mention.notificationSourceID,
    appName: LINEAR_APP_NAME,
    title: mention.issueIdentifier || mention.issueTitle || "新的 Linear 提及",
    body: mention.issueTitle || "您在 Linear 中被提及",
    senderName: mention.actorName,
    previewText: truncate(mention.preview, PREVIEW_LIMIT_NOTIFICATION),
    avatarURL: mention.actorAvatarURL || undefined,
    systemNotification: settingBoolean("systemNotification", false),
    tapAction: {
      action: "open-reply",
      presentation: "fullExpanded",
      payload: mentionNotificationPayload(mention)
    }
  });
}

async function pollMentions(force) {
  const now = Date.now();
  if (pollInFlight) {
    console.log("[linear] poll skipped: already in flight");
    return;
  }
  if (!force && now - lastPollStartedAt < MIN_POLL_GAP_MS) {
    console.log("[linear] poll skipped: under min gap");
    return;
  }

  const oauth = oauthSessionState();
  const accessToken = oauth.connected && oauth.session ? oauth.session.accessToken : "";
  const signature = tokenSignature(accessToken);
  const storedSignature = normalizeText(SuperIsland.store.get("linearTokenSignature"));

  if (signature !== storedSignature) {
    console.log("[linear] token signature changed, resetting baseline");
    resetBaselineForToken(signature);
  }

  if (!oauth.connected || !oauth.session) {
    console.log("[linear] poll aborted: no oauth session (expired=" + oauth.expired + ")");
    state = {
      status: "needsAuth",
      statusText: oauth.expired ? "Linear 登录已过期，请重新连接。" : "连接 Linear 以开始关注提及。",
      error: "",
      connected: false,
      mentions: [],
      lastSyncAt: 0
    };
    return;
  }

  pollInFlight = true;
  lastPollStartedAt = now;
  console.log("[linear] polling Linear...");

  try {
    const response = await graphqlRequest(LIST_MENTIONS_QUERY, { first: GRAPHQL_FETCH_LIMIT });
    if (!response.ok) {
      console.error("[linear] poll error: " + (response.error || "unknown"));
      state = {
        status: "error",
        statusText: "Linear 同步失败",
        error: response.error || "无法加载提及。",
        connected: false,
        mentions: state.mentions,
        lastSyncAt: state.lastSyncAt
      };
      return;
    }

    const notifications = asArray(asObject(response.data.notifications) && asObject(response.data.notifications).nodes);
    const allMentions = sortMentionsDescending(
      notifications
        .map(buildMentionFromNotification)
        .filter(Boolean)
    );
    const mentions = allMentions.slice(0, MAX_VISIBLE_MENTIONS);

    const pushedMentionKeys = readStringArray("pushedMentionKeys");
    const baselineReady = SuperIsland.store.get("linearBaselineReady") === true;

    console.log("[linear] poll ok: " + allMentions.length + " mentions, baselineReady=" + baselineReady + ", pushedKeys=" + pushedMentionKeys.length);

    if (!baselineReady) {
      console.log("[linear] establishing baseline (no notifications fired for " + allMentions.length + " existing mentions). Use 'Resync (notify all)' in fullExpanded to replay them.");
      SuperIsland.store.set("linearBaselineReady", true);
      persistPushedMentionKeys(allMentions, pushedMentionKeys);
    } else {
      const unseenMentions = allMentions
        .filter((mention) => pushedMentionKeys.indexOf(mention.notificationKey) === -1)
        .sort((left, right) => left.createdAt - right.createdAt);

      console.log("[linear] " + unseenMentions.length + " new mention(s) to notify");

      if (unseenMentions.length > 0) {
        for (let index = 0; index < unseenMentions.length; index += 1) {
          console.log("[linear] notify: " + unseenMentions[index].notificationKey + " - " + unseenMentions[index].issueIdentifier);
          sendMentionNotification(unseenMentions[index]);
        }

        persistPushedMentionKeys(allMentions, pushedMentionKeys);

        if (settingBoolean("autoReveal", true) && typeof SuperIsland.island.activate === "function") {
          SuperIsland.island.activate(true);
        }
      } else {
        persistPushedMentionKeys(allMentions, pushedMentionKeys);
      }
    }

    state = {
      status: "ready",
      statusText: mentions.length > 0 ? "正在关注 Linear 提及" : "暂无近期提及",
      error: "",
      connected: true,
      mentions,
      lastSyncAt: Math.floor(Date.now() / 1000)
    };
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  const intervalMs = pollIntervalMs();
  if (pollTimer && activePollIntervalMs === intervalMs) {
    return;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  activePollIntervalMs = intervalMs;
  pollTimer = setInterval(() => {
    pollMentions(false);
  }, intervalMs);
  pollMentions(true);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  activePollIntervalMs = 0;
}

function ensurePollIntervalCurrent() {
  const desired = pollIntervalMs();
  if (pollTimer && desired !== activePollIntervalMs) {
    startPolling();
  }
}

function openReplyComposer(payload) {
  const data = asObject(payload);
  if (!data) return;

  const issueId = normalizeText(data.issueId);
  if (!issueId) return;

  replyComposer = {
    notificationID: normalizeText(data.notificationID),
    notificationSourceID: normalizeText(data.notificationSourceID),
    type: normalizeText(data.type),
    issueId,
    issueIdentifier: normalizeText(data.issueIdentifier),
    issueTitle: normalizeText(data.issueTitle) || "Linear 问题",
    issueURL: normalizeText(data.issueURL),
    commentId: normalizeText(data.commentId),
    commentURL: normalizeText(data.commentURL),
    replyParentId: normalizeText(data.replyParentId),
    actorName: normalizeText(data.actorName) || LINEAR_APP_NAME,
    actorAvatarURL: normalizeText(data.actorAvatarURL),
    preview: normalizeText(data.preview),
    error: ""
  };
}

function closeReplyComposer() {
  replyComposer = null;
}

async function submitReply(body) {
  const text = normalizeText(body);
  if (!replyComposer || !text) return;

  const input = {
    body: text,
    issueId: replyComposer.issueId
  };

  if (replyComposer.replyParentId) {
    input.parentId = replyComposer.replyParentId;
  }

  const response = await graphqlRequest(CREATE_COMMENT_MUTATION, { input });
  if (!response.ok) {
    replyComposer.error = response.error || "发送回复失败。";
    SuperIsland.playFeedback("error");
    return;
  }

  const payload = asObject(response.data.commentCreate);
  if (!payload || payload.success !== true) {
    replyComposer.error = "Linear 未接受该回复。";
    SuperIsland.playFeedback("error");
    return;
  }

  if (replyComposer.notificationSourceID && typeof SuperIsland.system.dismissNotification === "function") {
    SuperIsland.system.dismissNotification(replyComposer.notificationSourceID);
  }

  closeReplyComposer();
  const closed = typeof SuperIsland.system.closePresentedInteraction === "function"
    ? !!SuperIsland.system.closePresentedInteraction()
    : false;
  if (!closed) {
    pollMentions(true);
  }
  SuperIsland.playFeedback("success");
}

function statusFooterText() {
  if (state.error) return state.error;
  if (state.lastSyncAt) return `上次同步 ${timeAgoLabel(state.lastSyncAt)}`;
  return state.statusText;
}

function mentionRow(mention, expanded) {
  return View.vstack([
    View.hstack([
      View.text(mention.actorName, { style: "caption", color: "white", lineLimit: 1 }),
      View.spacer(),
      View.text(timeAgoLabel(mention.createdAt), { style: "footnote", color: "gray", lineLimit: 1 })
    ], { spacing: 6, align: "center" }),
    View.text(
      truncate(
        mentionHeadline(mention),
        expanded ? PREVIEW_LIMIT_EXPANDED : PREVIEW_LIMIT_COMPACT
      ),
      { style: "caption", color: "gray", lineLimit: 1 }
    ),
    View.text(
      truncate(mention.preview, expanded ? PREVIEW_LIMIT_EXPANDED : PREVIEW_LIMIT_COMPACT),
      { style: "footnote", color: "gray", lineLimit: 2 }
    )
  ], { spacing: 3, align: "leading" });
}

function issueHeadlineBadge(text) {
  return View.cornerRadius(
    View.background(
      View.padding(
        View.text(text, {
          style: "footnote",
          color: { r: 1, g: 1, b: 1, a: 0.9 },
          lineLimit: 1
        }),
        { edges: "all", amount: 5 }
      ),
      { r: 0.12, g: 0.2, b: 0.42, a: 0.36 }
    ),
    7
  );
}

function replyComposerView() {
  const header = [];
  if (replyComposer.actorAvatarURL) {
    header.push(
      View.image(replyComposer.actorAvatarURL, {
        width: 18,
        height: 18,
        cornerRadius: 9
      })
    );
  } else {
    header.push(View.icon("person.crop.circle", { size: 15, color: "gray" }));
  }

  header.push(
    View.frame(
      View.text(replyComposer.actorName, {
        style: "caption",
        color: "gray",
        lineLimit: 1
      }),
      { maxWidth: 1000, alignment: "leading" }
    )
  );

  const controls = [];
  if (replyComposer.issueURL || replyComposer.commentURL) {
    controls.push(
      View.button(
        View.text("在 Linear 中打开", { style: "caption", color: "blue", lineLimit: 1 }),
        "open-in-linear"
      )
    );
  }
  controls.push(
    View.button(
      View.text("关闭", { style: "caption", color: "gray", lineLimit: 1 }),
      "close-reply"
    )
  );

  return View.vstack([
    View.hstack([
      ...header,
      View.spacer(),
      ...controls
    ], { spacing: 8, align: "top" }),
    View.text(
      truncate(
        replyComposer.preview || `在 ${replyComposer.issueTitle} 中${mentionTypeLabel(replyComposer.type)}`,
        PREVIEW_LIMIT_EXPANDED * 2
      ),
      {
        style: "caption",
        color: { r: 1, g: 1, b: 1, a: 0.92 },
        lineLimit: 3
      }
    ),
    issueHeadlineBadge(mentionHeadline(replyComposer)),
    View.spacer(),
    renderInputComposer({
      placeholder: `在 ${replyComposer.issueIdentifier || "Linear"} 中回复`,
      text: "",
      action: "submit-reply",
      id: replyComposer.commentId || replyComposer.issueId,
      autoFocus: true,
      minHeight: 46,
      showsEmojiButton: true,
      showsShortcutHint: false,
      chrome: false,
      error: replyComposer.error
    })
  ], { spacing: 8, align: "leading" });
}

function compactView() {
  const mention = latestMention();
  const oauth = oauthSessionState();

  if (replyComposer) {
    return View.hstack([
      View.icon("arrowshape.turn.up.left.fill", { size: 12, color: "blue" }),
      View.text(`正在 ${replyComposer.issueIdentifier || "Linear"} 中回复`, {
        style: "caption",
        color: "white",
        lineLimit: 1
      })
    ], { spacing: 6, align: "center" });
  }

  if (state.error) {
    return View.hstack([
      View.icon("exclamationmark.triangle.fill", { size: 12, color: "red" }),
      View.text(truncate(state.error, PREVIEW_LIMIT_COMPACT), {
        style: "caption",
        color: "red",
        lineLimit: 1
      })
    ], { spacing: 6, align: "center" });
  }

  if (!oauth.connected) {
    return View.hstack([
      View.icon("link.badge.plus", { size: 12, color: "gray" }),
      View.text(oauth.expired ? "Linear 登录已过期" : "连接 Linear", { style: "caption", color: "gray", lineLimit: 1 })
    ], { spacing: 6, align: "center" });
  }

  if (!mention) {
    return View.hstack([
      View.icon("at", { size: 12, color: "blue" }),
      View.text(state.connected ? "正在关注提及" : state.statusText, {
        style: "caption",
        color: state.connected ? "white" : "gray",
        lineLimit: 1
      })
    ], { spacing: 6, align: "center" });
  }

  return View.hstack([
    View.icon("at", { size: 12, color: "blue" }),
    View.text(
      truncate(`${mention.actorName}: ${mentionHeadline(mention)}`, PREVIEW_LIMIT_COMPACT),
      {
        style: "caption",
        color: "white",
        lineLimit: 1
      }
    )
  ], { spacing: 6, align: "center" });
}

function expandedView() {
  const oauth = oauthSessionState();

  if (replyComposer) {
    return View.vstack([
      View.text(`正在 ${replyComposer.issueIdentifier || "Linear"} 中回复`, { style: "title", lineLimit: 1 }),
      View.text("从通知打开。展开以发送您的回复。", {
        style: "caption",
        color: "gray",
        lineLimit: 2
      })
    ], { spacing: 6, align: "leading" });
  }

  if (!oauth.connected) {
    return View.vstack([
      View.text("Linear 提及", { style: "title", lineLimit: 1 }),
      View.text(oauth.expired ? "您的 Linear 登录已过期，请重新连接以继续。" : "连接 Linear 以开始关注提及。", {
        style: "caption",
        color: "gray",
        lineLimit: 2
      })
    ], { spacing: 6, align: "leading" });
  }

  const rows = state.mentions.slice(0, 2).map((mention) => mentionRow(mention, false));
  return View.vstack([
    View.text("Linear 提及", { style: "title", lineLimit: 1 }),
    View.text(statusFooterText(), {
      style: "caption",
      color: state.error ? "red" : "gray",
      lineLimit: 2
    }),
    ...rows
  ], { spacing: 6, align: "leading" });
}

function fullExpandedView() {
  const oauth = oauthSessionState();

  if (replyComposer) {
    return replyComposerView();
  }

  if (!oauth.connected) {
    const buttons = [
      View.button(
        View.text(oauth.expired ? "重新连接 Linear" : "使用 Linear 登录", {
          style: "caption",
          color: "blue",
          lineLimit: 1
        }),
        "login-linear"
      )
    ];

    if (oauth.session) {
      buttons.push(
        View.button(
          View.text("断开连接", { style: "caption", color: "gray", lineLimit: 1 }),
          "disconnect-linear"
        )
      );
    }

    return View.vstack([
      View.text("Linear 提及", { style: "title", lineLimit: 1 }),
      View.text(oauth.expired ? "您保存的 Linear 会话已过期，请重新开始 OAuth 授权。" : "授权 Linear 以在 Super Island 中接收提及。", {
        style: "caption",
        color: "gray",
        lineLimit: 2
      }),
      View.hstack(buttons, { spacing: 8, align: "center" })
    ], { spacing: 8, align: "leading" });
  }

  const rows = state.mentions.length > 0
    ? state.mentions.slice(0, 4).map((mention) => mentionRow(mention, true))
    : [
        View.text("暂无近期提及。", {
          style: "caption",
          color: "gray",
          lineLimit: 1
        })
      ];

  return View.vstack([
    View.hstack([
      View.text("Linear 提及", { style: "title", lineLimit: 1 }),
      View.spacer(),
      View.text(pollIntervalLabel(), { style: "footnote", color: "gray", lineLimit: 1 }),
      View.button(
        View.text("刷新", { style: "caption", color: "blue", lineLimit: 1 }),
        "refresh-now"
      ),
      View.button(
        View.text("重新同步（全部通知）", { style: "caption", color: "orange", lineLimit: 1 }),
        "resync-notify-all"
      )
    ], { spacing: 8, align: "center" }),
    View.text(statusFooterText(), {
      style: "caption",
      color: state.error ? "red" : "gray",
      lineLimit: 2
    }),
    ...rows
  ], { spacing: 8, align: "leading" });
}

SuperIsland.registerModule({
  onActivate() {
    startPolling();
  },

  onDeactivate() {
    stopPolling();
  },

  compact() {
    ensurePollIntervalCurrent();
    return compactView();
  },

  minimalCompact: {
    leading() {
      return View.icon("at", {
        size: 11,
        color: configuredAccessToken() ? "blue" : "gray"
      });
    },
    trailing() {
      if (replyComposer) {
        return View.icon("arrowshape.turn.up.left.fill", {
          size: 10,
          color: "blue"
        });
      }
      const count = state.mentions.length > 0 ? String(Math.min(state.mentions.length, 9)) : "";
      return count
        ? View.text(count, { style: "caption", color: "blue", lineLimit: 1 })
        : View.icon(configuredAccessToken() ? "checkmark.circle.fill" : "link.badge.plus", {
            size: 10,
            color: configuredAccessToken() ? "blue" : "gray"
          });
    }
  },

  expanded() {
    ensurePollIntervalCurrent();
    return expandedView();
  },

  fullExpanded() {
    ensurePollIntervalCurrent();
    return fullExpandedView();
  },

  onAction(actionID) {
    if (actionID === "login-linear") {
      SuperIsland.openURL(LINEAR_AUTHORIZE_URL);
      return;
    }

    if (actionID === "disconnect-linear") {
      SuperIsland.store.set("oauth", null);
      SuperIsland.store.set("linearBaselineReady", false);
      SuperIsland.store.set("linearTokenSignature", "");
      SuperIsland.store.set("seenMentionNotificationIDs", []);
      SuperIsland.store.set("pushedMentionKeys", []);
      closeReplyComposer();
      state = {
        status: "needsAuth",
        statusText: "连接 Linear 以开始关注提及。",
        error: "",
        connected: false,
        mentions: [],
        lastSyncAt: 0
      };
      return;
    }

    if (actionID === "refresh-now") {
      pollMentions(true);
      return;
    }

    if (actionID === "resync-notify-all") {
      console.log("[linear] resync-notify-all: clearing baseline so existing mentions fire");
      SuperIsland.store.set("linearBaselineReady", false);
      SuperIsland.store.set("pushedMentionKeys", []);
      pollMentions(true);
      return;
    }

    if (actionID === "open-reply") {
      openReplyComposer(arguments[1]);
      return;
    }

    if (actionID === "close-reply") {
      closeReplyComposer();
      const closed = typeof SuperIsland.system.closePresentedInteraction === "function"
        ? !!SuperIsland.system.closePresentedInteraction()
        : false;
      if (!closed) {
        pollMentions(true);
      }
      return;
    }

    if (actionID === "open-in-linear" && replyComposer) {
      const targetURL = replyComposer.commentURL || replyComposer.issueURL;
      if (targetURL) {
        SuperIsland.openURL(targetURL);
      }
      return;
    }

    if (actionID === "submit-reply") {
      submitReply(arguments[1]);
    }
  }
});
