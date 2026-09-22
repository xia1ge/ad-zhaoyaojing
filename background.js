// 广告照妖镜后台。完全免费：用户填自己的 Jev (TypeSafe System One) key，
// 插件直连 api.typesafe.ai，不经过任何中间服务端，也没有额度/激活码。
//
// 除了判断广告（is_ad + kind），还可以按开关附带 AI 味打分（ai_ratio），
// 并维护本地统计（今日战报）和作者广告档案。

const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const MAX_CONCURRENT = 4;
const CACHE_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "label", // label | fold
  keywords: [], // 屏蔽关键词（字面匹配一定生效；smartMatch 时还交给 Jev 按意思匹配）
  smartMatch: true,
  threshold: 0.6,
  apiKey: "", // 用户自己的 Jev key（必填才能用）
  apiUrl: DEFAULT_API_URL, // 可自定义（中转/代理），默认官方直连
  aiDetect: true, // AI 味检测
  authorProfiles: true, // 作者广告档案（本地统计）
  sites: { weibo: true, xhs: true, zhihu: true }, // 社媒平台总开关；必须在 DEFAULT_SETTINGS 里登记，
  // 否则 storage.get(DEFAULT_SETTINGS) 会把这个键过滤掉：写进去也读不回来
  esites: { taobao: true, jd: true }, // 电商平台总开关（独立于社媒的 sites，同样要在这里登记）
  blockedAuthors: [], // 已拉黑作者（authorKey 列表，命中即本地折叠，不请求 Jev）
  // 自定义网站规则（弹窗里手写/改写）。字段全是字符串：选择器取 el.querySelector，
  // key 支持 "选择器@属性" 写法（content.js 合并时编译成函数）。出厂不带任何规则：
  // 弹窗「自定义」页有「示范」按钮（IT 之家形状），点一下填进表单，改改就能给别的站用
  customRules: [],
  // 屏蔽文章列表规则（独立功能，不进照妖）：撞到关键词的列表条目直接按 style 处理。
  // text 留空 = 用整条文字匹配；style: hide(隐藏) | blur(模糊) | fade(淡化)。
  // 出厂不带；弹窗「屏蔽列表」有「示范」按钮，关键词自己填
  blockListRules: []
};

// 判断问题打包在插件里，只有这里读一次
let promptPromise = null;
function loadPrompt() {
  promptPromise ??= fetch(chrome.runtime.getURL("prompt.json")).then((r) => r.json());
  return promptPromise;
}

// ---------- 设置 ----------

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return s;
}

// 发给内容脚本/弹窗的设置里不带 key
async function getPublicSettings() {
  const { apiKey, ...rest } = await getSettings();
  return rest;
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(s);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "zyj-check-selection",
      title: "用广告照妖镜识别选中文字",
      contexts: ["selection"]
    });
  });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(refreshBadge);

// ---------- 错误 ----------

// code: no_key | bad_key | network | upstream | other
class ZyjError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 直连 Jev ----------

function toJevState({ platform, comments, ...post }) {
  return comments?.length ? { platform, post, comments } : { platform, post };
}

// 底层：把 state + questions 发给 Jev，拿回原始 data（answers/model）。不读缓存、不记统计
async function postJev(state, questions, apiKey, apiUrl) {
  let res;
  try {
    res = await fetchWithTimeout(apiUrl || DEFAULT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: JEV_MODEL, state: toJevState(state), questions })
    });
  } catch {
    throw new ZyjError("network", "连不上 Jev（检查网络；大陆直连可能需要代理或中转地址）");
  }
  if (res.status === 401 || res.status === 403) throw new ZyjError("bad_key", "Jev key 无效或没有权限");
  if (res.status === 429) throw new ZyjError("network", "Jev 请求太频繁，稍等几秒再试");
  if (res.status >= 500) throw new ZyjError("upstream", "Jev 服务暂时不可用");
  if (!res.ok) throw new ZyjError("other", `Jev 请求失败（${res.status}）`);
  return res.json().catch(() => {
    throw new ZyjError("other", "Jev 返回了无法解析的内容（中转地址配置可能不对）");
  });
}

async function callJevDirect(state, apiKey, apiUrl, topics = [], aiDetect = true) {
  const prompt = await loadPrompt();
  const questions = {
    is_ad: prompt.questions.is_ad,
    kind: prompt.questions.kind
  };
  if (aiDetect) questions.ai_ratio = prompt.questions.ai_ratio;
  topics.forEach((t, i) => {
    questions[`topic_${i}`] = { type: "noul", instructions: prompt.topic_instructions.replaceAll("{topic}", t) };
  });

  const data = await postJev(state, questions, apiKey, apiUrl);
  const a = data.answers || {};
  // ai_ratio 是 0-4 五档 score，归一成 0-1 的「AI 味比例」
  const rawScore = typeof a.ai_ratio?.score === "number" ? a.ai_ratio.score : null;
  return {
    result: {
      prob: a.is_ad?.noul ?? 0,
      kind: a.kind?.choice ?? "organic",
      kindProbs: a.kind?.probabilities ?? {},
      aiRatio: aiDetect && rawScore !== null ? Math.min(1, Math.max(0, rawScore / 4)) : null,
      model: data.model
    },
    topics: Object.fromEntries(topics.map((t, i) => [t, a[`topic_${i}`]?.noul ?? 0]))
  };
}

// ---------- 判断：本地缓存 + 并发限制 ----------

const cache = new Map(); // hash -> result
const inflight = new Map(); // hash -> Promise

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + str.length;
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

let active = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  }
}

// 返回 { result, topics }；result.isAd 由消息层按阈值补上
async function classify(state, topics = [], authorKey = "") {
  const settings = await getSettings();
  if (!settings.apiKey) throw new ZyjError("no_key", "还没有填 Jev API key");
  if (!settings.enabled) throw new ZyjError("paused", "照妖镜已暂停");

  topics = [...new Set(topics.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
  const key = hash(JSON.stringify([state, [...topics].sort(), settings.aiDetect]));
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const run = () => callJevDirect(state, settings.apiKey, settings.apiUrl, topics, settings.aiDetect);
  const p = schedule(run)
    .then((r) => {
      remember(key, r);
      recordResult(r.result, r.result.prob >= settings.threshold, authorKey, settings);
      return r;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- 统计：今日战报 + 作者档案 ----------

function beijingDateStr(ts = Date.now()) {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}

// 串行写入，避免并发请求互相覆盖计数
let statsChain = Promise.resolve();
function recordResult(result, isAd, authorKey, settings) {
  statsChain = statsChain
    .then(async () => {
      const today = beijingDateStr();
      const store = await chrome.storage.local.get(["stats", "totalStats", "authors"]);
      const stats = store.stats || { date: today, checked: 0, ads: 0, byKind: {}, folded: 0 };
      if (stats.date !== today) {
        stats.date = today;
        stats.checked = 0;
        stats.ads = 0;
        stats.byKind = {};
        stats.folded = 0;
      }
      stats.checked++;
      if (isAd) {
        stats.ads++;
        stats.byKind[result.kind] = (stats.byKind[result.kind] || 0) + 1;
      }
      const totalStats = store.totalStats || { checked: 0, ads: 0 };
      totalStats.checked++;
      if (isAd) totalStats.ads++;

      const patch = { stats, totalStats };

      // 作者广告档案：只记名字非空的；不拉黑、只做档案
      if (authorKey && settings.authorProfiles) {
        const authors = store.authors || {};
        const a = authors[authorKey] || { name: "", total: 0, ads: 0, lastKind: "", lastAt: 0 };
        a.total++;
        if (isAd) {
          a.ads++;
          a.lastKind = result.kind;
        }
        a.lastAt = Date.now();
        authors[authorKey] = a;
        // 名字从 state 带过来（authors[key].name 用于黑名单 UI 展示）
        patch.authors = authors;
        trimAuthors(authors);
      }
      await chrome.storage.local.set(patch);
    })
    .then(refreshBadge)
    .catch(() => {});
}

function trimAuthors(authors) {
  const entries = Object.entries(authors);
  if (entries.length <= 600) return;
  entries.sort((x, y) => (x[1].lastAt || 0) - (y[1].lastAt || 0));
  for (let i = 0; i < entries.length - 500; i++) delete authors[entries[i][0]];
}

// 内容脚本每真正折叠一条广告/黑名单作者时上报一次
function reportFold() {
  const today = beijingDateStr();
  statsChain = statsChain
    .then(async () => {
      const { stats = { date: today, checked: 0, ads: 0, byKind: {}, folded: 0 } } = await chrome.storage.local.get("stats");
      if (stats.date !== today) return;
      stats.folded = (stats.folded || 0) + 1;
      await chrome.storage.local.set({ stats });
    })
    .catch(() => {});
}

// 徽标：暂停显示「停」，正常时显示今日识破数
async function refreshBadge() {
  try {
    const s = await getSettings();
    if (!s.enabled) {
      await chrome.action.setBadgeText({ text: "停" });
      await chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
      return;
    }
    const today = beijingDateStr();
    const { stats } = await chrome.storage.local.get("stats");
    const n = stats && stats.date === today ? stats.ads : 0;
    await chrome.action.setBadgeText({ text: n > 0 ? String(Math.min(n, 99)) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
  } catch {}
}

// 弹窗展示用：今日战报 + 惯犯榜
async function getDashboard() {
  const today = beijingDateStr();
  const { stats = { date: today, checked: 0, ads: 0, byKind: {}, folded: 0 }, totalStats = { checked: 0, ads: 0 }, authors = {} } =
    await chrome.storage.local.get(["stats", "totalStats", "authors"]);
  if (stats.date !== today) {
    stats.checked = 0;
    stats.ads = 0;
    stats.folded = 0;
    stats.byKind = {};
  }
  const topAuthors = Object.entries(authors)
    .filter(([, a]) => a.total >= 2 && a.ads > 0)
    .sort((x, y) => y[1].ads - x[1].ads || y[1].total - x[1].total)
    .slice(0, 3)
    .map(([key, a]) => ({ key, name: a.name || key.split("|").pop() || key, total: a.total, ads: a.ads }));
  return { today: stats, total: totalStats, topAuthors };
}

// ---------- 作者管理 ----------

async function setAuthorName(authorKey, name) {
  if (!authorKey || !name) return;
  const { authors = {} } = await chrome.storage.local.get("authors");
  const a = authors[authorKey] || { name: "", total: 0, ads: 0, lastKind: "", lastAt: 0 };
  if (!a.name) {
    a.name = name;
    authors[authorKey] = a;
    await chrome.storage.local.set({ authors });
  }
}

async function getAuthorList() {
  const { authors = {} } = await chrome.storage.local.get("authors");
  const { blockedAuthors = [] } = await getSettings();
  return Object.entries(authors)
    .map(([key, a]) => ({
      key,
      name: a.name || key.split("|").pop() || key,
      total: a.total,
      ads: a.ads,
      lastKind: a.lastKind,
      lastAt: a.lastAt,
      blocked: blockedAuthors.includes(key)
    }))
    .sort((x, y) => y.ads - x.ads || y.total - x.total);
}

async function toggleAuthorBlock(key, blocked) {
  const s = await getSettings();
  let list = [...new Set(s.blockedAuthors)];
  if (blocked) list.push(key);
  else list = list.filter((k) => k !== key);
  await chrome.storage.local.set({ blockedAuthors: list });
  return [...list];
}

// ---------- 消息 ----------

const errorResponse = (e) => ({
  ok: false,
  code: e instanceof ZyjError ? e.code : "other",
  error: String(e?.message || e)
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, (e) => sendResponse(errorResponse(e)));
    return true; // 异步回复
  };

  switch (msg?.type) {
    case "classify":
      return reply(
        (async () => {
          if (msg.authorKey && msg.author) await setAuthorName(msg.authorKey, msg.author);
          const { threshold } = await getSettings();
          const r = await classify(msg.state, msg.topics || [], msg.authorKey || "");
          return { ok: true, result: { ...r.result, isAd: r.result.prob >= threshold }, topics: r.topics };
        })()
      );
    case "getSettings":
      return reply(getPublicSettings());
    case "saveSettings": {
      // 弹窗保存设置。patch 里不含 apiKey 字段时不动 key；显式空串才会清空
      return reply(
        (async () => {
          const s = await getSettings();
          const patch = msg.patch || {};
          const allowed = ["enabled", "mode", "keywords", "smartMatch", "threshold", "apiKey", "apiUrl", "aiDetect", "authorProfiles", "customRules", "blockListRules", "sites", "esites"];
          for (const k of allowed) if (k in patch) s[k] = patch[k];
          await chrome.storage.local.set(s);
          refreshBadge();
          return { ok: true, settings: await getPublicSettings() };
        })()
      );
    }
    case "testKey":
      // 保存 key 前用一条明显广告做真实验证（同时验证自定义地址和问题格式）
      return reply(
        (async () => {
          if (!String(msg.apiKey || "").trim()) throw new ZyjError("bad_key", "key 不能为空");
          const r = await callJevDirect(
            { platform: "测试", post: { text: "限时5折！点击主页链接领取优惠券" } },
            String(msg.apiKey).trim(),
            msg.apiUrl || DEFAULT_API_URL,
            [],
            msg.aiDetect !== false
          );
          return { ok: true, prob: r.result.prob, model: r.result.model };
        })()
      );
    case "checkOrigin":
      // 自定义接口地址是否已有权限（api.typesafe.ai 本身在 manifest 里，永远可用）
      return reply(
        (async () => {
          let origin = null;
          try {
            origin = new URL(msg.apiUrl || DEFAULT_API_URL).origin;
          } catch {}
          if (!origin) return { ok: false, error: "接口地址格式不对" };
          if (origin === "https://api.typesafe.ai") return { ok: true, needsGrant: false, origin };
          const has = await chrome.permissions.contains({ origins: [origin + "/*"] });
          return { ok: true, needsGrant: !has, origin };
        })()
      );
    case "getState":
      // 弹窗打开时一把拿：公共设置 + 有没有 key + 今日战报
      return reply(
        (async () => {
          const s = await getSettings();
          const dash = await getDashboard();
          return { ok: true, settings: await getPublicSettings(), hasKey: Boolean(s.apiKey), apiUrl: s.apiUrl, dashboard: dash };
        })()
      );
    case "getAuthorStat":
      // 悬停徽标时展示某位作者的本地档案（近几条里几条广告）
      return reply(
        (async () => {
          if (!msg.key) return { ok: false };
          const { authors = {} } = await chrome.storage.local.get("authors");
          const a = authors[msg.key];
          if (!a) return { ok: true, stat: null };
          return { ok: true, stat: { name: a.name, total: a.total, ads: a.ads, lastKind: a.lastKind } };
        })()
      );
    case "getAuthors":
      return reply(getAuthorList().then((authors) => ({ ok: true, authors })));
    case "blockAuthor":
      return reply(toggleAuthorBlock(msg.key, true).then((blockedAuthors) => ({ ok: true, blockedAuthors })));
    case "unblockAuthor":
      return reply(toggleAuthorBlock(msg.key, false).then((blockedAuthors) => ({ ok: true, blockedAuthors })));
    case "reportFold":
      reportFold();
      return reply(Promise.resolve({ ok: true }));
  }
});

// ---------- 右键菜单：识别选中文字 ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "zyj-check-selection" || !tab?.id) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;
  try {
    const { result: r } = await classify({ platform: "用户选中文字", post: { text } });
    const { threshold } = await getSettings();
    chrome.tabs
      .sendMessage(tab.id, { type: "showToast", result: { ...r, isAd: r.prob >= threshold }, text })
      .catch(() => {});
  } catch (e) {
    chrome.tabs.sendMessage(tab.id, { type: "showToast", error: String(e?.message || e), code: e instanceof ZyjError ? e.code : "other" }).catch(() => {});
  }
});
