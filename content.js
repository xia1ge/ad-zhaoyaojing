(() => {
  // 防重入：popup 现场注入（chrome.scripting）兜底时，已挂着的镜子不要再来一遍
  if (window.__zyjInjected) return;
  window.__zyjInjected = true;
  // 排障横幅：F12 Console 里看到这行 = 新脚本确实注入了这个标签页（没这行 = 扩展没重载或页面没刷新）
  console.log("[照妖镜] 脚本已注入", location.host);

  const host = location.hostname;
  const isXhs = host.endsWith("xiaohongshu.com");
  const isWeibo = !isXhs && (host === "weibo.com" || host.endsWith(".weibo.com") || host === "weibo.cn" || host.endsWith(".weibo.cn"));
  const isZhihu = !isXhs && !isWeibo && (host === "zhihu.com" || host.endsWith(".zhihu.com"));
  // 淘宝/天猫一起照：淘宝搜索里大量商品详情页就是天猫域（detail.tmall.com），同一个购物流程
  const isTaobao = !isXhs && !isWeibo && !isZhihu && ((host === "taobao.com" || host.endsWith(".taobao.com")) || (host === "tmall.com" || host.endsWith(".tmall.com")));
  // 京东：item.jd.com 商品页评价区、product.jd.com 整页评价都在 jd.com 域下
  const isJd = !isXhs && !isWeibo && !isZhihu && !isTaobao && (host === "jd.com" || host.endsWith(".jd.com"));
  // 传给 Jev 的平台名：内置站点用中文名，自定义站点就用域名（用户/AI 在规则里可用 siteName 覆盖）
  const siteLabel = (h) => h.replace(/^www\./, "") || "网页";
  const platform = isXhs ? "小红书" : isWeibo ? "微博" : isZhihu ? "知乎" : isTaobao ? "淘宝" : isJd ? "京东" : siteLabel(host);
  // 作者档案 key 前缀（区分平台/站点同名作者）：自定义站点用域名变形
  const prefix = isXhs ? "xhs" : isWeibo ? "wb" : isZhihu ? "zh" : host.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "").slice(0, 16) || "site";

  // ---------- 自定义站点规则 ----------
  // 规则域名匹配：填 "ithome.com" 或 "*.ithome.com" 都算含全部子域名；也可以直接粘贴
  // 完整网址（自动剥掉协议和路径）："www.ithome.com" 这种带子域的则只精确匹配它自己
  function hostMatches(pattern, h) {
    const p = String(pattern || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const bare = p.startsWith("*.") ? p.slice(2) : p;
    if (!bare || !h) return false;
    return h === bare || h.endsWith("." + bare);
  }

  // 字符串形式的身份指纹，合并进 SITES 前编译成函数（内置规则用的就是函数形式）：
  // "a@href" → el 里 a 的 href；"@id" → el 自身的 id；"h1" → el 里 h1 的文字
  function compileKey(spec) {
    const at = spec.lastIndexOf("@");
    const sel = at >= 0 ? spec.slice(0, at) : spec;
    const attr = at >= 0 ? spec.slice(at + 1) : "";
    return (el) => {
      const t = sel ? el.querySelector(sel) : el;
      if (!t) return undefined;
      return attr ? t.getAttribute(attr) || "" : clean(t.textContent);
    };
  }

  // 每种内容容器：怎么取文本，徽标放哪里（anchor），折叠时遮哪里（body）。
  // placement: "after" 插在 anchor 后面（行内），"inside" 以浮层放进 anchor（用于瀑布流卡片，不能改变卡片高度）。
  // 内置站点的规则（代码特权：可以用函数形式的 key/enrich）；只在本站域名匹配时才会启用
  const XHS_SITES = [
        {
          name: "xhs-detail",
          item: "#noteContainer",
          author: ".author-wrapper .username",
          title: "#detail-title",
          text: "#detail-desc",
          comments: ".comment-item .note-text", // 评论是异步渲染的，取已经出现在页面上的
          // 身份：同一篇笔记、评论条数没变就不用重新读内容
          key: (el) => `${location.pathname}|${Math.min(el.querySelectorAll(".comment-item").length, 15)}`,
          anchor: ".author-wrapper .info .name",
          placement: "after",
          body: ".note-content, .media-container, .slider-container",
          veil: "self", // 左右分栏布局：提示浮在整个笔记中间，不插进布局里（图片区本身会被模糊，不能放在里面）
          fold: "blur", // 详情是用户主动点开的：模糊 + 提示，不折叠
          live: true // 同一个容器可能切换笔记
        },
        {
          name: "xhs-card",
          item: "section.note-item",
          author: ".author .name",
          title: ".footer .title",
          text: null,
          link: 'a.cover[href*="xsec_token"], a.title[href*="xsec_token"]', // 必须带 xsec_token，否则笔记页 404
          key: (el) => el.querySelector("a.cover")?.getAttribute("href"), // 瀑布流会复用卡片元素，换了笔记链接就会变
          enrich: fetchXhsNote, // 卡片只有标题：打开笔记页取正文和话题标签
          anchor: "a.cover",
          placement: "inside",
          body: "a.cover img, .footer .title",
          veil: "a.cover", // 提示盖在封面上
          fold: "cover" // 瀑布流按封面尺寸排版，卡片不能变矮：用底色盖住封面和标题
        }
  ];

  const WB_SITES = [
        {
          // weibo.com 新版（Vue，类名带哈希，按结构取）
          name: "weibo",
          item: "article.woo-panel-main",
          author: "header a[usercard] span[title]",
          title: null,
          text: ".wbpro-feed-ogText",
          repost: ".wbpro-feed-reText",
          key: (el) => el.querySelector('header a[class*="_time_"], header a[title*="-"]')?.getAttribute("href"), // 每条微博的链接
          marks: "header", // 平台的"广告"标记在头部
          fold: "collapse", // 微博的列表会重新量高度：真正折叠成一行
          anchor: 'header a[class*="_time_"], header a[title*="-"]',
          placement: "after",
          body: ".wbpro-feed-content"
        },
        {
          // s.weibo.com 搜索结果
          name: "weibo-search",
          item: 'div.card-wrap[action-type="feed_list_item"]',
          author: "a.name",
          title: null,
          text: 'p.txt[node-type="feed_list_content_full"], p.txt[node-type="feed_list_content"]',
          key: (el) => el.getAttribute("mid"),
          anchor: ".from > a:first-child",
          fold: "collapse",
          placement: "after",
          body: ".content"
        },
        {
          // m.weibo.cn 移动版
          name: "weibo-m",
          item: "div.card9",
          author: ".m-text-cut",
          title: null,
          text: ".weibo-text",
          anchor: ".m-text-box .time",
          fold: "collapse",
          placement: "after",
          body: ".weibo-og, .weibo-rp"
        }
  ];

  const ZHIHU_SITES = [
        {
          // 问题页（/question/…）的回答卡：标题在页头上，卡片里只有作者和正文
          name: "zhihu-answer",
          item: ".QuestionPage .AnswerItem, .QuestionPage .List-item",
          author: ".AuthorInfo .Name, .AuthorInfo .AuthorInfo-name", // 新旧版作者名的类不一样，都接
          title: null,
          text: ".RichContent-inner",
          key: (el) => el.getAttribute("data-aid") || el.getAttribute("name"),
          anchor: ".AuthorInfo .Name, .AuthorInfo .AuthorInfo-name",
          placement: "after",
          body: ".RichContent-inner",
          fold: "blur" // 回答是用户点开问题才看的：模糊 + 提示，不折叠
        },
        {
          // 首页/发现推荐流：滚动不断加载，卡片元素会复用，靠 data-zop（内容指纹）识别换没换内容
          name: "zhihu-feed",
          item: "div.TopstoryItem",
          author: ".AuthorInfo .Name, .AuthorInfo .AuthorInfo-name",
          title: ".ContentItem-title",
          text: ".RichContent-inner",
          key: (el) => el.getAttribute("data-zop"),
          anchor: ".ContentItem-actions > :last-child", // 挂到操作栏（赞同/评论/收藏/分享/更多）最末尾
          placement: "after",
          body: ".RichContent-inner",
          fold: "collapse", // 推荐流按内容量排版：折成一行最自然（照微博）
          live: true
        },
        {
          // 搜索结果页（/search?q=…）
          name: "zhihu-search",
          item: ".SearchResult-Card",
          author: ".AuthorInfo .Name, .AuthorInfo .AuthorInfo-name",
          title: ".ContentItem-title",
          text: ".RichContent-inner",
          key: (el) => el.querySelector(".ContentItem-title a")?.getAttribute("href"),
          anchor: ".ContentItem-actions > :last-child",
          placement: "after",
          body: ".RichContent-inner",
          fold: "collapse"
        },
        {
          // 专栏文章页（/p/…）：软文重灾区
          name: "zhihu-post",
          item: ".Post-Main",
          author: ".AuthorInfo .Name, .AuthorInfo .AuthorInfo-name",
          title: ".Post-Title",
          text: ".Post-RichTextContainer",
          key: () => location.pathname, // 知乎是 SPA：换个路径就是换篇文章
          anchor: ".AuthorInfo .Name, .AuthorInfo .AuthorInfo-name",
          placement: "after",
          body: ".Post-RichTextContainer",
          fold: "blur", // 文章是用户点开看的：模糊 + 提示
          live: true
        }
  ];

  // 电商评价卡没有稳定的容器类名（CSS Modules 哈希后缀），从名字节点往上收（淘宝/京东通用）：
  // 父层一旦装进了第二个名字（隔壁评论），脚下这层就是本条评论的卡
  function tbCardOf(nameEl, nameSel = '[class*="userName"]') {
    let el = nameEl;
    while (el.parentElement && el.parentElement.querySelectorAll(nameSel).length === 1) {
      if (el.parentElement === document.body) break; // 爬到 body 门前：整页只有这一条评论，脚下这层就是它的卡
      el = el.parentElement;
      if (el.textContent.length > 4000) return null; // 走飞了：这一层已经不是评论卡
    }
    return el.parentElement && el !== document.body ? el : null;
  }

  // 评论正文：候选节点里文字最长者；嵌套候选只认最内层（外层容器如 CommentItem
  // 也带 comment 字样，会把昵称一起吞进来顶掉干净正文）；全对不上退整卡文字
  function tbTextOf(el) {
    // 先展开成数组：NodeList 只有 forEach 没有 some/map 这些数组方法，
    // 直接 hits.some 会在浏览器里抛 TypeError（京东走 jdTextOf 不经过这里，淘宝曾因此全灭）
    const hits = [...el.querySelectorAll('[class*="content"], [class*="Content"], [class*="comment"], [class*="Comment"], p')];
    let best = "";
    hits.forEach((n) => {
      if (hits.some((m) => m !== n && n.contains(m))) return; // 是别的候选的祖先：让内层说话
      const t = clean(n.textContent);
      if (t.length > best.length) best = t;
    });
    if (!best) {
      const whole = clean(el.textContent);
      if (whole.length >= 6) best = whole; // 类名全对不上才退整卡（整卡文字带昵称，不作首选）
    }
    return best;
  }

  const TB_SITES = [
        {
          // 淘宝/天猫商品页评价区（含"查看全部评价"的整页列表）。类名带哈希后缀
          // （userName--KpyzGX2s），一律用 [class*=] 抗变；容器没有稳定类名，用函数逐卡定位
          name: "taobao-rate",
          item: () =>
            [...new Set(
              [...document.querySelectorAll('[class*="userName"]')]
                .map((n) => {
                  const card = tbCardOf(n);
                  return card && tbTextOf(card).length >= 6 ? card : null; // 没正文的（页头/导航）不算评论
                })
                .filter(Boolean)
            )],
          author: '[class*="userName"]',
          text: (el) => tbTextOf(el),
          key: (el) => `${el.querySelector('[class*="userName"]')?.textContent.trim() || "?"}|${tbTextOf(el).slice(0, 80)}`,
          platform: "淘宝", // 传给 Jev：电商评论场景（prompt 里有好评返现/刷评的判定标准）
          prefix: "tb",
          // 徽标文案按场景特化：评论里不叫"软广"，叫"疑似刷评"
          labels: { hard_ad: "水军", soft_ad: "疑似刷评", lead_gen: "引流", organic: "真实评论", ok: "真实评论" },
          anchor: '[class*="userName"]', // 徽标跟在名字后面
          placement: "after",
          body: (el) => {
            const n = el.querySelector('[class*="content"], [class*="Content"]');
            if (n) return [n];
            // 类名全变了：模糊卡里除名字行以外的部分，徽标留在名字旁不被模糊
            return [...el.children].filter((ch) => !ch.querySelector('[class*="userName"]') && !ch.matches('[class*="userName"]'));
          },
          fold: "blur", // 判成刷评：模糊这条评论，点徽标放出来
          live: true // 评价区滚动加载、React 会整卡重挂：内容变了（key 变）就重判，结果有缓存不重复计费
        }
  ];

  // 京东评价卡的正文跟淘宝分开提：真评论在 rate-card-main-desc 里；卡里其它带
  // content 字样的节点（jd-content-pc-tag 购买徽标、jd-content-pc-media-list 晒图区）
  // 都不是正文，通用爬法会让徽标顶掉正文。main-desc 命中就信它——短说明这条评价
  // 本来就短；类名再换代才退回通用爬法兜底
  function jdTextOf(card) {
    let best = "";
    card.querySelectorAll('[class*="main-desc"]').forEach((n) => {
      const t = clean(n.textContent);
      if (t.length > best.length) best = t;
    });
    if (best) return best;
    return tbTextOf(card);
  }

  // 京东：item.jd.com 商品页评价区、product.jd.com 整页评价（都在 jd.com 域下）。
  // 名字节点三类写法并收：card-nick 是真实类名 jdc-pc-rate-card-nick 的中段子串（抗
  // jdc-pc / jdc-m 整个前缀换代）；user-name / userName 是 DOM 惯用写法，兜其它京东页面
  const JD_USER = '[class*="card-nick"], [class*="user-name"], [class*="userName"]';
  const JD_SITES = [
        {
          name: "jd-rate",
          item: () =>
            [...new Set(
              [...document.querySelectorAll(JD_USER)]
                .map((n) => {
                  const card = tbCardOf(n, JD_USER);
                  return card && jdTextOf(card).length >= 6 ? card : null; // 没正文的（页头/导航）不算评论
                })
                .filter(Boolean)
            )],
          author: JD_USER,
          text: (el) => jdTextOf(el),
          key: (el) => `${el.querySelector(JD_USER)?.textContent.trim() || "?"}|${jdTextOf(el).slice(0, 80)}`,
          platform: "京东", // 传给 Jev：跟淘宝同款电商评论口径（好评返现/刷单水军/AI 批量）
          prefix: "jd",
          labels: { hard_ad: "水军", soft_ad: "疑似刷评", lead_gen: "引流", organic: "真实评论", ok: "真实评论" },
          anchor: JD_USER, // 徽标跟在名字后面（与淘宝同位）
          placement: "after",
          body: (el) => {
            // 折叠域直击正文区（rate-card-main 罩住正文）；不搜 *content*：购买徽标
            // jd-content-pc-tag 也带 content 字样且排在名字区最前，会错把徽标当折叠域
            const n = el.querySelector('[class*="rate-card-main"], [class*="main-desc"]');
            if (n) return [n];
            // 类名全变了：模糊卡里除名字行以外的部分，徽标留在名字旁不被模糊
            return [...el.children].filter((ch) => !ch.querySelector(JD_USER) && !ch.matches(JD_USER));
          },
          fold: "blur", // 判成刷评：模糊这条评论，点徽标放出来
          live: true // 评价区滚动加载、整卡重挂：内容变了（key 变）就重判
        }
  ];

  // 本站实际生效的规则：内置名单（小红书/微博/知乎/淘宝/京东）+ 弹窗里存的自定义规则，buildSites() 运行时确定；
  // 没有规则时整个脚本静默待命（页面完全不受影响）。
  let SITES = [];

  function buildSites() {
    // 内置名单跟着弹窗的平台开关走：没关过（老数据缺 sites 字段）默认都照
    const on = (p) => settings.sites?.[p] !== false;
    const eOn = (p) => settings.esites?.[p] !== false; // 电商平台开关独立存（esites），跟社媒互不干扰
    const builtIn = isXhs && on("xhs") ? XHS_SITES.slice() : isWeibo && on("weibo") ? WB_SITES.slice() : isZhihu && on("zhihu") ? ZHIHU_SITES.slice() : isTaobao && eOn("taobao") ? TB_SITES.slice() : isJd && eOn("jd") ? JD_SITES.slice() : [];
    SITES = builtIn.concat(
      (settings.customRules || [])
        .filter((r) => r && r.item && hostMatches(r.host, host))
        .map((r) => ({ ...r, key: typeof r.key === "string" && r.key ? compileKey(r.key) : r.key }))
    );
  }

  // ---------- 独立的屏蔽文章列表（不进照妖流程：不请求、不亮牌，撞词由 CSS 直接处理） ----------
  // 每条规则 = { host, item, text(可空，留空用整条文字), keywords[], style: hide|blur|fade }
  let BLOCK_LIST = [];

  function buildBlockList() {
    BLOCK_LIST = (settings.blockListRules || []).filter(
      (r) => r && r.item && Array.isArray(r.keywords) && r.keywords.length > 0 && hostMatches(r.host, host)
    );
  }

  function applyBlockList() {
    if (!settings.enabled || !BLOCK_LIST.length) return;
    for (const b of BLOCK_LIST) {
      document.querySelectorAll(b.item).forEach((el) => {
        if (el.dataset.zyjBlock || el.parentElement?.closest(b.item)) return; // 屏过了 / 嵌套子条目
        let hay = "";
        try {
          // text 指定撞词看哪段文字（可能好几处，拼一起）；留空就用整条的文字
          hay = b.text ? [...el.querySelectorAll(b.text)].map((n) => n.textContent).join(" ") : el.textContent || "";
        } catch {
          return; // text 选择器写坏了：这一条先跳过
        }
        hay = hay.toLowerCase();
        for (const k of b.keywords) {
          if (typeof k === "string" && k.trim() && hay.includes(k.toLowerCase())) {
            el.dataset.zyjBlock = b.style || "hide"; // 纯 CSS 拿 data-zyj-block 生效，不走徽标
            return;
          }
        }
      });
    }
  }

  const KIND = {
    hard_ad: "硬广",
    soft_ad: "软广",
    lead_gen: "引流",
    organic: "非广告"
  };
  const AI_SHOW = 0.5; // 徽标上显示 AI 味的门槛
  const AI_TIP = 0.4; // 悬停浮层里显示 AI 味的门槛

  let settings = { enabled: true, mode: "label", keywords: [], smartMatch: true, blockedAuthors: [], aiDetect: true, authorProfiles: true, customRules: [], blockListRules: [], sites: { weibo: true, xhs: true, zhihu: true }, esites: { taobao: true } };
  // 按意思匹配关键词的门槛：实测"只是顺带提到"大约在 0.7 左右，0.8 以上才算真的相关
  const TOPIC_THRESHOLD = 0.8;
  const foldAds = () => settings.mode === "fold" || settings.mode === "blur"; // blur 是旧版本的设置名

  // 字面匹配屏蔽关键词（不区分大小写），包括微博转发的原文和话题标签
  function keywordHits(state) {
    const kws = (settings.keywords || []).filter((k) => typeof k === "string" && k.trim()); // 存储里可能有脏数据
    if (!kws.length || !state) return [];
    const hay = [state.author, state.title, state.text, state.reposted, (state.tags || []).join(" ")]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return kws.filter((k) => hay.includes(k.toLowerCase()));
  }

  const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- 取内容 ----------
  // 用 textContent 而不是 innerText：innerText 每次都会强制浏览器重新排版，内容多时会拖慢页面
  const clean = (t) => t.replace(/[ \t\u00a0\u200b]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const textOf = (root, sel) => {
    if (!sel) return "";
    if (typeof sel === "function") return clean(String(sel(root) || "")); // 淘宝这类拿不到稳定类名的站点：函数自己算
    const el = root.querySelector(sel);
    return el ? clean(el.textContent) : "";
  };

  function extract(el, site) {
    const state = { platform: site.platform || platform };
    const author = textOf(el, site.author);
    const title = textOf(el, site.title);
    const text = textOf(el, site.text).slice(0, 3000);
    const repost = textOf(el, site.repost).slice(0, 1500);
    if (!title && text.length < 4) return null;
    if (author) state.author = author.slice(0, 60);
    if (title) state.title = title.slice(0, 200);
    if (text) state.text = text;
    if (repost) state.reposted = repost;
    if (site.link) state.link = el.querySelector(site.link)?.getAttribute("href") || undefined;
    if (site.comments) {
      const comments = [...el.querySelectorAll(site.comments)]
        .map((n) => clean(n.textContent).slice(0, 200))
        .filter(Boolean)
        .slice(0, 15);
      if (comments.length) state.comments = comments;
    }
    // 平台自己打的"广告/推广"等标记，也交给模型参考
    const marks = new Set();
    const scope = (site.marks && el.querySelector(site.marks)) || el;
    scope.querySelectorAll("span, i, em").forEach((n) => {
      if (n.childElementCount) return;
      const t = n.textContent.trim();
      if (/^(广告|推广|赞助|品牌合作|商品|好物推荐|合作)$/.test(t)) marks.add(t);
    });
    if (marks.size) state.page_labels = [...marks].join("、");
    return state;
  }

  // ---------- 小红书笔记正文 ----------
  // 和正常打开笔记一样请求笔记页，从服务端渲染的 __INITIAL_STATE__ 里取正文和标签；
  // 限制并发、按笔记缓存，只对滚到视口附近的卡片请求。
  const noteCache = new Map();
  let noteActive = 0;
  const noteQueue = [];

  function fetchXhsNote(state) {
    if (!state.link) return Promise.resolve(state);
    const id = state.link.match(/explore\/([0-9a-f]+)/)?.[1] || state.link;
    if (!noteCache.has(id)) {
      noteCache.set(
        id,
        new Promise((resolve) => {
          noteQueue.push({ url: state.link, id, resolve });
          pumpNotes();
        })
      );
    }
    return noteCache.get(id).then((note) => {
      const { link, ...rest } = state;
      if (!note) return { ...rest, note: "信息流卡片，只取到了标题" };
      return {
        ...rest,
        title: note.title || rest.title,
        text: note.desc,
        tags: note.tags.length ? note.tags : undefined,
        note_type: note.type === "video" ? "视频笔记" : "图文笔记"
      };
    });
  }

  function pumpNotes() {
    while (noteActive < 2 && noteQueue.length) {
      const { url, id, resolve } = noteQueue.shift();
      noteActive++;
      loadNote(url, id)
        .catch(() => null)
        .then((note) => {
          if (!note) noteCache.delete(id); // 失败的下次再试
          resolve(note);
        })
        .finally(() => {
          noteActive--;
          pumpNotes();
        });
    }
  }

  async function loadNote(url, id) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok || /\/404\b/.test(new URL(res.url).pathname)) return null; // 笔记不可见时会跳到 404 页
    const html = await res.text();
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1].replace(/\bundefined\b/g, "null"));
    const map = data?.note?.noteDetailMap || {};
    const note = (map[id] || Object.values(map)[0])?.note;
    if (!note?.desc && !note?.title) return null;
    return {
      title: note.title || "",
      desc: (note.desc || "").slice(0, 3000),
      tags: (note.tagList || []).map((t) => t.name).filter(Boolean).slice(0, 20),
      type: note.type
    };
  }

  // ---------- 徽标 ----------
  function mountBadge(el, site) {
    let b = el.__zyjBadge;
    if (b && b.isConnected) return b;
    const anchor = site.anchor && el.querySelector(site.anchor);
    b = document.createElement("span");
    b.className = "zyj-badge";
    b.dataset.placement = anchor ? site.placement : "inside";
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    if (!anchor) {
      el.classList.add("zyj-host");
      el.appendChild(b);
    } else if (site.placement === "inside") {
      anchor.classList.add("zyj-host");
      anchor.appendChild(b);
    } else {
      anchor.after(b);
    }
    // 徽标可能放在链接里（小红书卡片封面），点击不能触发跳转
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setRevealed(el, !el.classList.contains("zyj-reveal"));
    });
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("mouseenter", () => tip.show(b));
    b.addEventListener("mouseleave", () => tip.hide());
    b.addEventListener("focus", () => tip.show(b));
    b.addEventListener("blur", () => tip.hide());
    el.__zyjBadge = b;
    return b;
  }

  function setBadge(b, state, label, aiRatio) {
    b.dataset.state = state;
    // AI 味达标时在主文案后面带一个小尾巴
    const ai = aiRatio != null && aiRatio >= AI_SHOW ? `<span class="zyj-ai" title="AI 生成/润色的可能性">AI ${Math.round(aiRatio * 100)}%</span>` : "";
    b.innerHTML = escapeHtml(label) + ai;
  }

  // 各类失败在徽标上的文字
  const ERROR_LABEL = {
    upstream: "暂不可用",
    network: "连不上",
    bad_key: "key 无效",
    no_key: "未设置 key",
    paused: "已暂停"
  };
  const RETRY_AFTER_MS = 60_000;

  function render(el, site, res) {
    const b = mountBadge(el, site);
    el.classList.remove("zyj-ad");
    b.__zyjResult = res;
    b.__zyjLiteral = el.__zyjLiteral || [];
    if (!res || !res.ok) {
      if (res && res.code === "no_key") {
        setBadge(b, "no_key", ERROR_LABEL.no_key);
        if (!noKeyTipped) {
          noKeyTipped = true;
          toast("error", "还没填 Jev API key · 点浏览器右上角的照妖镜图标，一分钟设置", 6000);
        }
        return;
      }
      setBadge(b, "error", ERROR_LABEL[res?.code] || "检测失败");
      applyFold(el, site, null); // 字面命中的关键词照样折叠
      return;
    }
    const r = res.result;
    const pct = Math.round(r.prob * 100);
    const L = site.labels || KIND; // 淘宝评论这类场景有自己的文案（疑似刷评/真实评论）
    if (r.isAd) {
      const kind = r.kind === "organic" ? "广告" : L[r.kind] || "广告";
      setBadge(b, "ad", `${kind} ${pct}%`, r.aiRatio);
      el.classList.add("zyj-ad");
    } else if (matchedKeywords(el, res).length) {
      setBadge(b, "kw", `屏蔽 · ${matchedKeywords(el, res)[0]}`);
    } else {
      setBadge(b, "ok", L.ok || "非广告", r.aiRatio); // 不是广告但 AI 味重，也照出来
    }
    applyFold(el, site, res);
  }

  // 拉黑作者：本地直接折叠，不请求 Jev
  function renderAuthorBlocked(el, site, author) {
    const b = mountBadge(el, site);
    el.classList.remove("zyj-ad");
    b.__zyjResult = null;
    el.__zyjAuthor = author;
    el.__zyjLiteral = [];
    setBadge(b, "blocked", "已拉黑");
    applyFold(el, site, null, { label: `已拉黑「${author}」的内容` });
  }

  // 字面命中 + 按意思命中的关键词
  function matchedKeywords(el, res) {
    const semantic = Object.entries(res?.topics || {})
      .filter(([, p]) => p >= TOPIC_THRESHOLD)
      .map(([k]) => k);
    const all = [...(el.__zyjLiteral || []), ...semantic];
    return all.filter((k, i) => all.findIndex((x) => x.toLowerCase() === k.toLowerCase()) === i);
  }

  // ---------- 折叠：广告（折叠模式下）或命中屏蔽关键词/拉黑作者的内容 ----------

  // 用户展开过的内容（按内容签名记），页面重新渲染后不再折叠
  const revealed = new Set();

  // extra 供"拉黑作者"这类本地折叠自定义提示文案
  function applyFold(el, site, res, extra) {
    const r = res?.ok ? res.result : null;
    const kws = matchedKeywords(el, res);
    const adFold = r?.isAd && foldAds();
    if (!kws.length && !adFold && !extra) return unfold(el);

    const why = [];
    if (extra) why.push(extra.label);
    else if (r?.isAd) why.push(`${r.kind === "organic" ? "广告" : KIND[r.kind] || "广告"} ${Math.round(r.prob * 100)}%`);
    if (kws.length) why.push(`含「${kws.slice(0, 3).join("、")}」`);
    const style = site.fold || "blur";
    const lead = style === "collapse" ? "已折叠" : style === "cover" ? "已隐藏" : "已模糊";
    const who = style === "collapse" && el.__zyjAuthor ? [el.__zyjAuthor] : [];

    const willShow = revealed.has(sent.get(el));
    const wasFolded = el.classList.contains("zyj-fold") && !el.classList.contains("zyj-reveal");
    const commit = () => {
      markBody(el, site);
      el.classList.add("zyj-fold");
      el.dataset.zyjFold = style;
      el.classList.toggle("zyj-reveal", willShow);
      const v = mountVeil(el, site);
      if (v) {
        v.querySelector(".zyj-veil-text").textContent = [lead, ...who, ...why].join(" · ");
        v.setAttribute("aria-label", `${[lead, ...why].join("，")}，点击展开`);
      }
      if (!el.__zyjFoldReported) {
        el.__zyjFoldReported = true;
        send({ type: "reportFold" }, () => {}); // 计入今日战报
      }
    };
    // 正在屏幕里的内容被折叠时才做动画；屏幕外的直接折好（用户看不到，也不会让正在读的内容跳动）
    if (style === "collapse" && !wasFolded && !willShow && !el.__zyjFolding && inView(el) && !reduceMotion()) {
      foldInPlace(el, commit);
    } else if (!el.__zyjFolding) {
      commit();
    }
    if (!el.__zyjClick) {
      // 捕获阶段拦截：点被折叠的区域只负责展开，不触发原来的跳转或点击事件
      el.__zyjClick = (e) => {
        if (!el.classList.contains("zyj-fold") || el.classList.contains("zyj-reveal")) return;
        if (!e.target.closest(".zyj-body, .zyj-veil")) return;
        e.preventDefault();
        e.stopPropagation();
        setRevealed(el, true);
      };
      el.addEventListener("click", el.__zyjClick, true);
    }
  }

  function unfold(el) {
    el.__zyjAnim?.cancel();
    el.classList.remove("zyj-fold", "zyj-reveal");
    delete el.dataset.zyjFold;
    el.__zyjVeil?.remove();
    el.__zyjVeil = null;
  }

  // 用户点击展开 / 点徽标重新折叠
  function setRevealed(el, on) {
    const sig = sent.get(el);
    if (sig) on ? revealed.add(sig) : revealed.delete(sig);
    const toggle = () => el.classList.toggle("zyj-reveal", on);
    if (el.dataset.zyjFold !== "collapse") {
      toggle(); // 盖住、模糊两种样式由 CSS 过渡（只动透明度和模糊）
    } else if (reduceMotion()) {
      toggle();
      if (on) fadeIn(foldContent(el), 150, 0);
    } else if (on) {
      unfoldReveal(el, toggle); // 展开：从折叠栏的位置往下打开，内容稍后淡入
    } else {
      foldConceal(el, toggle, 180); // 重新折叠：比展开快一点
    }
    if (!on) el.__zyjVeil?.focus({ preventScroll: true });
  }

  // ---------- 折叠动画 ----------

  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"; // 出现、展开

  const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.height > 0;
  };
  const foldContent = (el) => [...el.children].filter((c) => !c.classList.contains("zyj-veil"));
  const fadeIn = (els, duration, delay) =>
    els.forEach((c) => c.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing: "ease", fill: "backwards" }));

  // 为什么不直接动画高度：微博的信息流是虚拟列表，要等下一两帧才重新排版，
  // 高度逐帧变化时下面那条跟不上，会被盖住（实测最多重叠 255px），每帧还会触发整页重排。
  // 所以高度一步到位，只用 clip-path 做"从上往下打开 / 从下往上收起"的可见范围动画。
  const BAR_HEIGHT = 44;
  const radius = (el) => getComputedStyle(el).borderTopLeftRadius || "0px";
  const clipTo = (el, hidden) => `inset(0 0 ${Math.max(0, hidden)}px 0 round ${radius(el)})`;
  // 正在进行的裁切动画的当前位置（打断时从这里接着动）
  const currentClip = (el) => {
    const c = el.__zyjAnim ? getComputedStyle(el).clipPath : "none";
    return c && c !== "none" ? c : null;
  };

  function unfoldReveal(el, toggle) {
    const interrupted = currentClip(el); // 正在收起时又点了展开：从当前位置接着打开
    el.__zyjAnim?.cancel();
    toggle();
    const full = el.getBoundingClientRect().height;
    const start = interrupted || clipTo(el, full - BAR_HEIGHT);
    const a = el.animate([{ clipPath: start }, { clipPath: clipTo(el, 0) }], { duration: 260, easing: EASE_OUT });
    track(el, a);
    fadeIn(foldContent(el), 200, 60);
  }

  // 收起：可见范围收到一行、内容淡出，然后才真正折叠（下面的内容补上来）
  function foldConceal(el, commit, duration) {
    const full = el.getBoundingClientRect().height;
    const from = currentClip(el) || clipTo(el, 0);
    el.__zyjAnim?.cancel();
    const a = el.animate([{ clipPath: from }, { clipPath: clipTo(el, full - BAR_HEIGHT) }], {
      duration,
      easing: EASE_IN_OUT,
      fill: "forwards"
    });
    track(el, a);
    const fades = foldContent(el).map((c) =>
      c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(120, duration), easing: "ease", fill: "forwards" })
    );
    el.__zyjFolding = true;
    a.finished
      .then(
        () => {
          commit();
          if (el.__zyjVeil) fadeIn([el.__zyjVeil], 160, 0);
        },
        () => {} // 动画被打断：交给新的动画；commit 里的错误不吞掉
      )
      .finally(() => {
        el.__zyjFolding = false;
        a.cancel();
        fades.forEach((f) => f.cancel());
      });
  }

  function track(el, a) {
    el.__zyjAnim = a;
    const done = () => el.__zyjAnim === a && (el.__zyjAnim = null);
    a.onfinish = done;
    a.oncancel = done;
  }

  // 屏幕里的内容被自动折叠
  function foldInPlace(el, commit) {
    foldConceal(el, commit, 240);
  }

  function mountVeil(el, site) {
    if (el.__zyjVeil?.isConnected) return el.__zyjVeil;
    const style = site.fold || "blur";
    // 提示不能放在被模糊的元素里面，否则自己也会被模糊
    const host = style === "collapse" ? null : site.veil === "self" ? el : site.veil && el.querySelector(site.veil);
    const first = el.querySelector(".zyj-body");
    const v = document.createElement("button");
    v.type = "button";
    v.className = "zyj-veil";
    v.innerHTML = `<span class="zyj-veil-text"></span><span class="zyj-veil-action">${style === "collapse" ? "展开" : "点击查看"}</span>`;
    if (style === "collapse") {
      v.dataset.placement = "bar"; // 折叠栏：作为第一个子元素，其他内容隐藏
      el.prepend(v);
    } else if (host) {
      v.dataset.placement = "inside";
      host.classList.add("zyj-host");
      host.appendChild(v);
    } else if (first) {
      v.dataset.placement = "flow";
      first.before(v);
    } else {
      return null;
    }
    el.__zyjVeil = v;
    return v;
  }

  function markBody(el, site) {
    el.querySelectorAll(".zyj-body").forEach((n) => n.classList.remove("zyj-body"));
    if (!site.body) return;
    if (typeof site.body === "function") (site.body(el) || []).forEach((n) => n?.isConnected && !n.classList.contains("zyj-badge") && n.classList.add("zyj-body"));
    else el.querySelectorAll(site.body).forEach((n) => n.classList.add("zyj-body"));
  }

  // ---------- 详情浮层（全页只有一个，避免被卡片的 overflow 裁掉） ----------
  const tip = (() => {
    let node = null;
    let hideTimer = null;
    let lastHidden = 0;

    function hide() {
      if (!node) return;
      hideTimer = setTimeout(() => {
        node.dataset.open = "false";
        lastHidden = Date.now();
      }, 120);
    }

    function build() {
      node = document.createElement("div");
      node.className = "zyj-tip";
      node.setAttribute("role", "tooltip");
      document.documentElement.appendChild(node);
      // 一键拉黑：浮层里的按钮
      node.addEventListener("click", (e) => {
        const btn = e.target.closest(".zyj-tip-block");
        if (!btn || btn.disabled) return;
        const key = node.__zyjForKey;
        if (!key) return;
        btn.disabled = true;
        btn.textContent = "已拉黑";
        send({ type: "blockAuthor", key }, () => {});
        (settings.blockedAuthors = settings.blockedAuthors || []).push(key);
        toast("ok", "已拉黑，正在折叠这个作者的内容");
      });
      // 悬停接力：指针从徽标挪进浮层（比如去点"拉黑此人"）时不要收起
      node.addEventListener("mouseenter", () => clearTimeout(hideTimer));
      node.addEventListener("mouseleave", hide);
    }

    const row = (label, v, top) =>
      `<div class="zyj-row${top ? " is-top" : ""}"><span>${escapeHtml(label)}</span><i style="--w:${Math.round(v * 100)}%"></i><b>${Math.round(v * 100)}%</b></div>`;

    function content(badge, res) {
      if (!res) return `<div class="zyj-tip-head">正在用 Jev 照妖…</div>`;
      if (!res.ok) {
        if (res.code === "no_key")
          return `<div class="zyj-tip-head">还没设置 API key</div><div class="zyj-tip-err">点浏览器右上角的照妖镜图标（拼图旁边），把 Jev key 粘进去就能用了。key 在 console.typesafe.ai/keys 免费申请。</div>`;
        return `<div class="zyj-tip-head">${ERROR_LABEL[res.code] || "检测失败"}</div><div class="zyj-tip-err"></div>`;
      }
      const r = res.result;
      const pct = Math.round(r.prob * 100);
      const rows = Object.entries(r.kindProbs)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => row(KIND[k] || k, v, k === r.kind))
        .join("");
      const aiRow = r.aiRatio != null && r.aiRatio >= AI_TIP ? `<div class="zyj-tip-sub">AI 味</div>${row("AI 生成/润色", r.aiRatio, r.aiRatio >= 0.5)}` : "";
      const kwRows = (settings.keywords || [])
        .map((k) => {
          const literal = (res.__literal || []).some((x) => x.toLowerCase() === k.toLowerCase());
          const p = res.topics?.[k];
          if (!literal && !(p >= TOPIC_THRESHOLD)) return "";
          return `<div class="zyj-row is-top"><span>${escapeHtml(k)}</span><i style="--w:${literal ? 100 : Math.round(p * 100)}%"></i><b>${literal ? "原文" : Math.round(p * 100) + "%"}</b></div>`;
        })
        .join("");
      const kwBlock = kwRows ? `<div class="zyj-tip-sub">命中屏蔽关键词</div><div class="zyj-rows">${kwRows}</div>` : "";
      // 作者广告档案：后台本地统计
      const stat = badge?.__zyjAuthorStat;
      const author = badge?.__zyjAuthor || "";
      const key = badge?.__zyjAuthorKey;
      let authorBlock = "";
      if (author && key && stat && stat.total >= 2 && settings.authorProfiles) {
        const rate = Math.round((stat.ads / stat.total) * 100);
        const blocked = (settings.blockedAuthors || []).includes(key);
        authorBlock = `<div class="zyj-tip-sub">作者档案（本地统计）</div>
          <div class="zyj-tip-author"><span>近 ${stat.total} 条里 ${stat.ads} 条广告（${rate}%）</span>
          <button class="zyj-tip-block"${blocked ? " disabled" : ""}>${blocked ? "已拉黑" : "拉黑此人"}</button></div>`;
      }
      const hint = res.__folded ? `<div class="zyj-tip-foot">点击徽标可重新折叠</div>` : "";
      return `<div class="zyj-tip-head"><span>广告概率</span><strong data-ad="${r.isAd}">${pct}%</strong></div>
        <div class="zyj-meter" data-ad="${r.isAd}"><i style="--w:${pct}%"></i></div>
        <div class="zyj-rows">${rows}</div>${aiRow}${kwBlock}${authorBlock}${hint}`;
    }

    return {
      show(badge) {
        if (!node) build();
        clearTimeout(hideTimer);
        const res = badge.__zyjResult && { ...badge.__zyjResult, __literal: badge.__zyjLiteral, __folded: !!badge.closest(".zyj-fold") };
        node.__zyjForKey = badge.__zyjAuthorKey;
        node.innerHTML = content(badge, res);
        if (res && !res.ok && res.code !== "no_key") node.querySelector(".zyj-tip-err").textContent = res.error || "未知错误";
        const r = badge.getBoundingClientRect();
        const w = 264;
        const gap = 4;
        const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
        const below = r.bottom + gap + 200 < innerHeight;
        node.style.left = `${left}px`;
        node.style.top = below ? `${r.bottom + gap}px` : "";
        node.style.bottom = below ? "" : `${innerHeight - r.top + gap}px`;
        node.style.setProperty("--origin", `${r.left - left + r.width / 2}px ${below ? "top" : "bottom"}`);
        // 刚关掉另一个浮层时直接出现，不再走入场动画
        node.dataset.instant = String(Date.now() - lastHidden < 300);
        node.dataset.open = "true";
      },
      hide
    };
  })();

  // ---------- 与插件后台通信 ----------
  // 插件被重新加载/更新后，已打开页面里的旧脚本会失去连接，再调用 chrome.runtime 就会抛
  // "Extension context invalidated"。检测到后停掉旧脚本的所有监听，新脚本会在页面刷新后接手。
  let dead = false;

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function shutdown() {
    if (dead) return;
    dead = true;
    mo.disconnect();
    io.disconnect();
    pending.clear();
    tip.hide();
  }

  function send(msg, cb) {
    if (dead) return;
    if (!alive()) return shutdown();
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return;
        cb(res);
      });
    } catch {
      shutdown();
    }
  }

  // ---------- 扫描 ----------
  const sent = new WeakMap(); // el -> 已提交内容的签名
  const waited = new Set(); // 已经为等评论延迟过的签名
  let noKeyTipped = false; // 未设置 key 的提示整页只弹一次

  function check(el, site) {
    if (dead || !settings.enabled) return;
    el.__zyjKey = site.key?.(el);
    const state = extract(el, site);
    if (!state) return;
    const sig = JSON.stringify(state);
    if (sent.get(el) === sig) return;
    sent.set(el, sig);
    el.__zyjAuthor = state.author || "";
    el.__zyjAuthorKey = state.author ? `${site.prefix || prefix}|${state.author}` : "";
    // 拉黑作者：本地直接折叠，不请求 Jev（取消拉黑时设置变化会触发 reset 重新判断）
    if (el.__zyjAuthorKey && (settings.blockedAuthors || []).includes(el.__zyjAuthorKey)) {
      return renderAuthorBlocked(el, site, state.author);
    }
    // 详情页评论晚于正文渲染：还没有评论时等一会儿，避免先按"无评论"判断一次、评论出来再判断一次
    if (site.comments && !state.comments && !waited.has(sig)) {
      waited.add(sig);
      // 2 秒内评论出现会让签名变化、直接走正常流程；没出现就按无评论判断
      setTimeout(() => {
        if (sent.get(el) !== sig) return;
        sent.delete(el);
        check(el, site);
      }, 2000);
      const b = mountBadge(el, site);
      b.__zyjResult = null;
      setBadge(b, "loading", "检测中");
      return;
    }
    const b = mountBadge(el, site);
    b.__zyjResult = null;
    b.__zyjAuthorKey = el.__zyjAuthorKey;
    b.__zyjAuthor = el.__zyjAuthor;
    setBadge(b, "loading", "检测中");
    el.__zyjLiteral = keywordHits(state);
    if (el.__zyjLiteral.length) applyFold(el, site, null); // 字面命中不用等判断结果
    const ready = site.enrich ? site.enrich(state) : Promise.resolve(state);
    ready.then((full) => {
      if (sent.get(el) !== sig) return;
      // 小红书卡片取到正文后再匹配一次
      const more = keywordHits(full).filter((k) => !el.__zyjLiteral.includes(k));
      if (more.length) {
        el.__zyjLiteral = el.__zyjLiteral.concat(more);
        applyFold(el, site, null);
      }
      const topics = settings.smartMatch ? (settings.keywords || []).filter((k) => typeof k === "string" && k.trim()) : [];
      send({ type: "classify", state: full, topics, authorKey: el.__zyjAuthorKey, author: el.__zyjAuthor }, (res) => {
        if (sent.get(el) !== sig) return;
        render(el, site, res);
        // 请求成功：顺手取这个作者的本地档案，悬停时展示
        if (res?.ok && el.__zyjAuthorKey) {
          send({ type: "getAuthorStat", key: el.__zyjAuthorKey }, (s) => {
            if (s?.ok) el.__zyjBadge && (el.__zyjBadge.__zyjAuthorStat = s.stat);
          });
        }
        // 服务暂时不可用、网络问题：过一会儿自动重试
        if (res && !res.ok && (res.code === "upstream" || res.code === "network")) {
          setTimeout(() => {
            if (sent.get(el) !== sig) return;
            sent.delete(el);
            check(el, site);
          }, RETRY_AFTER_MS);
        }
      });
    });
  }

  // 所有工作都放到浏览器空闲时做，不和页面自己的渲染、滚动抢主线程
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 200));

  // 只判断滚到视口附近的内容；进入视口的先排队，空闲时分批处理
  const pending = new Set();
  let flushQueued = false;
  function queueFlush() {
    if (flushQueued || dead) return;
    flushQueued = true;
    idle((deadline) => {
      flushQueued = false;
      for (const el of pending) {
        // 这一帧的空闲时间快用完了就留到下一次
        if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 3) return queueFlush();
        pending.delete(el);
        if (el.isConnected) check(el, el.__zyjSite);
      }
    });
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) pending.add(e.target);
      if (pending.size) queueFlush();
    },
    { rootMargin: "300px 0px" }
  );

  // item 支持函数形式：淘宝/天猫的评论卡没有稳定类名，函数返回元素数组
  const itemsOf = (site) => (typeof site.item === "function" ? site.item() || [] : document.querySelectorAll(site.item));

  function scan() {
    for (const site of SITES) {
      itemsOf(site).forEach((el) => {
        if (el.__zyjSite) {
          // 详情页会切换笔记，瀑布流也会复用卡片元素：看过的容器内容变了就重新判断（签名相同时 check 直接返回）
          if (site.live || sent.has(el)) {
            if (el.__zyjBadge && !el.__zyjBadge.isConnected) {
              sent.delete(el);
              el.__zyjBadge = null;
            } else if (site.key && site.key(el) === el.__zyjKey) {
              return; // 还是同一条内容：不用重新读文字
            }
            check(el, site);
          } else if (el.__zyjBadge && !el.__zyjBadge.isConnected) {
            // 框架重绘把徽标冲掉了：重新判断（命中缓存，不会重复计费）
            sent.delete(el);
            el.__zyjBadge = null;
            check(el, site);
          }
          return;
        }
        // 同站规则嵌套（信息流卡里再套卡）只看最外层；函数形式的 item 天然不嵌套（每卡只一个名字）
        if (typeof site.item === "string" && el.parentElement?.closest(site.item)) return;
        el.__zyjSite = site;
        io.observe(el);
      });
    }
  }

  // 页面变动后最多每 300ms、并且在浏览器空闲时扫描一次；期间的变动合并处理（视频播放等会让页面持续变动）
  let scanQueued = false;
  const mo = new MutationObserver(() => {
    if (scanQueued || dead) return;
    scanQueued = true;
    setTimeout(
      () =>
        idle(() => {
          scanQueued = false;
          if (!dead) {
            scan();
            applyBlockList();
          }
        }),
      300
    );
  });

  function reset() {
    pending.clear();
    document.querySelectorAll(".zyj-badge, .zyj-veil").forEach((b) => b.remove());
    document.querySelectorAll(".zyj-ad, .zyj-fold, .zyj-reveal").forEach((el) => {
      el.classList.remove("zyj-ad", "zyj-fold", "zyj-reveal");
      delete el.dataset.zyjFold;
    });
    document.querySelectorAll("[data-zyj-block]").forEach((el) => el.removeAttribute("data-zyj-block")); // 屏蔽列表的也撤掉，好按新词重屏
    for (const site of SITES)
      itemsOf(site).forEach((el) => {
        sent.delete(el);
        el.__zyjBadge = null;
        el.__zyjVeil = null;
        el.__zyjFoldReported = false;
        if (el.__zyjSite) {
          io.unobserve(el);
          if (settings.enabled) io.observe(el); // 重新触发可见性回调；结果有缓存，不会重复计费
        }
      });
  }

  function start() {
    scan();
    applyBlockList();
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // 先让页面加载完、浏览器空闲下来，再开始标注
  function startWhenPageReady() {
    const go = () => idle(() => !dead && settings.enabled && start());
    if (document.readyState === "complete") go();
    else addEventListener("load", go, { once: true });
  }

  send({ type: "getSettings" }, (s) => {
    if (s) settings = { ...settings, ...s };
    buildSites();
    buildBlockList();
    // 排障打点：SITES 为 0 说明开关被关了（enabled=false 或 esites 里的平台勾掉了）
    console.log("[照妖镜] 生效规则", SITES.length, "· 总开关", settings.enabled, "· 电商开关", JSON.stringify(settings.esites));
    if (settings.enabled && (SITES.length || BLOCK_LIST.length)) startWhenPageReady();
  });

  // 设置有变（或快捷键切换）：更新本地设置并重新标注
  function applyNewSettings() {
    send({ type: "getSettings" }, (s) => {
      if (!s) return;
      settings = { ...settings, ...s };
      mo.disconnect();
      reset();
      buildSites();
      buildBlockList();
      if (settings.enabled && (SITES.length || BLOCK_LIST.length)) start();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (["enabled", "mode", "threshold", "apiKey", "keywords", "smartMatch", "aiDetect", "authorProfiles", "blockedAuthors", "customRules", "blockListRules", "sites", "esites"].some((k) => k in changes)) {
      applyNewSettings();
    }
  });

  // ---------- 页面底部提示 ----------
  function toast(state, text, ms = 3200) {
    document.querySelectorAll(".zyj-toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "zyj-toast";
    t.dataset.state = state;
    t.textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(() => {
      t.dataset.leaving = "true";
      setTimeout(() => t.remove(), 200);
    }, ms);
  }

  // 右键"识别选中文字"的结果；快捷键切换的通知
  chrome.runtime.onMessage.addListener((msg, sendResponse) => {
    if (msg?.type === "showToast") {
      if (msg.error) return toast("error", `检测失败：${msg.error}`);
      const r = msg.result;
      const pct = Math.round(r.prob * 100);
      const ai = r.aiRatio >= AI_SHOW ? ` · AI 味 ${Math.round(r.aiRatio * 100)}%` : "";
      return toast(
        r.isAd ? "ad" : "ok",
        r.isAd ? `疑似${KIND[r.kind] === "非广告" ? "广告" : KIND[r.kind]} · 广告概率 ${pct}%${ai}` : `不像广告 · 广告概率 ${pct}%${ai}`
      );
    }
    if (msg?.type === "zyjToggled") {
      settings.enabled = msg.enabled;
      if (msg.enabled) {
        toast("ok", "照妖镜已恢复");
        applyNewSettings();
      } else {
        toast("ok", "照妖镜已暂停（扩展开关恢复）");
        mo.disconnect();
        reset();
        document.querySelectorAll(".zyj-badge").forEach((b) => b.remove());
        for (const site of SITES) itemsOf(site).forEach((el) => (el.__zyjBadge = null));
      }
    }
  });
})();
