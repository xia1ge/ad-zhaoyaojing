// 广告照妖镜弹窗：key 管理 + 今日战报 + 设置。
// 所有修改即时保存（与设置页各控件一一对应），无整体「保存」按钮。

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
const KIND_LABELS = { hard_ad: "硬广", soft_ad: "软广", lead_gen: "引流" };
const MAX_KEYWORDS = 30;

const state = {
  hasKey: false,
  apiUrl: DEFAULT_API_URL,
  dashboard: null,
  blockedKeys: new Set(), // 惯犯榜按钮展示需要，与黑名单列表同步
  authorsLoaded: false
};

init();

async function init() {
  const r = await send("getState").catch(() => null);
  if (!r?.ok) return;
  const s = r.settings;
  state.hasKey = r.hasKey;
  state.apiUrl = r.apiUrl || DEFAULT_API_URL;
  state.dashboard = r.dashboard;
  state.blockedKeys = new Set(s.blockedAuthors || []);

  // 各控件初值
  $("enabled").checked = s.enabled;
  document.body.classList.toggle("off", !s.enabled);
  $("smartMatch").checked = s.smartMatch;
  $("aiDetect").checked = s.aiDetect;
  $("authorProfiles").checked = s.authorProfiles;
  // 平台开关：老数据没有 sites 字段时，按"没关过"处理，默认都开
  $("wbOn").checked = s.sites?.weibo !== false;
  $("xhsOn").checked = s.sites?.xhs !== false;
  $("zhOn").checked = s.sites?.zhihu !== false;
  // 电商开关独立存（esites）：老数据没有该字段按"没关过"处理，默认都开
  $("tbOn").checked = s.esites?.taobao !== false;
  $("jdOn").checked = s.esites?.jd !== false;
  setSeg(document.querySelector('[data-name="mode"]'), s.mode);
  setSeg(document.querySelector('[data-name="threshold"]'), s.threshold);
  renderChips(s.keywords || []);
  customRules = Array.isArray(s.customRules) ? s.customRules : [];
  renderRules();
  blockRules = Array.isArray(s.blockListRules) ? s.blockListRules : [];
  renderBlockRules();

  $("apiUrl").value = state.apiUrl === DEFAULT_API_URL ? "" : state.apiUrl;
  if ($("apiUrl").value) $("apiDetails").open = true;
  renderKeycard("init");

  renderDashboard(r.dashboard);
  renderAuthorCount();
}

/* ---------- key 卡片 ---------- */

function renderKeycard(phase, info = {}) {
  const card = $("keyCard");
  const input = $("apiKey");
  const eye = $("eye");
  if (phase === "init") {
    card.dataset.state = state.hasKey ? "set" : "empty";
    if (state.hasKey) {
      $("keyTitle").textContent = "镜已开光";
      $("keyStatus").textContent = "";
      $("keyStatus").dataset.tone = "";
      $("keyFoot").hidden = true;
      input.placeholder = "key 已入镜 · 贴新的可换，留空提交即收回";
    } else {
      $("keyTitle").textContent = "镜还没开光";
      $("keyFoot").hidden = false;
      input.placeholder = "把 key 贴进镜心";
    }
    eye.hidden = true;
    return;
  }
  if (phase === "testing") {
    card.dataset.state = "testing";
    $("keyTitle").textContent = "开光中…";
    $("saveKey").disabled = true;
    $("saveKey").textContent = "开光中…";
    return;
  }
  if (phase === "done") {
    // info: {ok, error, prob, cleared}
    $("saveKey").disabled = false;
    $("saveKey").textContent = "开光";
    input.value = "";
    eye.hidden = true;
    const st = $("keyStatus");
    if (info.cleared) {
      state.hasKey = false;
      card.dataset.state = "empty";
      $("keyTitle").textContent = "镜还没开光";
      $("keyFoot").hidden = false;
      input.placeholder = "把 key 贴进镜心";
      st.textContent = "key 已收回，镜子先歇着。";
      st.dataset.tone = "set";
    } else if (info.ok) {
      state.hasKey = true;
      card.dataset.state = "set";
      $("keyTitle").textContent = "镜已开光";
      $("keyFoot").hidden = true;
      input.placeholder = "key 已入镜 · 贴新的可换，留空提交即收回";
      const pct = Math.round((info.prob ?? 0) * 100);
      st.textContent = `✓ 开光成功。拿测试句照了照，识破把握 ${pct}%。`;
      st.dataset.tone = "ok";
    } else {
      card.dataset.state = state.hasKey ? "set" : "empty";
      st.textContent = info.error || "验证失败";
      st.dataset.tone = "error";
    }
  }
}

$("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("apiKey").value.trim();
  // 留空：有 key 就清除，没有就提示
  if (!key) {
    if (!state.hasKey) {
      const st = $("keyStatus");
      st.textContent = "镜心还空着，先贴一个 key。";
      st.dataset.tone = "error";
      return;
    }
    const r = await send("saveSettings", { patch: { apiKey: "" } });
    if (r.ok) renderKeycard("done", { cleared: true });
    return;
  }
  renderKeycard("testing");
  const apiUrl = currentApiUrl();
  const r = await send("testKey", { apiKey: key, apiUrl, aiDetect: true }).catch(() => null);
  if (r?.ok) {
    await send("saveSettings", { patch: { apiKey: key, apiUrl } });
    renderKeycard("done", { ok: true, prob: r.prob });
  } else {
    renderKeycard("done", { ok: false, error: r?.error || "开光失败：看看网络，或换一条路试试" });
  }
});

// 有内容时才显示「显示/隐藏」按钮
$("apiKey").addEventListener("input", () => {
  $("eye").hidden = !$("apiKey").value;
});
$("eye").addEventListener("click", () => {
  const input = $("apiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("eye").textContent = show ? "隐藏" : "显示";
});

function currentApiUrl() {
  return $("apiUrl").value.trim() || (state.apiUrl !== DEFAULT_API_URL ? state.apiUrl : DEFAULT_API_URL);
}

/* ---------- 自定义接口地址 ---------- */

$("apiForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("apiStatus");
  const btn = $("saveApi");
  const url = $("apiUrl").value.trim() || DEFAULT_API_URL;
  btn.disabled = true;
  const r = await send("checkOrigin", { apiUrl: url }).catch(() => null);
  if (!r?.ok) {
    st.textContent = r?.error || "这条路不对，地址再检查一下";
    st.dataset.tone = "error";
    btn.disabled = false;
    return;
  }
  if (r.needsGrant) {
    const granted = await chrome.permissions.request({ origins: [r.origin + "/*"] }).catch(() => false);
    if (!granted) {
      st.textContent = "门没敲开：域名授权没给，地址先没换。";
      st.dataset.tone = "error";
      btn.disabled = false;
      return;
    }
  }
  const saved = await send("saveSettings", { patch: { apiUrl: url } });
  state.apiUrl = url;
  btn.disabled = false;
  if (saved.ok) {
    st.textContent = `✓ 已换上${r.needsGrant ? "，这条门也算敲开了" : ""}`;
    st.dataset.tone = "ok";
  } else {
    st.textContent = saved.error || "保存失败";
    st.dataset.tone = "error";
  }
});

/* ---------- 今日战报 ---------- */

function renderDashboard(d) {
  if (!d) return;
  const t = d.today || {};
  const checked = t.checked || 0;
  const ads = t.ads || 0;
  $("checked").textContent = checked;
  $("ads").textContent = ads;
  $("folded").textContent = t.folded || 0;
  $("rate").textContent = checked > 0 ? Math.round((ads / checked) * 100) + "%" : "–";
  $("copyReport").hidden = checked === 0;

  const kinds = $("kinds");
  const parts = [];
  for (const k of ["hard_ad", "soft_ad", "lead_gen"]) {
    const n = t.byKind?.[k] || 0;
    if (n > 0) parts.push(`${KIND_LABELS[k]} <b>${n}</b>`);
  }
  kinds.innerHTML = parts.join(" · ");
  kinds.hidden = !parts.length;

  const wanted = $("wanted");
  wanted.innerHTML = "";
  wanted.hidden = !(d.topAuthors || []).length;
  d.topAuthors.forEach((a, i) => {
    const li = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "wanted-rank";
    rank.textContent = String(i + 1);
    const name = document.createElement("span");
    name.className = "wanted-name";
    name.textContent = a.name;
    const stat = document.createElement("span");
    stat.className = "wanted-stat";
    stat.textContent = `${a.total} 条里 ${a.ads} 条是广告`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wanted-block";
    const blocked = state.blockedKeys.has(a.key);
    btn.textContent = blocked ? "已关" : "关起来";
    if (blocked) btn.disabled = true;
    else
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const r = await send("blockAuthor", { key: a.key });
        if (r.ok) {
          state.blockedKeys.add(a.key);
          btn.textContent = "已关";
        } else btn.disabled = false;
      });
    li.append(rank, name, stat, btn);
    wanted.append(li);
  });

  const total = d.total || {};
  const rt = $("reportTotal");
  rt.hidden = !(total.checked > 0);
  rt.textContent = `开镜以来共照 ${total.checked || 0} 条，${total.ads || 0} 条现形`;
}

$("copyReport").addEventListener("click", async () => {
  const d = state.dashboard;
  if (!d || !(d.today?.checked > 0)) return;
  const t = d.today;
  const lines = [
    "【广告照妖镜 · 照妖簿】",
    `今日照过 ${t.checked} 条，${t.ads} 条现了原形`
  ];
  const kinds = ["hard_ad", "soft_ad", "lead_gen"]
    .map((k) => (t.byKind?.[k] ? `${KIND_LABELS[k]} ${t.byKind[k]}` : null))
    .filter(Boolean);
  if (kinds.length) lines.push("细账：" + kinds.join(" · "));
  if (t.folded > 0) lines.push(`${t.folded} 条当场收走，眼不见为净`);
  (d.topAuthors || []).slice(0, 1).forEach((a) => lines.push(`头号惯犯：@${a.name}（${a.total} 条里 ${a.ads} 条是广告）`));
  lines.push("—— 照一照，广告现原形 · 免费浏览器插件「广告照妖镜」");
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    const btn = $("copyReport");
    const old = btn.textContent;
    btn.textContent = "已抄走 ✓";
    setTimeout(() => (btn.textContent = old), 1600);
  } catch {}
});

/* ---------- 分段控件 / 开关 ---------- */

document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn || btn.getAttribute("aria-checked") === "true") return;
    setSeg(seg, btn.dataset.value, true);
    if (seg.dataset.name === "mode") await send("saveSettings", { patch: { mode: btn.dataset.value } });
    if (seg.dataset.name === "threshold") await send("saveSettings", { patch: { threshold: Number(btn.dataset.value) } });
  });
});

function setSeg(el, value, animate = false) {
  const btns = [...el.querySelectorAll("button")];
  el.style.setProperty("--n", btns.length);
  const idx = Math.max(0, btns.findIndex((b) => b.dataset.value === String(value)));
  btns.forEach((b, i) => b.setAttribute("aria-checked", i === idx ? "true" : "false"));
  el.style.setProperty("--i", idx);
  if (!animate) {
    el.classList.add("no-anim");
    requestAnimationFrame(() => el.classList.remove("no-anim"));
  }
}

$("enabled").addEventListener("change", async (e) => {
  document.body.classList.toggle("off", !e.target.checked);
  await send("saveSettings", { patch: { enabled: e.target.checked } });
});
$("smartMatch").addEventListener("change", (e) => send("saveSettings", { patch: { smartMatch: e.target.checked } }));
$("aiDetect").addEventListener("change", (e) => send("saveSettings", { patch: { aiDetect: e.target.checked } }));
$("authorProfiles").addEventListener("change", (e) => send("saveSettings", { patch: { authorProfiles: e.target.checked } }));
// 平台开关：一次写入完整 sites 对象（后台是整键替换，不能只发半个）
function sendSites() {
  send("saveSettings", { patch: { sites: { weibo: $("wbOn").checked, xhs: $("xhsOn").checked, zhihu: $("zhOn").checked } } });
}
$("wbOn").addEventListener("change", sendSites);
$("xhsOn").addEventListener("change", sendSites);
$("zhOn").addEventListener("change", sendSites);

// 电商平台开关：独立键 esites，同样整键发送
function sendESites() {
  send("saveSettings", { patch: { esites: { taobao: $("tbOn").checked, jd: $("jdOn").checked } } });
}
$("tbOn").addEventListener("change", sendESites);
$("jdOn").addEventListener("change", sendESites);

/* ---------- 屏蔽关键词 ---------- */

let keywords = [];

function renderChips(list) {
  keywords = [...list];
  const ul = $("chips");
  ul.innerHTML = "";
  keywords.forEach((kw) => {
    const li = document.createElement("li");
    li.className = "chip";
    const span = document.createElement("span");
    span.textContent = kw;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", `摘掉「${kw}」`);
    del.addEventListener("click", () => {
      keywords = keywords.filter((k) => k !== kw);
      send("saveSettings", { patch: { keywords } });
      renderChips(keywords);
    });
    li.append(span, del);
    ul.append(li);
  });
}

$("kwInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  addKeyword();
});
$("kwInput").addEventListener("blur", addKeyword);

function addKeyword() {
  const input = $("kwInput");
  const val = input.value.trim().replace(/^,|,$/g, "");
  if (!val) return;
  if (keywords.length >= MAX_KEYWORDS) {
    input.value = "";
    return;
  }
  for (const kw of val.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (keywords.length >= MAX_KEYWORDS) break;
    if (!keywords.includes(kw)) keywords.push(kw);
  }
  input.value = "";
  send("saveSettings", { patch: { keywords } });
  renderChips(keywords);
}

/* ---------- 自定义网站：手写规则 ----------
   规则 = 一串 CSS 选择器（与内置微博/小红书规则同构），保存进 settings.customRules，
   content.js 按 host 匹配合并生效。key 用 "选择器@属性" 的字符串写法。 */

let customRules = [];
let ruleEditIndex = null; // null = 新建；数字 = 正在改哪条

// 示范：出厂自带 IT 之家两条的形状，点按钮填进表单，改改就能给别的站用
const RULE_EXAMPLES = {
  list: { host: "ithome.com", name: "IT之家 · 首页列表", item: "ul.nl li", title: "a", link: "a", key: "a@href", anchor: "a", fold: "collapse" },
  detail: { host: "ithome.com", name: "IT之家 · 文章页", item: "#dt .fl.content", author: "#author_baidu strong", title: "h1", text: "#paragraph", key: "h1", anchor: ".info .l", body: "#paragraph", veil: "self", fold: "blur" }
};

const RULE_FIELDS = ["host", "name", "item", "title", "text", "author", "link", "key", "anchor", "body", "veil"];
const ruleInput = (f) => $("r" + f[0].toUpperCase() + f.slice(1));

function renderRules() {
  const ul = $("ruleList");
  ul.innerHTML = "";
  if (!customRules.length) {
    const p = document.createElement("p");
    p.className = "rules-empty";
    p.textContent = "还没挂过别的站。往下填一条，或点示范按钮照抄。";
    ul.append(p);
    return;
  }
  customRules.forEach((r, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "rule-name";
    name.textContent = r.name || r.host;
    const sel = document.createElement("span");
    sel.className = "rule-sel";
    sel.textContent = `${r.host} → ${r.item}`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "rule-btn";
    edit.textContent = "改";
    edit.addEventListener("click", () => startEditRule(i));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rule-btn";
    del.textContent = "摘";
    del.addEventListener("click", async () => {
      del.disabled = true;
      const next = customRules.filter((_, j) => j !== i);
      const resp = await send("saveSettings", { patch: { customRules: next } }).catch(() => null);
      if (!resp?.ok) {
        del.disabled = false;
        return;
      }
      customRules = next;
      if (ruleEditIndex !== null) resetRuleForm();
      renderRules();
    });
    li.append(name, sel, edit, del);
    ul.append(li);
  });
}

function fillRuleForm(r) {
  for (const f of RULE_FIELDS) ruleInput(f).value = r[f] || "";
  $("rFold").value = r.fold || "";
  $("rPlacement").value = r.placement === "inside" ? "inside" : "after";
}

function resetRuleForm() {
  ruleEditIndex = null;
  for (const f of RULE_FIELDS) ruleInput(f).value = "";
  $("rFold").value = "";
  $("rPlacement").value = "";
  $("ruleFormCap").textContent = "新挂一个站 · 广告标识";
  $("ruleSave").textContent = "挂上";
  $("ruleReset").hidden = true;
}

function startEditRule(i) {
  const r = customRules[i];
  if (!r) return;
  ruleEditIndex = i;
  fillRuleForm(r);
  $("ruleFormCap").textContent = "改一条规矩 · 广告标识";
  $("ruleSave").textContent = "改好";
  $("ruleReset").hidden = false;
  $("ruleStatus").textContent = "";
}

$("ruleReset").addEventListener("click", resetRuleForm);
$("exList").addEventListener("click", () => fillRuleForm(RULE_EXAMPLES.list));
$("exDetail").addEventListener("click", () => fillRuleForm(RULE_EXAMPLES.detail));

// 选择器拼写当场验一遍，免得存出去到网页上才猜为什么没生效
function badSelector(sel) {
  if (!sel || sel === "self") return false; // veil 允许写 self（提示浮在整个条目上）
  try {
    document.createDocumentFragment().querySelector(sel);
    return false;
  } catch {
    return true;
  }
}

$("ruleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("ruleStatus");
  const rule = {};
  for (const f of RULE_FIELDS) {
    const v = ruleInput(f).value.trim();
    if (v) rule[f] = v;
  }
  if ($("rFold").value) rule.fold = $("rFold").value;
  if ($("rPlacement").value === "inside") rule.placement = "inside"; // after 是默认行为，不用存

  if (!rule.host || !rule.item) {
    st.textContent = "站点域名和内容条目必填。";
    st.dataset.tone = "error";
    return;
  }
  if (!rule.title && !rule.text) {
    st.textContent = "标题 / 正文选择器至少填一个，镜子才知道照什么。";
    st.dataset.tone = "error";
    return;
  }
  const keySel = rule.key && rule.key.includes("@") ? rule.key.slice(0, rule.key.lastIndexOf("@")) : rule.key;
  const bad = [rule.item, rule.title, rule.text, rule.author, rule.link, keySel, rule.anchor, rule.body, rule.veil].find(badSelector);
  if (bad) {
    st.textContent = `「${bad}」不是合法的 CSS 选择器，再核一核。`;
    st.dataset.tone = "error";
    return;
  }

  const btn = $("ruleSave");
  btn.disabled = true;
  const next = [...customRules];
  if (ruleEditIndex !== null && next[ruleEditIndex]) next[ruleEditIndex] = rule;
  else next.push(rule);
  const r = await send("saveSettings", { patch: { customRules: next } }).catch(() => null);
  btn.disabled = false;
  if (!r?.ok) {
    st.textContent = r?.error || "保存失败，再试一次。";
    st.dataset.tone = "error";
    return;
  }
  customRules = next;
  resetRuleForm();
  renderRules();
  st.textContent = "✓ 挂好了，刷新那个网站就开照。";
  st.dataset.tone = "ok";
});

/* ---------- 自定义网站：屏蔽文章列表（独立功能，不进照妖） ----------
   和上面的「广告标识」互不相干：这里只按关键词处理列表条目，
   撞词直接隐藏/模糊/淡化，不亮牌、不请求、不费 key。

   规则存进 settings.blockListRules：
   host/item/text = CSS 选择器；keywords = 词表；style = hide|blur|fade。 */

let blockRules = [];
let blockEditIndex = null; // null = 新建；数字 = 正在改哪条

const BLOCK_EXAMPLES = { list: { host: "ithome.com", name: "IT之家 · 屏蔽列表", item: "ul.nl li", text: "a", style: "hide" } };

function renderBlockRules() {
  const ul = $("blockList");
  ul.innerHTML = "";
  if (!blockRules.length) {
    const p = document.createElement("p");
    p.className = "rules-empty";
    p.textContent = "还没屏过哪个站的列表。往下填一条，或点示范照抄。";
    ul.append(p);
    return;
  }
  blockRules.forEach((r, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "rule-name";
    name.textContent = r.name || r.host;
    const sel = document.createElement("span");
    sel.className = "rule-sel";
    sel.textContent = `${r.host} → ${r.item} · ${(r.keywords || []).length} 词`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "rule-btn";
    edit.textContent = "改";
    edit.addEventListener("click", () => startEditBlock(i));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rule-btn";
    del.textContent = "摘";
    del.addEventListener("click", async () => {
      del.disabled = true;
      const next = blockRules.filter((_, j) => j !== i);
      const resp = await send("saveSettings", { patch: { blockListRules: next } }).catch(() => null);
      if (!resp?.ok) {
        del.disabled = false;
        return;
      }
      blockRules = next;
      if (blockEditIndex !== null) resetBlockForm();
      renderBlockRules();
    });
    li.append(name, sel, edit, del);
    ul.append(li);
  });
}

function fillBlockForm(r) {
  $("bHost").value = r.host || "";
  $("bName").value = r.name || "";
  $("bItem").value = r.item || "";
  $("bText").value = r.text || "";
  $("bStyle").value = r.style || "hide";
  $("bKeywords").value = (r.keywords || []).join("\n");
}

function resetBlockForm() {
  blockEditIndex = null;
  fillBlockForm({});
  $("blockFormCap").textContent = "新挂一个站 · 屏蔽列表";
  $("bSave").textContent = "屏掉";
  $("bReset").hidden = true;
}

function startEditBlock(i) {
  const r = blockRules[i];
  if (!r) return;
  blockEditIndex = i;
  fillBlockForm(r);
  $("blockFormCap").textContent = "改一条屏规 · 屏蔽列表";
  $("bSave").textContent = "屏好";
  $("bReset").hidden = false;
  $("bStatus").textContent = "";
}

$("bReset").addEventListener("click", resetBlockForm);
$("exBlock").addEventListener("click", () => fillBlockForm(BLOCK_EXAMPLES.list));

$("blockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("bStatus");
  const kws = $("bKeywords").value.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean).slice(0, 50); // 上限 50 个，防手滑贴一整篇
  const rule = {
    host: $("bHost").value.trim(),
    name: $("bName").value.trim(),
    item: $("bItem").value.trim(),
    text: $("bText").value.trim(),
    style: $("bStyle").value,
    keywords: kws,
  };
  if (!rule.host || !rule.item) {
    st.textContent = "站点域名和文章条目必填。";
    st.dataset.tone = "error";
    return;
  }
  if (!kws.length) {
    st.textContent = "总得填至少一个屏蔽关键词。";
    st.dataset.tone = "error";
    return;
  }
  if (badSelector(rule.item) || badSelector(rule.text)) {
    st.textContent = "「文章条目 / 取文字处」里有不合法的 CSS 选择器，再核一核。";
    st.dataset.tone = "error";
    return;
  }

  const btn = $("bSave");
  btn.disabled = true;
  const next = [...blockRules];
  if (blockEditIndex !== null && next[blockEditIndex]) next[blockEditIndex] = rule;
  else next.push(rule);
  const r = await send("saveSettings", { patch: { blockListRules: next } }).catch(() => null);
  btn.disabled = false;
  if (!r?.ok) {
    st.textContent = r?.error || "保存失败，再试一次。";
    st.dataset.tone = "error";
    return;
  }
  blockRules = next;
  resetBlockForm();
  renderBlockRules();
  st.textContent = "✓ 屏好了，刷新那个网站就生效。";
  st.dataset.tone = "ok";
});

/* ---------- 黑名单与作者档案 ---------- */

function renderAuthorCount() {
  $("authorCount").textContent = state.blockedKeys.size ? `· 关着 ${state.blockedKeys.size} 人` : "";
}

$("authorDetails").addEventListener("toggle", async (e) => {
  if (!e.target.open || state.authorsLoaded) return;
  const r = await send("getAuthors");
  if (!r.ok) return;
  state.authorsLoaded = true;
  renderAuthors(r.authors || []);
});

function renderAuthors(list) {
  const ul = $("authorList");
  ul.innerHTML = "";
  const shown = list.slice(0, 60);
  for (const a of shown) {
    const li = document.createElement("li");
    li.dataset.blocked = a.blocked ? "true" : "false";
    const name = document.createElement("span");
    name.className = "author-name";
    name.textContent = a.name;
    const stat = document.createElement("span");
    stat.className = "author-stat";
    stat.textContent = a.total > 0 ? `${a.total} 条里 ${a.ads} 条广告` : "还没过过镜";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "author-btn";
    btn.textContent = a.blocked ? "放出来" : "关起来";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = a.blocked
        ? await send("unblockAuthor", { key: a.key }).catch(() => null)
        : await send("blockAuthor", { key: a.key }).catch(() => null);
      if (!r?.ok) {
        btn.disabled = false;
        return;
      }
      a.blocked = !a.blocked;
      state.blockedKeys[a.blocked ? "add" : "delete"](a.key);
      li.dataset.blocked = a.blocked ? "true" : "false";
      btn.textContent = a.blocked ? "放出来" : "关起来";
      btn.disabled = false;
      if (state.dashboard) renderDashboard(state.dashboard);
      renderAuthorCount();
    });
    li.append(name, stat, btn);
    ul.append(li);
  }
  if (list.length > shown.length) {
    const p = document.createElement("p");
    p.className = "authors-empty";
    p.textContent = `后面还押着 ${list.length - shown.length} 位，只抄广告最多的`;
    ul.append(p);
  }
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "authors-empty";
    p.textContent = "册子还白着。照过几面，这里就会记下谁在发广告。";
    ul.append(p);
  }
}

/* ---------- 功能分页：照妖日报（默认）/ 社媒 / 自定义网站 / key 设置 / 小黑屋 ----------
   每次打开弹窗都从日报页看起（不记上次看的那页，战报最重要）。 */
const TABS = ["Report", "Social", "EC", "Custom", "Key", "Authors"];
function showTab(which) {
  for (const t of TABS) {
    const on = t === which;
    $("pane" + t).hidden = !on;
    $("tab" + t).setAttribute("aria-selected", on ? "true" : "false");
  }
}
for (const t of TABS) $("tab" + t).addEventListener("click", () => showTab(t));
