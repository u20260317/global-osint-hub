// ============================================================
// 全球 OSINT 枢纽 · GLOBAL OSINT HUB（v1）
// 单文件 Cloudflare Worker：定时巡检全球公开来源（新闻通讯社 RSS / Reddit / Hacker News /
// GDELT / Polymarket 预测市场 / 4chan 匿名社区），做规则分类与评分，以「总统简报档案」
// 风格的深蓝 + 金 + 米纸面板呈现，并生成每日「总统简报」（规则聚合，非 AI 生成、非官方立场）。
// 零依赖，数据存 KV（绑定名 OSINT_KV）。小道消息（Reddit / 4chan 等）一律标注「未证实」。
// ============================================================

// ============================================================
// 【核心模块】配置与来源 — 来源清单（含层级）、巡检节流、KV 键、面板地址
// ============================================================
const CONFIG = {
ua: "Global-OSINT-Hub/1.0 (+https://global-osint-hub.u20261103.workers.dev)",
panelUrl: "https://global-osint-hub.u20261103.workers.dev", // 简报推送里的面板链接（换部署地址时改这里）
refreshThrottleMs: 30 * 60 * 1000, // 手动巡检节流 30 分钟（省流）
pushThrottleMs: 6 * 3600 * 1000, // 手动推送 /api/brief/push 节流：每个目标 6 小时最多 1 次
cacheTtlSec: 1800, // 只读 GET 路由边缘缓存 TTL（秒）：数据只在巡检时变化，巡检后主动失效
maxItems: 400, // KV 中最多保留条目数
keepMs: 48 * 3600 * 1000, // 条目保留时长 48 小时
kvItems: "osint:items",
kvMeta: "osint:meta",
kvTopics: "osint:topics",
kvBriefPush: "osint:briefpush",
kvPushManual: "osint:pushmanual",
kvRefresh: "osint:refresh",
};

// 层级（tier）：1 = 通讯社/主流媒体，2 = 聚合与国际台，3 = 社区/开放数据（信号弱、需交叉验证）
const TIER_WEIGHT = { 1: 50, 2: 35, 3: 20};

// RSS / Atom 来源：一轮巡检 9 个 RSS + 3 个 Reddit Atom
const FEED_SOURCES = [
{ key: "bbc", name: "BBC World", tier: 1, type: "rss", url: "https://feeds.bbci.co.uk/news/world/rss.xml"},
{ key: "guardian", name: "The Guardian", tier: 1, type: "rss", url: "https://www.theguardian.com/world/rss"},
{ key: "aljazeera", name: "Al Jazeera", tier: 1, type: "rss", url: "https://www.aljazeera.com/xml/rss/all.xml"},
{ key: "nyt", name: "NYT World", tier: 1, type: "rss", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"},
{ key: "france24", name: "France 24", tier: 2, type: "rss", url: "https://www.france24.com/en/rss"},
{ key: "gnews", name: "Google News", tier: 2, type: "rss", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"},
// 专业 OSINT 与安全媒体（tier 2）：Bellingcat 按来源默认进冲突/安全桌；Krebs 与 BleepingComputer 靠 cyber 关键词进安全桌
{ key: "bellingcat", name: "Bellingcat", tier: 2, type: "rss", url: "https://www.bellingcat.com/feed/", deskDefault: "conflict"},
{ key: "krebs", name: "Krebs on Security", tier: 2, type: "rss", url: "https://krebsonsecurity.com/feed/"},
{ key: "bleepingcomputer", name: "BleepingComputer", tier: 2, type: "rss", url: "https://www.bleepingcomputer.com/feed/"},
// Reddit 服务端抓取常被限流（429）：失败只记健康状态，社区桌自动由 HN / 4chan 兜底，绝不拖垮整轮巡检
{ key: "reddit-worldnews", name: "Reddit r/worldnews", tier: 3, type: "atom", community: true, unverified: true, url: "https://www.reddit.com/r/worldnews/.rss"},
{ key: "reddit-geopolitics", name: "Reddit r/geopolitics", tier: 3, type: "atom", community: true, unverified: true, url: "https://www.reddit.com/r/geopolitics/.rss"},
{ key: "reddit-technology", name: "Reddit r/technology", tier: 3, type: "atom", community: true, unverified: true, url: "https://www.reddit.com/r/technology/.rss"},
];

// 4chan 公开只读 API 板块（匿名社区：一律未证实，仅作风向/小道信号）
const CHAN_BOARDS = ["news", "pol", "int", "biz", "g", "k"];
const CHAN_PER_BOARD = 8; // 每板块按回复数取前 8 条

const HN_URL = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=25";
const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc?query=world&mode=ArtList&maxrecords=25&format=json&sort=datedesc";
const POLY_URL = "https://gamma-api.polymarket.com/markets?limit=15&order=volume24hr&ascending=false&active=true";

// ============================================================
// 【核心模块】分类词表 — 双语关键词类：主题桌（冲突/经济/科技）与地区（北美/欧洲/亚太/中东）
// 短英文词（≤3 字母）在匹配时用单词边界，避免 war 命中 warning、ai 命中 said 之类误报。
// ============================================================
const DESK_KEYS = {
conflict: ["战争", "停火", "导弹", "袭击", "军队", "空袭", "无人机", "核武", "制裁", "冲突", "军事", "战场", "爆炸", "人质",
"war", "ceasefire", "missile", "strike", "military", "attack", "airstrike", "drone", "nuclear", "sanction", "invasion", "troops", "bombing", "hostage", "terror",
"勒索", "漏洞", "黑客", "数据泄露", "恶意软件", "钓鱼攻击", "ransomware", "breach", "malware", "phishing", "apt", "hacker", "cyberattack", "vulnerability", "exploit", "ddos"],
economy: ["央行", "利率", "通胀", "股市", "油价", "关税", "贸易", "财政", "债务", "黄金", "汇率",
"fed", "federal reserve", "rate cut", "rate hike", "inflation", "stock", "oil price", "tariff", "trade war", "recession", "gdp", "bond", "gold price", "jobs report", "central bank"],
tech: ["人工智能", "芯片", "航天", "量子", "机器人", "大模型", "半导体", "火箭",
"ai", "artificial intelligence", "chip", "semiconductor", "space", "quantum", "robot", "openai", "nvidia", "spacex", "satellite", "cyber"],
};
// 地区判定优先级：中东 > 亚太 > 欧洲 > 北美（地缘新闻惯例：事件发生地优先于表态方）
const REGION_KEYS = [
["me", ["以色列", "加沙", "伊朗", "沙特", "黎巴嫩", "叙利亚", "也门", "胡塞", "中东",
"israel", "gaza", "iran", "saudi", "lebanon", "syria", "yemen", "houthi", "middle east", "tehran", "netanyahu"]],
["apac", ["中国", "台湾", "日本", "韩国", "印度", "澳大利亚", "北京", "东京",
"china", "taiwan", "japan", "korea", "india", "australia", "beijing", "tokyo", "pacific", "asean"]],
["eu", ["欧洲", "欧盟", "英国", "法国", "德国", "乌克兰", "俄罗斯", "北约", "伦敦", "巴黎", "柏林",
"europe", "european", "ukraine", "russia", "nato", "london", "paris", "berlin", "britain", "france", "germany", "zelensky", "putin"]],
["na", ["美国", "白宫", "华盛顿", "特朗普", "五角大楼",
"united states", "u.s.", "usa", "washington", "white house", "trump", "pentagon", "congress", "america"]],
];
const REGION_NAMES = { na: "北美", eu: "欧洲", apac: "亚太", me: "中东", other: "全球"};

// 话题表：每轮统计命中条数并与上轮快照对比，涨幅进入简报「明日关注」
const TOPICS = [
{ name: "乌克兰与俄罗斯", keys: ["ukraine", "russia", "乌克兰", "俄罗斯", "zelensky", "putin"]},
{ name: "中东局势", keys: ["israel", "gaza", "iran", "以色列", "加沙", "伊朗", "houthi"]},
{ name: "美联储与利率", keys: ["fed", "federal reserve", "利率", "美联储", "rate cut", "inflation", "通胀"]},
{ name: "人工智能", keys: ["ai", "人工智能", "openai", "nvidia", "大模型"]},
{ name: "台海与亚太", keys: ["taiwan", "台湾", "china", "中国", "south china sea"]},
{ name: "关税与贸易", keys: ["tariff", "关税", "trade war", "贸易"]},
{ name: "能源与油价", keys: ["oil", "油价", "opec", "能源", "gas price"]},
{ name: "美国政治", keys: ["trump", "特朗普", "white house", "白宫", "congress"]},
{ name: "芯片与半导体", keys: ["chip", "芯片", "semiconductor", "半导体"]},
{ name: "选举动态", keys: ["election", "选举", "vote", "投票"]},
];

// ============================================================
// 【核心模块】工具函数 — 转义、CST 时间、哈希、文本清洗（去标签/解实体/折叠空白）
// ============================================================
function esc(s) {
return String(s?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}
function cstParts(ts) {
const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date(ts));
const o = {};
for (const p of parts) o[p.type] = p.value;
return { y: o.year, mo: o.month, d: o.day, hh: parseInt(o.hour, 10) || 0, mm: parseInt(o.minute, 10) || 0};
}
function cstDateStr(ts) {
const p = cstParts(ts);
return `${p.y}-${p.mo}-${p.d}`;
}
function fmtTimeCST(ts) {
if (!ts) return "-";
const p = cstParts(ts);
return `${p.mo}-${p.d} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}
function fmtClockCST(ts) {
if (!ts) return "-";
const p = cstParts(ts);
return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}
function fmtDateLongCST(ts) {
const p = cstParts(ts);
return `${p.y} 年 ${p.mo} 月 ${p.d} 日`;
}
// FNV-1a 哈希：由 URL 生成稳定条目 id
function hashId(str) {
let h = 0x811c9dc5;
const s = String(str || "");
for (let i = 0; i < s.length; i++) {
h ^= s.charCodeAt(i);
h = Math.imul(h, 0x01000193) >>> 0;
}
return "x" + h.toString(16).padStart(8, "0");
}
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", laquo: "«", raquo: "»"};
function decodeEntities(s) {
return String(s?? "")
.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16));} catch { return " ";}})
.replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10));} catch { return " ";}})
.replace(/&([a-zA-Z]+);/g, (m, name) => (NAMED_ENTITIES[name]!= null? NAMED_ENTITIES[name]: m));
}
// 清洗：<br> 先转成换行（4chan 首行标题与 RSS 段落都靠它），再剥标签、解实体、折叠空白
function cleanText(s, maxLen) {
let t = String(s?? "");
t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
t = t.replace(/<br\s*\/?>/gi, "\n");
t = t.replace(/<[^>]+>/g, " ");
t = decodeEntities(t);
t = t.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
if (maxLen && t.length > maxLen) t = t.slice(0, maxLen).trim();
return t;
}
function firstLine(s, maxLen) {
const line = String(s || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || "";
return maxLen && line.length > maxLen? line.slice(0, maxLen).trim(): line;
}
function firstSentence(s, maxLen) {
const t = String(s || "").trim();
if (!t) return "";
const m = t.match(/^[\s\S]*?[.!?。！？](?=\s|$)/);
let out = m? m[0].trim(): t;
if (maxLen && out.length > maxLen) out = out.slice(0, maxLen).trim();
return out;
}
async function loadJSON(env, key, fallback) {
try {
const v = await env.OSINT_KV.get(key, "json");
return v == null? fallback: v;
} catch { return fallback;}
}
function tgEsc(s) {
return String(s?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// 【核心模块】来源抓取与解析 — RSS/Atom 正则解析、HN Algolia、GDELT、Polymarket、4chan catalog
// 每个来源独立 try/catch：单源失败只写健康状态，绝不拖垮整轮巡检（Reddit 429 即走此路）。
// ============================================================
async function fetchText(url, accept) {
const r = await fetch(url, { headers: { "user-agent": CONFIG.ua, accept: accept || "*/*"}, cf: { cacheTtl: 0}});
if (!r.ok) throw new Error("http_" + r.status);
return r.text();
}
async function fetchJSON(url) {
const r = await fetch(url, { headers: { "user-agent": CONFIG.ua, accept: "application/json"}, cf: { cacheTtl: 0}});
if (!r.ok) throw new Error("http_" + r.status);
return r.json();
}
// 从 XML 块里取某个标签的文本（兼容 CDATA）
function xmlTag(block, tag) {
const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
return m? m[1]: "";
}
function xmlAttr(block, tag, attr) {
const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i"));
return m? m[1]: "";
}
function parseDateLoose(s) {
if (!s) return 0;
const t = Date.parse(String(s).trim());
return Number.isFinite(t)? t: 0;
}
// GDELT seendate 形如 20261121T143000Z
function parseGdeltDate(s) {
const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
if (!m) return parseDateLoose(s);
return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// RSS 2.0（<item>）与 Atom（<entry>）统一解析：返回原始条目数组
function parseFeed(xml, isAtom) {
const out = [];
const blocks = isAtom
? (xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [])
: (xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []);
for (const b of blocks) {
let title = cleanText(xmlTag(b, "title"), 300);
let link = "";
let dateStr = "";
let desc = "";
if (isAtom) {
link = xmlAttr(b, "link", "href");
if (!link) {
const alt = b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"/i) || b.match(/<link[^>]*href="([^"]*)"/i);
link = alt? alt[1]: "";
}
dateStr = xmlTag(b, "published") || xmlTag(b, "updated");
desc = xmlTag(b, "summary") || xmlTag(b, "content");
} else {
link = cleanText(xmlTag(b, "link"), 1000);
dateStr = xmlTag(b, "pubDate") || xmlTag(b, "dc:date") || xmlTag(b, "date");
desc = xmlTag(b, "description") || xmlTag(b, "content:encoded");
}
if (!title ||!link) continue;
out.push({ title, url: decodeEntities(link).trim(), ts: parseDateLoose(dateStr), snippet: cleanText(desc, 140)});
}
return out;
}

// 条目去重键：URL 归一化（去跟踪参数/尾斜杠/协议与 host 大小写）
function dedupKey(url) {
let u = String(url || "").trim();
try {
const o = new URL(u);
o.hash = "";
for (const k of [...o.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/i.test(k)) o.searchParams.delete(k);
u = o.toString().replace(/\/$/, "");
} catch { /* 非法 URL 保持原样 */}
return u.toLowerCase();
}
function titleKey(title) {
return String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function normalizeItem(raw) {
const now = Date.now();
let ts = raw.ts && Number.isFinite(raw.ts)? raw.ts: now;
if (ts > now + 3600 * 1000) ts = now; // 未来时间戳多为源端错误，钳制到当前
if (ts <= 0) ts = now;
const url = String(raw.url || "").trim();
return {
id: hashId(dedupKey(url)),
title: String(raw.title || "").trim(),
url,
source: raw.source,
sourceKey: raw.sourceKey,
tier: raw.tier || 3,
ts,
snippet: String(raw.snippet || "").slice(0, 140),
lang: raw.lang || "",
kind: raw.kind || "news", // news | social | market
social: raw.social || 0, // 社交热度原始值（HN points / 4chan replies）
socialBonus: raw.socialBonus || 0,
unverified:!!raw.unverified,
burst:!!raw.burst, // GDELT 突发/长尾标记（进风向桌）
market: raw.market || null, // Polymarket: {prob, vol, chg}
event: raw.event || null, // USGS: {mag, place}
deskDefault: raw.deskDefault || null, // 来源默认桌（如 Bellingcat → conflict）
flex:!!raw.flex, // 社区源可按关键词改道（如 Lobsters → tech）
desk: null,
region: "other",
score: 0,
};
}

// 单个 RSS/Atom 来源 → 条目数组
async function fetchFeedSource(src) {
const xml = await fetchText(src.url, "application/rss+xml, application/atom+xml, text/xml, */*");
const rawItems = parseFeed(xml, src.type === "atom");
return rawItems.slice(0, 30).map((it) => normalizeItem({
...it,
source: src.name,
sourceKey: src.key,
tier: src.tier,
kind: src.community? "social": "news",
socialBonus: src.community? 10: 0, // Reddit 无公开分数：有出现即给固定社区加成
unverified:!!src.unverified,
deskDefault: src.deskDefault || null,
lang: "en",
}));
}

// Hacker News（Algolia front_page）：一次调用拿标题/链接/分数
async function fetchHN() {
const j = await fetchJSON(HN_URL);
const hits = Array.isArray(j && j.hits)? j.hits: [];
return hits.filter((h) => h && h.title).slice(0, 25).map((h) => normalizeItem({
title: cleanText(h.title, 300),
url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
source: "Hacker News",
sourceKey: "hn",
tier: 3,
ts: parseDateLoose(h.created_at),
snippet: "",
kind: "social",
social: h.points || 0,
socialBonus: Math.min(20, Math.round((h.points || 0) / 20)),
lang: "en",
}));
}

// GDELT：全球事件长尾覆盖，条目带「突发」标记进风向桌
async function fetchGDELT() {
const j = await fetchJSON(GDELT_URL);
const arts = Array.isArray(j && j.articles)? j.articles: [];
return arts.filter((a) => a && a.title && a.url).slice(0, 25).map((a) => normalizeItem({
title: cleanText(a.title, 300),
url: a.url,
source: "GDELT · " + (a.domain || "wire"),
sourceKey: "gdelt",
tier: 3,
ts: parseGdeltDate(a.seendate),
snippet: "",
kind: "news",
burst: true,
lang: a.language || "",
}));
}

// Polymarket：预测市场信号（概率 = outcomePrices[0]，字符串化 JSON 数组）
async function fetchPolymarket() {
const j = await fetchJSON(POLY_URL);
const arr = Array.isArray(j)? j: (Array.isArray(j && j.data)? j.data: []);
return arr.filter((m) => m && m.question).slice(0, 15).map((m) => {
let prob = null;
try {
const prices = typeof m.outcomePrices === "string"? JSON.parse(m.outcomePrices): m.outcomePrices;
if (Array.isArray(prices) && prices.length) prob = Number(prices[0]);
} catch { /* 解析失败则概率留空 */}
const slug = m.slug || m.id;
return normalizeItem({
title: cleanText(m.question, 300),
url: `https://polymarket.com/event/${slug}`,
source: "Polymarket",
sourceKey: "polymarket",
tier: 3,
ts: Date.now(),
snippet: "",
kind: "market",
market: {
prob: prob!= null && Number.isFinite(prob)? prob: null,
vol: Number(m.volume24hr) || 0,
chg: m.oneDayPriceChange!= null && Number.isFinite(Number(m.oneDayPriceChange))? Number(m.oneDayPriceChange): null,
},
lang: "en",
});
});
}

// 4chan catalog：pages[].threads[]；跳过置顶/关闭帖，清洗 com，按回复数取每板块前 8
async function fetch4chanBoard(board) {
const j = await fetchJSON(`https://a.4cdn.org/${board}/catalog.json`);
const pages = Array.isArray(j)? j: [];
const threads = [];
for (const p of pages) for (const t of (p && p.threads) || []) threads.push(t);
const items = [];
for (const t of threads) {
if (!t || t.sticky || t.closed) continue;
const comClean = cleanText(t.com || "", 600);
const subClean = cleanText(t.sub || "", 200);
let title = subClean || firstLine(comClean, 120);
// 卫生过滤：标题为空、过短（<8 字符）、或仅为 URL/文件名的一律丢弃
if (!title || title.length < 8) continue;
if (/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}([/?#]\S*)?$/i.test(title.replace(/\s+/g, ""))) continue;
if (/^[\w.-]+\.(jpg|jpeg|png|gif|webm|mp4)$/i.test(title)) continue;
items.push({ t, title, comClean, replies: t.replies || 0});
}
items.sort((a, b) => b.replies - a.replies);
return items.slice(0, CHAN_PER_BOARD).map(({ t, title, comClean, replies}) => normalizeItem({
title,
url: `https://boards.4chan.org/${board}/thread/${t.no}`,
source: `4chan /${board}/`,
sourceKey: `4chan-${board}`,
tier: 3,
ts: (t.time || 0) * 1000,
snippet: comClean.slice(0, 140),
kind: "social",
social: replies,
socialBonus: Math.min(20, Math.floor(replies / 8)),
unverified: true, // 匿名社区：显式未证实标记，简报与面板均据此标注
lang: "en",
}));
}

// ============================================================
// 【核心模块】分类与评分 — 关键词命中判定主题桌与地区；评分 = 层级权重 + 新鲜度 + 社交加成
// ============================================================
function matchKeys(text, keys) {
for (const k of keys) {
if (!k) continue;
if (/[^\x00-\x7F]/.test(k) || k.length > 3 || k.includes(" ")) {
if (text.includes(k)) return true;
} else {
if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) return true;
}
}
return false;
}
function classify(item) {
const text = (item.title + " " + (item.snippet || "")).toLowerCase();
// 地区：按 REGION_KEYS 的优先级顺序（中东 > 亚太 > 欧洲 > 北美）
item.region = "other";
for (const [region, keys] of REGION_KEYS) {
if (matchKeys(text, keys)) { item.region = region; break;}
}
// 主题桌：社区类来源（HN/Reddit/4chan）固定进社区桌；通讯社类按关键词，优先级 冲突 > 经济 > 科技
const kwDesk = matchKeys(text, DESK_KEYS.conflict)? "conflict": matchKeys(text, DESK_KEYS.economy)? "economy": matchKeys(text, DESK_KEYS.tech)? "tech": null;
if (item.kind === "market" || item.kind === "event") item.desk = "signals";
else if (item.kind === "social") item.desk = (item.flex && kwDesk)? kwDesk: "community";
else item.desk = kwDesk || item.deskDefault || null; // 关键词优先，其次来源默认桌，再无则只进头条池与地区筛选
return item;
}
function scoreItem(item, now) {
const ageH = Math.max(0, (now - item.ts) / 3600000);
const fresh = Math.max(0, 30 * (1 - ageH / 24));
item.score = Math.round((TIER_WEIGHT[item.tier] || 20) + fresh + (item.socialBonus || 0));
return item;
}
// 风向桌成员判定：预测市场 + GDELT 突发 + Reddit / 4chan 小道
function inSignals(item) {
return item.kind === "market" || item.kind === "event" || item.burst === true || item.sourceKey.startsWith("reddit-") || item.sourceKey.startsWith("4chan-") || item.sourceKey.startsWith("mastodon-");
}

// ============================================================
// 【核心模块】巡检 — 并行抓取全部来源（≈28 个子请求），合并旧数据（48h）、去重、分类、评分、话题快照
// ============================================================
async function runSweep(env) {
const now = Date.now();
const health = {}; // 每来源健康：{ok, count, error?}
const jobs = [];
const collect = (key, promise) => jobs.push(promise.then(
(items) => { health[key] = { ok: true, count: items.length}; return items;},
(e) => { health[key] = { ok: false, count: 0, error: String((e && e.message) || e).slice(0, 80)}; return [];},
));
for (const src of FEED_SOURCES) collect(src.key, fetchFeedSource(src));
collect("hn", fetchHN());
collect("lobsters", fetchLobsters());
collect("lemmy", fetchLemmy());
collect("mastodon-ukraine", fetchMastodonTag("ukraine"));
collect("mastodon-osint", fetchMastodonTag("osint"));
collect("bluesky", fetchBluesky());
collect("usgs", fetchUSGS());
collect("gdelt", fetchGDELT());
collect("polymarket", fetchPolymarket());
for (const b of CHAN_BOARDS) collect(`4chan-${b}`, fetch4chanBoard(b));
const batches = await Promise.all(jobs);
const fresh = batches.flat();

// 与旧条目合并（48 小时内）：新抓到的同 id 条目覆盖旧的
const old = await loadJSON(env, CONFIG.kvItems, null);
const oldItems = old && Array.isArray(old.items)? old.items: [];
const byId = new Map();
const byTitle = new Map();
const cutoff = now - CONFIG.keepMs;
for (const it of oldItems) {
if (!it ||!it.url || it.ts < cutoff) continue;
byId.set(it.id, it);
const tk = titleKey(it.title);
if (tk) byTitle.set(tk, it.id);
}
let newCount = 0;
// 同一 URL 被多个来源抓到时（如通讯社原文与聚合站转载），先在本轮内折叠：保留层级最高者（tier 最小），同层级取最新
const freshById = new Map();
for (const it of fresh) {
const cur = freshById.get(it.id);
if (!cur || it.tier < cur.tier || (it.tier === cur.tier && it.ts > cur.ts)) freshById.set(it.id, it);
}
for (const it of freshById.values()) {
const tk = titleKey(it.title);
const dupId = byTitle.get(tk);
if (!byId.has(it.id) &&!(dupId && dupId!== it.id)) newCount++;
if (dupId && dupId!== it.id) byId.delete(dupId); // 同标题不同 URL（如转载）：保留新抓到的
byId.set(it.id, it);
if (tk) byTitle.set(tk, it.id);
}
let items = [...byId.values()].map((it) => scoreItem(classify(it), now));
items.sort((a, b) => b.score - a.score || b.ts - a.ts);
items = items.slice(0, CONFIG.maxItems);
await env.OSINT_KV.put(CONFIG.kvItems, JSON.stringify({ ts: now, items}));

// 话题快照：统计当前条目命中，与上轮对比算涨幅（供简报「明日关注」）
const counts = {};
for (const topic of TOPICS) {
let c = 0;
for (const it of items) {
if (it.kind === "market") continue;
if (matchKeys((it.title + " " + (it.snippet || "")).toLowerCase(), topic.keys)) c++;
}
counts[topic.name] = c;
}
const prevTopics = await loadJSON(env, CONFIG.kvTopics, null);
await env.OSINT_KV.put(CONFIG.kvTopics, JSON.stringify({
cur: { ts: now, counts},
prev: prevTopics && prevTopics.cur? prevTopics.cur: null,
}));

const okSources = Object.values(health).filter((h) => h.ok).length;
const meta = { ts: now, ok: okSources > 0, sources: health, total: items.length, newCount, sourcesOk: okSources, sourcesTotal: Object.keys(health).length};
await env.OSINT_KV.put(CONFIG.kvMeta, JSON.stringify(meta));
await env.OSINT_KV.put(CONFIG.kvRefresh, JSON.stringify({ ts: now}));
return meta;
}
// 由话题快照算升温话题：涨幅 > 0 且本轮命中 ≥2，按涨幅、命中数排序
function risingTopics(topicsState) {
if (!topicsState ||!topicsState.cur ||!topicsState.prev) return [];
const cur = topicsState.cur.counts || {};
const prev = topicsState.prev.counts || {};
const out = [];
for (const [name, count] of Object.entries(cur)) {
const delta = count - (prev[name] || 0);
if (delta > 0 && count >= 2) out.push({ name, count, delta});
}
out.sort((a, b) => b.delta - a.delta || b.count - a.count);
return out;
}

// ============================================================
// 【核心模块】总统简报 — 由当前条目按规则组装（规则聚合、非 AI 生成）：头条研判 / 地区动态 /
// 冲突与安全 / 市场风向（Polymarket 概率 + 经济桌）/ 小道消息（未证实）/ 明日关注（升温话题）。
// ============================================================
function briefItem(it) {
if (!it) return null;
return {
title: it.title, url: it.url, source: it.source, ts: it.ts, score: it.score,
region: it.region, desk: it.desk, unverified:!!it.unverified,
summary: firstSentence(it.snippet, 120) || it.title,
snippet: it.snippet || "",
};
}
function buildBrief(items, topicsState, meta) {
const news = items.filter((i) => i.kind!== "market");
const byScore = [...news].sort((a, b) => b.score - a.score || b.ts - a.ts);
const headline = byScore[0] || null;
const topStories = byScore.slice(0, 3).map(briefItem);
const regions = {};
for (const r of ["na", "eu", "apac", "me"]) {
regions[r] = briefItem(byScore.find((i) => i.region === r) || null);
}
const conflict = news.filter((i) => i.desk === "conflict").sort((a, b) => b.score - a.score).slice(0, 3).map(briefItem);
const economy = news.filter((i) => i.desk === "economy").sort((a, b) => b.score - a.score).slice(0, 2).map(briefItem);
const markets = items.filter((i) => i.kind === "market" && i.market)
.sort((a, b) => (b.market.vol || 0) - (a.market.vol || 0)).slice(0, 3)
.map((i) => ({ question: i.title, url: i.url, prob: i.market.prob, chg: i.market.chg, vol: i.market.vol}));
// 小道消息：优先显式未证实标记（4chan/Reddit），不足时由社区桌与风向桌补齐，入选一律标未证实
const chatterPool = [...news].sort((a, b) => b.score - a.score);
const chatter = [];
const seen = new Set();
for (const it of chatterPool) {
if (chatter.length >= 3) break;
if (it.unverified &&!seen.has(it.id)) { const b = briefItem(it); b.unverified = true; chatter.push(b); seen.add(it.id);}
}
for (const it of chatterPool) {
if (chatter.length >= 3) break;
if ((it.desk === "community" || (inSignals(it) && it.kind !== "event")) &&!seen.has(it.id)) { const b = briefItem(it); b.unverified = true; chatter.push(b); seen.add(it.id);}
}
return {
date: cstDateStr(Date.now()),
generatedTs: Date.now(),
method: "规则聚合", // 如实标注：非 AI 生成
headline: briefItem(headline),
topStories,
regions,
conflict,
markets: { polymarket: markets, economy},
chatter,
watch: risingTopics(topicsState).slice(0, 3),
totals: { items: items.length, sourcesOk: meta? meta.sourcesOk: 0, sourcesTotal: meta? meta.sourcesTotal: 0},
};
}
async function loadBrief(env) {
const data = await loadJSON(env, CONFIG.kvItems, null);
const items = data && Array.isArray(data.items)? data.items: [];
const topicsState = await loadJSON(env, CONFIG.kvTopics, null);
const meta = await loadJSON(env, CONFIG.kvMeta, null);
return buildBrief(items, topicsState, meta);
}

// ============================================================
// 【核心模块】Telegram 推送 — 每日简报只推私聊（DM）一个目标：CST 08:00 后首轮巡检触发，
// 按天门禁（osint:briefpush），失败目标当天后续巡检自动重试。手动推送走 PUSH_KEY 鉴权 +
// 按目标 6 小时节流（osint:pushmanual），语义与 GitHub 情报中心 v5.3.1 一致。
// ============================================================
function buildBriefText(b) {
const p = cstParts(Date.now());
const link = (it) => it? `<a href="${tgEsc(it.url)}">${tgEsc(it.title)}</a>`: "暂无";
const lines = [];
lines.push(`📜 <b>全球 OSINT 枢纽 · 总统简报（${p.mo}-${p.d}）</b>`);
lines.push(`公开来源规则聚合 · 共 ${b.totals.items} 条 · 来源 ${b.totals.sourcesOk}/${b.totals.sourcesTotal} 正常`);
lines.push("");
lines.push(`【头条】${link(b.headline)}`);
if (b.topStories && b.topStories.length) {
lines.push("");
lines.push("【头条研判】");
b.topStories.forEach((s, i) => lines.push(`${i + 1}. ${link(s)}`));
}
lines.push("");
lines.push("【地区动态】");
lines.push(`北美：${link(b.regions.na)}`);
lines.push(`欧洲：${link(b.regions.eu)}`);
lines.push(`亚太：${link(b.regions.apac)}`);
lines.push(`中东：${link(b.regions.me)}`);
if (b.conflict && b.conflict.length) {
lines.push("");
lines.push("【冲突与安全】");
b.conflict.forEach((s, i) => lines.push(`${i + 1}. ${link(s)}`));
}
if (b.markets && (b.markets.polymarket.length || b.markets.economy.length)) {
lines.push("");
lines.push("【市场风向】");
for (const m of b.markets.polymarket) {
const prob = m.prob!= null? `${Math.round(m.prob * 100)}%`: "—";
const chg = m.chg!= null? `（24h ${m.chg >= 0? "+": ""}${(m.chg * 100).toFixed(1)}%）`: "";
lines.push(`· <a href="${tgEsc(m.url)}">${tgEsc(m.question)}</a> 概率 ${prob}${chg}`);
}
b.markets.economy.forEach((s, i) => lines.push(`${i + 1}. ${link(s)}`));
}
if (b.chatter && b.chatter.length) {
lines.push("");
lines.push("【小道消息 · 未证实】");
b.chatter.forEach((s, i) => lines.push(`${i + 1}. ${link(s)}（${tgEsc(s.source)}）`));
}
if (b.watch && b.watch.length) {
lines.push("");
lines.push(`【明日关注】${b.watch.map((w) => `${tgEsc(w.name)} ↑${w.delta}`).join(" · ")}`);
}
lines.push("");
lines.push(`<a href="${CONFIG.panelUrl}">打开 OSINT 面板 →</a>`);
let text = lines.join("\n");
if (text.length > 1700) {
const cut = text.lastIndexOf("\n", 1690);
text = text.slice(0, cut > 0? cut: 1690) + "\n…";
}
return text;
}
async function sendTelegramTo(env, chatId, text) {
try {
const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
method: "POST",
headers: { "content-type": "application/json"},
body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true}),
});
const j = await r.json().catch(() => null);
return!!(j && j.ok === true);
} catch { return false;}
}
// 推送目标：v1 只有私聊 DM（需同时配 TG_BOT_TOKEN 与 TG_CHAT_ID）
function resolvePushTargets(env) {
if (!env.TG_BOT_TOKEN ||!env.TG_CHAT_ID) return [];
return [{ key: "dm", kind: "dm", chatId: String(env.TG_CHAT_ID)}];
}
async function pushBriefToTargets(env, brief, targets) {
const text = buildBriefText(brief);
const now = Date.now();
const today = cstDateStr(now);
let state = (await loadJSON(env, CONFIG.kvBriefPush, {})) || {};
if (state.date!== today || typeof state.targets!== "object" ||!state.targets) state = { date: today, targets: {}};
const results = {};
for (const t of targets) {
const ok = await sendTelegramTo(env, t.chatId, text);
results[t.key] = ok;
state.targets[t.key] = { ok, ts: now};
}
await env.OSINT_KV.put(CONFIG.kvBriefPush, JSON.stringify(state));
return results;
}
// 每日自动推送门禁：CST 08:00 之后、且当天该目标还没推送成功过，才补发
async function maybePushDailyBrief(env) {
const targets = resolvePushTargets(env);
if (!targets.length) return { pushed: false, reason: "not_configured"};
const now = Date.now();
const p = cstParts(now);
if (p.hh * 60 + p.mm < 8 * 60) return { pushed: false, reason: "before_0800"};
const today = cstDateStr(now);
const state = (await loadJSON(env, CONFIG.kvBriefPush, {})) || {};
const dayTargets = state.date === today && state.targets? state.targets: {};
const due = targets.filter((t) =>!(dayTargets[t.key] && dayTargets[t.key].ok));
if (!due.length) return { pushed: false, reason: "already_today"};
const brief = await loadBrief(env);
const results = await pushBriefToTargets(env, brief, due);
return { pushed: Object.values(results).some(Boolean), results};
}
// 手动推送节流戳：{目标键: ts} 映射（容忍旧的裸数字/{ts} 格式，视为 dm 的戳）
async function loadPushManualStamps(env) {
const raw = await loadJSON(env, CONFIG.kvPushManual, null);
if (raw == null) return {};
if (typeof raw === "number" && Number.isFinite(raw)) return { dm: raw};
if (typeof raw === "object") {
if (typeof raw.ts === "number" &&!("dm" in raw)) return { dm: raw.ts};
const out = {};
for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
return out;
}
return {};
}

// ============================================================
// 【核心模块】OSINT 原生与社区来源 — Lobsters / Lemmy / Mastodon / Bluesky / USGS 地震
// 均为 tier 3 社区或开放数据（USGS 为官方监测，tier 2）：用户生成内容一律未证实标记；
// Bluesky 在出口 IP 受限时返回 403，失败只记健康状态，与 Reddit 同等待遇、不特殊处理。
// ============================================================
// Lobsters（技术社区）：按 score 取前 12；flex 标记允许按关键词改道 tech 等桌
async function fetchLobsters() {
  const j = await fetchJSON("https://lobste.rs/hottest.json");
  const arr = Array.isArray(j) ? j : [];
  return arr.filter((x) => x && x.title).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12).map((x) => normalizeItem({
    title: cleanText(x.title, 300),
    url: x.url || x.comments_url || "",
    source: "Lobsters",
    sourceKey: "lobsters",
    tier: 3,
    ts: parseDateLoose(x.created_at),
    snippet: cleanText(x.description || "", 140),
    kind: "social",
    flex: true,
    social: x.score || 0,
    socialBonus: Math.min(20, Math.round((x.score || 0) / 2)),
    lang: "en",
  }));
}
// Lemmy 时间无时区标记时按 UTC 解析
function parseLemmyDate(s) {
  let t = String(s || "").trim();
  if (t && !/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += "Z";
  return parseDateLoose(t);
}
// Lemmy（lemmy.world，联邦社区）：标题 = post.name，链接优先外链、否则站内帖地址；按 counts.score 取前 12
async function fetchLemmy() {
  const j = await fetchJSON("https://lemmy.world/api/v3/post/list?type_=Local&sort=Hot&limit=20");
  const posts = Array.isArray(j && j.posts) ? j.posts : [];
  const rows = posts.map((row) => {
    const post = (row && row.post) || {};
    const score = (row && row.counts && row.counts.score) || 0;
    return { post, score };
  }).filter(({ post }) => post && post.name);
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 12).map(({ post, score }) => normalizeItem({
    title: cleanText(post.name, 300),
    url: post.url || `https://lemmy.world/post/${post.id}`,
    source: "Lemmy · lemmy.world",
    sourceKey: "lemmy",
    tier: 3,
    ts: parseLemmyDate(post.published),
    snippet: cleanText(post.body || "", 140),
    kind: "social",
    social: score,
    socialBonus: Math.min(20, Math.round(score / 10)),
    unverified: true, // 联邦社区用户发帖：小道标记
    lang: "en",
  }));
}
// Mastodon 标签时间线：帖文 HTML 清洗后首行作标题；纯链接/媒体帖（去链接后 <12 字符）丢弃；一律未证实，进社区桌与风向桌
async function fetchMastodonTag(tag) {
  const j = await fetchJSON(`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=15`);
  const arr = Array.isArray(j) ? j : [];
  const out = [];
  for (const st of arr) {
    if (!st || !st.content) continue;
    const text = cleanText(st.content, 600);
    const noUrls = text.replace(/https?:\/\/\S+/g, "").trim();
    if (noUrls.length < 12) continue;
    out.push(normalizeItem({
      title: firstLine(text, 110),
      url: st.url || st.uri || "",
      source: `Mastodon #${tag}`,
      sourceKey: `mastodon-${tag}`,
      tier: 3,
      ts: parseDateLoose(st.created_at),
      snippet: text.slice(0, 140),
      kind: "social",
      social: st.favourites_count || 0,
      socialBonus: Math.min(20, Math.round((st.favourites_count || 0) / 5)),
      unverified: true,
      lang: st.language || "",
    }));
  }
  return out.slice(0, 15);
}
// Bluesky 搜索（尝试性接入）：帖文首行作标题，链接由作者 handle 与帖 rkey 拼出
async function fetchBluesky() {
  const j = await fetchJSON("https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=ukraine&limit=15&sort=top");
  const posts = Array.isArray(j && j.posts) ? j.posts : [];
  const out = [];
  for (const p of posts) {
    if (!p) continue;
    const text = cleanText((p.record && p.record.text) || "", 400);
    const noUrls = text.replace(/https?:\/\/\S+/g, "").trim();
    if (noUrls.length < 12) continue;
    const rkey = String(p.uri || "").split("/").pop() || "";
    const handle = (p.author && p.author.handle) || "";
    out.push(normalizeItem({
      title: firstLine(text, 120),
      url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : "https://bsky.app",
      source: "Bluesky",
      sourceKey: "bluesky",
      tier: 3,
      ts: parseDateLoose(p.indexedAt),
      snippet: text.slice(0, 140),
      kind: "social",
      social: p.likeCount || 0,
      socialBonus: Math.min(20, Math.round((p.likeCount || 0) / 20)),
      unverified: true,
      lang: (p.record && Array.isArray(p.record.langs) && p.record.langs[0]) || "",
    }));
  }
  return out.slice(0, 15);
}
// USGS 地震（官方监测）：4.5 级以上/24h，按震级取前 8；kind=event，进风向桌并带「突发 · 自然」徽章
async function fetchUSGS() {
  const j = await fetchJSON("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson");
  const feats = Array.isArray(j && j.features) ? j.features : [];
  return feats.filter((f) => f && f.properties && f.properties.title)
    .sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0)).slice(0, 8)
    .map((f) => normalizeItem({
      title: cleanText(f.properties.title, 300),
      url: f.properties.url || "",
      source: "USGS 地震监测",
      sourceKey: "usgs",
      tier: 2,
      ts: f.properties.time || 0,
      snippet: cleanText(f.properties.place || "", 140),
      kind: "event",
      event: { mag: f.properties.mag != null ? Number(f.properties.mag) : null, place: f.properties.place || "" },
      lang: "en",
    }));
}

// ============================================================
// 【核心模块】 i18n — STRINGS (zh default / en), lang resolution (?lang= > Cookie > Accept-Language),
// gold-seal language toggle, brief label localization. UI layer only: item titles / snippets /
// source names stay original; Telegram push text always uses zh.
// ============================================================
const STRINGS = {
zh: {
classif: "UNCLASSIFIED · OPEN SOURCE INTELLIGENCE · 公开来源情报",
pageTitle: "全球 OSINT 枢纽 · GLOBAL OSINT HUB",
mastTitle: "全球 OSINT 枢纽",
mastSub: "GLOBAL OSINT HUB",
tagline: "全球公开情报 · 每日总统简报",
statusLabel: "巡检状态", statusOk: "正常", statusPartial: "部分来源异常", statusNone: "未巡检",
lastSweep: "上次巡检", itemsLabel: "条目", sourcesLabel: "来源", beijingTag: "（北京）",
refreshBtn: "⟳ 立即巡检（30 分钟节流）",
searchPh: "搜索标题 / 来源…",
chipAll: "全部地区",
navBrief: "总统简报",
healthHeading: "来源健康 · SOURCE HEALTH", healthOk: "{n} 条",
leadKicker: "头条 · LEAD STORY",
badgeUnverified: "未证实", badgeUnverifiedChan: "未证实 · 4chan", badgeBurst: "突发", badgeEvent: "突发 · 自然",
mktSourceLine: "POLYMARKET · 预测市场", mktVol: "24h 量", mktProb: "概率",
paperTitle: "每日总统简报", paperSub: "THE PRESIDENT'S DAILY BRIEF", paperDateSuffix: "北京时间 · 呈报件",
stamp: "规则聚合 · RULES BRIEF",
secTop: "头条研判", secRegions: "地区动态", secConflict: "冲突与安全", secMarkets: "市场风向", secChatter: "小道消息", secWatch: "明日关注",
leadLabel: "头条", none: "暂无", noData: "暂无数据", chatterSuffix: "未证实",
watchEmpty: "话题热度暂无显著升温",
paperFoot: "本简报由公开来源经规则自动聚合生成（非 AI 生成），非任何国家或机构的官方文件；小道消息未经证实，请以原文与官方发布为准。",
empty1: "暂无数据 · 等待首轮巡检", empty2: "NO DATA — AWAITING FIRST SWEEP",
footerMain: "本站为公开来源自动聚合，研判由规则生成、非 AI 生成、非官方立场；小道消息未经证实，请以原文与官方发布为准。",
fabBrief: "📜 总统简报",
jsSweeping: "巡检中…（约需数秒）", jsThrottled: "已节流：距上次巡检不足 30 分钟，请稍后再试", jsDone: "巡检完成，正在刷新…", jsFailed: "巡检请求失败，请稍后重试",
methodLabel: "规则聚合",
blurbCommunity: "本桌汇集 HN、Reddit、Lobsters、Lemmy、Mastodon、Bluesky 与 4chan 等社区来源：其中 4chan 为匿名社区、内容未经证实，其余社区帖文亦属用户生成内容，仅供研判参考，请交叉验证。",
blurbSignals: "预测市场概率、GDELT 突发、USGS 自然事件与社区小道混合呈现；小道消息未经证实。",
},
en: {
classif: "UNCLASSIFIED · OPEN SOURCE INTELLIGENCE · PUBLIC SOURCES ONLY",
pageTitle: "Global OSINT Hub — Presidential OSINT Briefing",
mastTitle: "Global OSINT Hub",
mastSub: "GLOBAL OSINT HUB · EST. 2026",
tagline: "OPEN-SOURCE INTELLIGENCE · THE DAILY PRESIDENTIAL BRIEF",
statusLabel: "SWEEP STATUS", statusOk: "NOMINAL", statusPartial: "SOME SOURCES DEGRADED", statusNone: "NO SWEEP YET",
lastSweep: "LAST SWEEP", itemsLabel: "ITEMS", sourcesLabel: "SOURCES", beijingTag: " (BEIJING)",
refreshBtn: "⟳ RUN SWEEP · 30-MIN THROTTLE",
searchPh: "Search headlines / sources…",
chipAll: "All Regions",
navBrief: "Daily Brief",
healthHeading: "SOURCE HEALTH", healthOk: "{n} items",
leadKicker: "LEAD STORY",
badgeUnverified: "UNVERIFIED", badgeUnverifiedChan: "UNVERIFIED · 4CHAN", badgeBurst: "BREAKING", badgeEvent: "EVENT · NATURAL",
mktSourceLine: "POLYMARKET · PREDICTION MARKET", mktVol: "24H VOL", mktProb: "PROBABILITY",
paperTitle: "The President's Daily Brief", paperSub: "GLOBAL OSINT HUB · DAILY INTELLIGENCE SUMMARY", paperDateSuffix: "BEIJING TIME · PREPARED FOR THE PRESIDENT",
stamp: "RULES-AGGREGATED BRIEF",
secTop: "Top Stories", secRegions: "Regional Dynamics", secConflict: "Conflict & Security", secMarkets: "Market Signals", secChatter: "Chatter · Unverified", secWatch: "Tomorrow's Watch",
leadLabel: "LEAD", none: "None", noData: "No data yet", chatterSuffix: "unverified",
watchEmpty: "No topic is heating up significantly",
paperFoot: "This brief is assembled automatically from public sources by rules (not AI-generated) and is not an official document of any government or institution. Chatter is unverified — please consult the original reporting and official releases.",
empty1: "NO DATA — AWAITING FIRST SWEEP", empty2: "暂无数据 · 等待首轮巡检",
footerMain: "Automatically aggregated from public sources. Assessments are rules-generated — not AI-generated and not an official position. Chatter is unverified; consult originals and official releases.",
fabBrief: "📜 Daily Brief",
jsSweeping: "Sweeping… (a few seconds)", jsThrottled: "Throttled: the last sweep was under 30 minutes ago — please try again later", jsDone: "Sweep complete — reloading…", jsFailed: "Sweep request failed — please try again later",
methodLabel: "Rules-aggregated",
blurbCommunity: "Community sources — HN, Reddit, Lobsters, Lemmy, Mastodon, Bluesky and 4chan. 4chan is an anonymous board and its content is unverified; all community posts are user-generated. Treat as leads for assessment and cross-check before citing.",
blurbSignals: "Prediction-market probabilities, GDELT bursts, USGS natural events and community chatter, presented together. Chatter is unverified.",
},
};
const REGION_NAMES_EN = { na: "North America", eu: "Europe", apac: "Asia-Pacific", me: "Middle East", other: "Global"};
function regionName(lang, key) {
  if (lang === "en") return REGION_NAMES_EN[key] || "Global";
  return REGION_NAMES[key] || "全球";
}
function t(lang, key, vars) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) != null ? STRINGS[lang][key] : (STRINGS.zh[key] != null ? STRINGS.zh[key] : key);
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  return s;
}
function resolveLang(request) {
  try {
    const q = new URL(request.url).searchParams.get("lang");
    if (q === "zh" || q === "en") return { lang: q, fromQuery: true };
  } catch {}
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)osint-lang=(zh|en)(?=$|;)/);
  if (m) return { lang: m[1], fromQuery: false };
  const al = (request.headers.get("accept-language") || "").split(",")[0].trim().toLowerCase();
  if (al.startsWith("en")) return { lang: "en", fromQuery: false };
  if (al.startsWith("zh")) return { lang: "zh", fromQuery: false };
  return { lang: "zh", fromQuery: false };
}
function fmtDateLong(lang, ts) {
  if (lang === "en") {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date(ts)); } catch { /* fall back to zh format */ }
  }
  return fmtDateLongCST(ts);
}
function langToggleHTML(lang, variant) {
  const seg = (code, label) => `<a class="lt-seg${lang === code ? " on" : ""}" href="/?lang=${code}"${lang === code ? ' aria-current="true"' : ""}>${label}</a>`;
  return `<nav class="lang-toggle${variant === "paper" ? " paper" : ""}" aria-label="Language">${seg("zh", "中文")}${seg("en", "ENGLISH")}<span class="lt-stud" aria-hidden="true">★</span></nav>`;
}
const BRIEF_SECTIONS = [
  { numZh: "一", numEn: "I", key: "secTop" },
  { numZh: "二", numEn: "II", key: "secRegions" },
  { numZh: "三", numEn: "III", key: "secConflict" },
  { numZh: "四", numEn: "IV", key: "secMarkets" },
  { numZh: "五", numEn: "V", key: "secChatter" },
  { numZh: "六", numEn: "VI", key: "secWatch" },
];
function secHeadHTML(lang, i) {
  const s = BRIEF_SECTIONS[i];
  if (lang === "en") return `<h3>${s.numEn}. ${esc(t("en", s.key))}</h3>`;
  return `<h3>${s.numZh}、${t("zh", s.key)} <span class="en">${esc(t("en", s.key).toUpperCase())}</span></h3>`;
}
function briefLabels(lang) {
  const L = lang === "en" ? "en" : "zh";
  return {
    title: t(L, "paperTitle"),
    method: t(L, "methodLabel"),
    unverified: t(L, "badgeUnverified"),
    sections: {
      topStories: t(L, "secTop"), regions: t(L, "secRegions"), conflict: t(L, "secConflict"),
      markets: t(L, "secMarkets"), chatter: t(L, "secChatter"), watch: t(L, "secWatch"),
    },
    regions: { na: regionName(L, "na"), eu: regionName(L, "eu"), apac: regionName(L, "apac"), me: regionName(L, "me") },
  };
}

// ============================================================
// 【核心模块】面板渲染 — 总统档案风：深蓝 + 金 + 米纸；原创抽象徽章（同心圆/星/放射线，
// 非任何官方印章复制）、酒红密级条、衬线大标题、报纸式头条与纸面总统简报。
// ============================================================
function sealSVG(uid, size) {
  return `<svg class="seal" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="Global OSINT Hub seal">
<defs><path id="ring-${uid}" d="M 50,50 m -37,0 a 37,37 0 1,1 74,0 a 37,37 0 1,1 -74,0"/></defs>
<circle cx="50" cy="50" r="48" fill="none" stroke="#c9a227" stroke-width="1.6"/>
<circle cx="50" cy="50" r="44.5" fill="none" stroke="#c9a227" stroke-width="0.7"/>
<circle cx="50" cy="50" r="27" fill="none" stroke="#c9a227" stroke-width="0.9"/>
<g stroke="#c9a227" stroke-width="0.8" opacity="0.75">
<line x1="50" y1="24" x2="50" y2="29"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(45 50 50)"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(90 50 50)"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(135 50 50)"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(180 50 50)"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(225 50 50)"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(270 50 50)"/><line x1="50" y1="24" x2="50" y2="29" transform="rotate(315 50 50)"/>
</g>
<polygon points="50,35 54.4,45.2 65.4,45.6 56.8,52.6 59.7,63.2 50,56.9 40.3,63.2 43.2,52.6 34.6,45.6 45.6,45.2" fill="#e6c96a"/>
<text font-size="8.2" letter-spacing="2.6" fill="#e6c96a" font-family="Georgia, 'Times New Roman', serif"><textPath href="#ring-${uid}">GLOBAL OSINT HUB · EST. 2026 ·</textPath></text>
</svg>`;
}
const PANEL_CSS = `
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(165deg,#071022 0%,#0c1d3a 52%,#081428 100%);color:#f5eeda;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
a{color:#e9dfc8;text-decoration:none}
a:hover{color:#e6c96a}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px 70px}
.classif{background:#7a1f2b;color:#f5eeda;text-align:center;padding:8px 10px;font-size:12px;letter-spacing:.34em;font-family:Georgia,"Times New Roman",serif}
.masthead{text-align:center;padding:34px 10px 8px}
.masthead h1{font-family:Georgia,"Times New Roman","Songti SC","SimSun",serif;font-size:clamp(38px,6vw,62px);margin:12px 0 4px;letter-spacing:.1em;font-weight:700;color:#f7f1de}
.hub-en{color:#c9a227;letter-spacing:.52em;font-size:14px;font-family:Georgia,"Times New Roman",serif;text-indent:.52em}
.tagline{color:#b9ac8d;font-size:13px;letter-spacing:.28em;margin-top:10px}
.rule{border-top:1px solid #c9a227;margin:18px auto 0;max-width:860px;position:relative}
.rule:after{content:"";position:absolute;left:0;right:0;top:3px;border-top:1px solid rgba(201,162,39,.55)}
.statusline{margin-top:14px;color:#cbbd97;font-size:13px;letter-spacing:.12em}
.statusline b{color:#e6c96a;font-weight:600}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center;margin:22px 0 6px}
.btn{background:transparent;border:1px solid #c9a227;color:#e6c96a;padding:7px 16px;font-size:13px;letter-spacing:.14em;cursor:pointer;font-family:Georgia,serif}
.btn:hover{background:rgba(201,162,39,.14)}
.btn:disabled{opacity:.5;cursor:wait}
.chip{border:1px solid rgba(201,162,39,.4);color:#d8cba6;padding:6px 14px;font-size:13px;cursor:pointer;background:transparent;letter-spacing:.1em}
.chip.on{background:#c9a227;color:#0c1d3a;font-weight:700}
.search{background:rgba(255,255,255,.05);border:1px solid rgba(201,162,39,.4);color:#f5eeda;padding:7px 12px;font-size:13px;min-width:190px}
.navdesk{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin:10px 0 4px;font-family:Georgia,serif;font-size:13px;letter-spacing:.16em}
.navdesk a{color:#b9ac8d}
.navdesk a:hover{color:#e6c96a}
.health{display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center;margin:14px 0 4px;font-size:12px;color:#9d9176}
.health .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px}
.health .ok .dot{background:#7fc97f}
.health .bad{color:#d08a8a}
.health .bad .dot{background:#c0392b}
.hero{margin:30px auto 6px;max-width:880px;text-align:center;padding:26px 22px;border:1px solid rgba(201,162,39,.35);background:rgba(255,255,255,.03)}
.hero .kicker{color:#c9a227;letter-spacing:.4em;font-size:12px;font-family:Georgia,serif}
.hero h2{font-family:Georgia,"Times New Roman","Songti SC",serif;font-size:clamp(24px,3.6vw,36px);line-height:1.35;margin:12px 0 10px;font-weight:700}
.hero p{color:#cfc4a4;line-height:1.75;margin:6px auto;max-width:720px}
.meta{color:#9d9176;font-size:12.5px;letter-spacing:.08em}
.src{color:#e6c96a;letter-spacing:.06em}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border:1px solid #7a1f2b;color:#e8a0a0;letter-spacing:.12em;margin-left:8px;vertical-align:2px}
.badge.evt{border-color:#c9a227;color:#e6c96a}
.badge.burst{border-color:#8a6d1f;color:#d8b95c}
.paper{background:#f7f1de;color:#1b2745;margin:44px auto 10px;max-width:900px;padding:38px 44px 30px;box-shadow:0 24px 60px rgba(0,0,0,.55),0 4px 14px rgba(0,0,0,.4);font-family:Georgia,"Times New Roman","Songti SC","SimSun",serif;position:relative}
.paper:before{content:"";position:absolute;inset:10px;border:1px solid rgba(122,31,43,.25);pointer-events:none}
.paper-head{text-align:center;border-bottom:3px double #7a1f2b;padding-bottom:14px;margin-bottom:18px;position:relative}
.paper-head h2{margin:6px 0 2px;font-size:30px;letter-spacing:.14em;color:#14264e}
.paper-head .en{letter-spacing:.34em;font-size:12px;color:#7a1f2b}
.paper-head .pdate{color:#5a5340;font-size:13px;margin-top:6px;letter-spacing:.1em}
.stamp{display:inline-block;border:2px solid #7a1f2b;color:#7a1f2b;padding:2px 12px;transform:rotate(-3deg);letter-spacing:.24em;font-size:12px;margin-top:10px;background:rgba(122,31,43,.05)}
.paper h3{color:#7a1f2b;font-size:16px;letter-spacing:.22em;border-bottom:1px solid rgba(27,39,69,.25);padding-bottom:5px;margin:22px 0 10px}
.paper h3 .en{font-size:11px;color:#8a7a4d;letter-spacing:.3em;margin-left:8px}
.paper p,.paper li{line-height:1.8;font-size:15px}
.paper ul{margin:6px 0;padding-left:20px}
.paper a{color:#14264e;text-decoration:underline;text-decoration-color:rgba(201,162,39,.8);text-underline-offset:3px}
.paper a:hover{color:#7a1f2b}
.paper .sum{color:#4c4636}
.paper .mkt{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dotted rgba(27,39,69,.3);padding:5px 0}
.paper .prob{font-weight:700;color:#14264e;white-space:nowrap}
.up{color:#1e7a34}.down{color:#a02334}
.paper .watch{display:inline-block;border:1px solid #c9a227;background:rgba(201,162,39,.14);padding:2px 10px;margin:3px 4px 3px 0;font-size:13.5px}
.paper .pfoot{margin-top:24px;border-top:1px solid rgba(27,39,69,.25);padding-top:10px;color:#6d6450;font-size:12.5px;text-align:center;letter-spacing:.08em}
.desk{margin:42px 0 0}
.desk-head{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid rgba(201,162,39,.4);padding-bottom:8px}
.desk-head .num{color:#c9a227;font-family:Georgia,serif;font-size:22px}
.desk-head h2{font-family:Georgia,"Times New Roman","Songti SC",serif;font-size:23px;margin:0;letter-spacing:.12em}
.desk-head .en{color:#8d8163;font-size:11.5px;letter-spacing:.3em}
.desk .blurb{color:#a99a76;font-size:13px;line-height:1.7;margin:10px 0 2px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:16px}
.item{background:rgba(255,255,255,.03);border:1px solid rgba(201,162,39,.18);padding:14px 16px}
.item h3{font-family:Georgia,"Times New Roman","Songti SC",serif;font-size:17.5px;line-height:1.5;margin:6px 0 6px;font-weight:600}
.item p{color:#c6b995;font-size:13.5px;line-height:1.7;margin:4px 0 2px}
.item .meta{font-size:12px}
.region{color:#8fb8d8;letter-spacing:.06em}
.mkt-card{background:rgba(201,162,39,.06);border:1px solid rgba(201,162,39,.4);padding:14px 16px}
.mkt-card h3{font-family:Georgia,serif;font-size:16.5px;line-height:1.5;margin:6px 0 10px;font-weight:600}
.bar{height:8px;background:rgba(255,255,255,.09);margin:8px 0 6px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#c9a227,#e6c96a)}
.mkt-num{display:flex;justify-content:space-between;font-size:12.5px;color:#cbbd97}
.empty{margin:60px auto;max-width:640px;text-align:center;color:#b9ac8d;border:1px dashed rgba(201,162,39,.45);padding:36px 22px;line-height:2;letter-spacing:.1em}
.fab{position:fixed;right:22px;bottom:22px;background:linear-gradient(180deg,#e6c96a,#c9a227);color:#14264e;border:none;padding:13px 22px;font-family:Georgia,serif;font-size:15px;letter-spacing:.18em;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.5);border-radius:999px;z-index:50}
.fab:hover{filter:brightness(1.07)}
footer{margin-top:56px;text-align:center;color:#8d8163;font-size:12.5px;line-height:1.9;letter-spacing:.06em}
.hidden{display:none!important}
.mast-tools{display:flex;justify-content:flex-end;margin:0 0 12px}
.paper-tools{display:flex;justify-content:flex-end;margin-bottom:8px;position:relative;z-index:1}
.health-title{text-align:center;color:#8d8163;font-size:11.5px;letter-spacing:.3em;margin:16px 0 0;font-family:Georgia,serif}
.lang-toggle{position:relative;display:inline-flex;align-items:center;gap:2px;padding:3px;border:1.5px solid #c9a227;outline:1px solid rgba(201,162,39,.5);outline-offset:3px;border-radius:999px;background:linear-gradient(180deg,#0e2142,#071022);box-shadow:0 4px 18px rgba(0,0,0,.45),inset 0 0 0 1px rgba(230,201,106,.22);transition:box-shadow .25s ease;font-family:Georgia,"Times New Roman",serif}
.lang-toggle:hover{box-shadow:0 0 0 1px rgba(230,201,106,.35),0 6px 24px rgba(201,162,39,.38),inset 0 0 0 1px rgba(230,201,106,.3)}
.lang-toggle .lt-seg{padding:6px 17px;border-radius:999px;font-size:12.5px;letter-spacing:.2em;color:#f5eeda;line-height:1;white-space:nowrap}
.lang-toggle .lt-seg:hover{color:#e6c96a}
.lang-toggle .lt-seg.on{background:linear-gradient(180deg,#efd67e,#c9a227);color:#14264e;font-weight:700;box-shadow:inset 0 0 12px rgba(255,246,205,.65),0 0 10px rgba(201,162,39,.45)}
.lang-toggle .lt-seg.on:hover{color:#14264e}
.lang-toggle .lt-stud{position:absolute;left:-9px;top:50%;transform:translateY(-50%);width:19px;height:19px;border-radius:50%;background:#0c1d3a;border:1.5px solid #c9a227;color:#e6c96a;font-size:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;line-height:1}
.lang-toggle.paper{border-color:#14264e;outline-color:rgba(20,38,78,.45);background:#f7f1de;box-shadow:0 3px 12px rgba(27,39,69,.18),inset 0 0 0 1px rgba(20,38,78,.15)}
.lang-toggle.paper:hover{box-shadow:0 0 0 1px rgba(122,31,43,.25),0 5px 18px rgba(27,39,69,.28),inset 0 0 0 1px rgba(20,38,78,.2)}
.lang-toggle.paper .lt-seg{color:#14264e}
.lang-toggle.paper .lt-seg:hover{color:#7a1f2b}
.lang-toggle.paper .lt-seg.on{background:linear-gradient(180deg,#22355f,#14264e);color:#f7f1de;box-shadow:inset 0 0 12px rgba(245,238,218,.25),0 0 8px rgba(20,38,78,.35)}
.lang-toggle.paper .lt-seg.on:hover{color:#f7f1de}
.lang-toggle.paper .lt-stud{background:#f7f1de;border-color:#14264e;color:#7a1f2b;box-shadow:0 2px 8px rgba(27,39,69,.25)}
@media (max-width:640px){.paper{padding:26px 20px}.cards{grid-template-columns:1fr}}
@media (max-width:640px){.mast-tools{justify-content:center}.paper-tools{justify-content:center}}
`;
function badgesHTML(it, lang) {
  let h = "";
  if (it.kind === "event") h += `<span class="badge evt">${t(lang, "badgeEvent")}${it.event && it.event.mag != null ? " M" + it.event.mag : ""}</span>`;
  if (it.burst) h += `<span class="badge burst">${t(lang, "badgeBurst")}</span>`;
  if (it.unverified) h += `<span class="badge">${it.sourceKey && it.sourceKey.startsWith("4chan-") ? t(lang, "badgeUnverifiedChan") : t(lang, "badgeUnverified")}</span>`;
  return h;
}
function itemCard(it, lang) {
  const search = (it.title + " " + (it.snippet || "") + " " + it.source).toLowerCase().replace(/"/g, "");
  return `<article class="item" data-region="${esc(it.region || "other")}" data-search="${esc(search)}">
<div class="meta"><span class="src">${esc(it.source)}</span> · ${fmtTimeCST(it.ts)} · <span class="region">${esc(regionName(lang, it.region))}</span>${badgesHTML(it, lang)}</div>
<h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
${it.snippet ? `<p>${esc(it.snippet)}</p>` : ""}
</article>`;
}
function marketCard(it, lang) {
  const m = it.market || {};
  const prob = m.prob != null ? Math.round(m.prob * 100) : null;
  const chg = m.chg;
  const chgHTML = chg != null ? `<span class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲" : "▼"} ${(Math.abs(chg) * 100).toFixed(1)}%</span>` : "<span>—</span>";
  const vol = m.vol ? "$" + (m.vol >= 1000 ? (m.vol / 1000).toFixed(1) + "k" : Math.round(m.vol)) : "—";
  return `<article class="item mkt-card" data-region="${esc(it.region || "other")}" data-search="${esc((it.title + " polymarket").toLowerCase())}">
<div class="meta"><span class="src">${t(lang, "mktSourceLine")}</span> · ${t(lang, "mktVol")} ${vol}</div>
<h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
<div class="bar"><i style="width:${prob != null ? prob : 0}%"></i></div>
<div class="mkt-num"><span>${t(lang, "mktProb")} <b>${prob != null ? prob + "%" : "—"}</b></span><span>24h ${chgHTML}</span></div>
</article>`;
}
// Paper presidential brief (same data as /api/brief)
function briefPaperHTML(b, lang) {
  const L = lang === "en" ? "en" : "zh";
  const colon = L === "en" ? ": " : "：";
  const row = (it) => it ? `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a> <span class="sum">— ${esc(it.source)} · ${fmtClockCST(it.ts)}</span><br><span class="sum">${esc(it.summary || "")}</span></li>` : `<li>${t(L, "none")}</li>`;
  const regionRow = (key, it) => `<li><b>${regionName(L, key)}${colon}</b>${it ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a> <span class="sum">（${esc(it.source)}）</span>` : t(L, "none")}</li>`;
  const mktRow = (m) => {
    const prob = m.prob != null ? Math.round(m.prob * 100) + "%" : "—";
    const chg = m.chg != null ? `<span class="${m.chg >= 0 ? "up" : "down"}">${m.chg >= 0 ? "▲" : "▼"} ${(Math.abs(m.chg) * 100).toFixed(1)}%</span>` : "";
    return `<div class="mkt"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.question)}</a><span class="prob">${prob} ${chg}</span></div>`;
  };
  return `<section class="paper" id="brief">
<div class="paper-tools">${langToggleHTML(L, "paper")}</div>
<div class="paper-head">
${sealSVG("paper", 64)}
<h2>${t(L, "paperTitle")}</h2>
<div class="en">${t(L, "paperSub")}</div>
<div class="pdate">${fmtDateLong(L, Date.now())} · ${t(L, "paperDateSuffix")}</div>
<div><span class="stamp">${t(L, "stamp")}</span></div>
</div>
${secHeadHTML(L, 0)}
${b.headline ? `<p><b>${t(L, "leadLabel")}${colon}</b><a href="${esc(b.headline.url)}" target="_blank" rel="noopener">${esc(b.headline.title)}</a><br><span class="sum">${esc(b.headline.summary || "")}</span></p>` : `<p>${t(L, "noData")}</p>`}
<ul>${(b.topStories || []).map(row).join("")}</ul>
${secHeadHTML(L, 1)}
<ul>
${regionRow("na", b.regions && b.regions.na)}
${regionRow("eu", b.regions && b.regions.eu)}
${regionRow("apac", b.regions && b.regions.apac)}
${regionRow("me", b.regions && b.regions.me)}
</ul>
${secHeadHTML(L, 2)}
<ul>${(b.conflict && b.conflict.length ? b.conflict : []).map(row).join("") || `<li>${t(L, "none")}</li>`}</ul>
${secHeadHTML(L, 3)}
${(b.markets && b.markets.polymarket || []).map(mktRow).join("")}
<ul>${(b.markets && b.markets.economy || []).map(row).join("")}</ul>
${secHeadHTML(L, 4)}
<ul>${(b.chatter && b.chatter.length ? b.chatter : []).map((it) => `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a> <span class="sum">— ${esc(it.source)} · ${t(L, "chatterSuffix")}</span></li>`).join("") || `<li>${t(L, "none")}</li>`}</ul>
${secHeadHTML(L, 5)}
<p>${(b.watch && b.watch.length ? b.watch : []).map((w) => `<span class="watch">${esc(w.name)} ↑${w.delta}${L === "en" ? ` (${w.count} items)` : `（${w.count} 条）`}</span>`).join("") || t(L, "watchEmpty")}</p>
<div class="pfoot">${t(L, "paperFoot")}</div>
</section>`;
}

const SOURCE_NAMES = (() => {
  const m = {};
  for (const s of FEED_SOURCES) m[s.key] = s.name;
  Object.assign(m, {
    hn: "Hacker News", gdelt: "GDELT", polymarket: "Polymarket",
    lobsters: "Lobsters", lemmy: "Lemmy", bluesky: "Bluesky", usgs: "USGS 地震",
    "mastodon-ukraine": "Mastodon #ukraine", "mastodon-osint": "Mastodon #osint",
  });
  for (const b of CHAN_BOARDS) m[`4chan-${b}`] = `4chan /${b}/`;
  return m;
})();
const DESK_SECTIONS = [
  { key: "top", num: "I", name: "头条", nameEn: "Top Stories", en: "TOP STORIES" },
  { key: "conflict", num: "II", name: "冲突与安全", nameEn: "Conflict & Security", en: "CONFLICT & SECURITY" },
  { key: "economy", num: "III", name: "经济与市场", nameEn: "Economy & Markets", en: "ECONOMY & MARKETS" },
  { key: "tech", num: "IV", name: "科技前沿", nameEn: "Technology", en: "TECHNOLOGY" },
  { key: "community", num: "V", name: "社区热议", nameEn: "Community Buzz", en: "COMMUNITY BUZZ", blurbKey: "blurbCommunity" },
  { key: "signals", num: "VI", name: "风向与小道", nameEn: "Signals & Chatter", en: "SIGNALS & CHATTER", blurbKey: "blurbSignals" },
];
async function renderPanel(env, lang) {
  const L = lang === "en" ? "en" : "zh";
  const data = await loadJSON(env, CONFIG.kvItems, null);
  const items = data && Array.isArray(data.items) ? data.items : [];
  const meta = await loadJSON(env, CONFIG.kvMeta, null);
  const topicsState = await loadJSON(env, CONFIG.kvTopics, null);
  const brief = buildBrief(items, topicsState, meta);
  const now = Date.now();
  const byScore = [...items].sort((a, b) => b.score - a.score || b.ts - a.ts);
  const hero = byScore.find((i) => i.kind !== "market") || null;
  const healthHTML = meta && meta.sources ? Object.entries(meta.sources).map(([k, h]) =>
    `<span class="${h.ok ? "ok" : "bad"}" title="${h.ok ? esc(t(L, "healthOk", { n: h.count })) : esc(h.error || "failed")}"><span class="dot"></span>${esc(SOURCE_NAMES[k] || k)}</span>`).join("") : "";
  const deskItems = (key) => {
    if (key === "top") return byScore.filter((i) => i.kind !== "market").slice(1, 9);
    if (key === "signals") return byScore.filter((i) => i.kind !== "market" && inSignals(i)).slice(0, 12);
    return byScore.filter((i) => i.desk === key).slice(0, 12);
  };
  const desksHTML = DESK_SECTIONS.map((d) => {
    const list = deskItems(d.key);
    const markets = d.key === "signals" ? byScore.filter((i) => i.kind === "market").slice(0, 6) : [];
    if (!list.length && !markets.length) return "";
    return `<section class="desk" id="desk-${d.key}">
<div class="desk-head"><span class="num">${d.num}</span><h2>${L === "en" ? d.nameEn : d.name}</h2>${L === "en" ? "" : `<span class="en">${d.en}</span>`}</div>
${d.blurbKey ? `<p class="blurb">${t(L, d.blurbKey)}</p>` : ""}
<div class="cards">${markets.map((it) => marketCard(it, L)).join("")}${list.map((it) => itemCard(it, L)).join("")}</div>
</section>`;
  }).join("");
  const statusText = meta ? (meta.ok ? t(L, "statusOk") : t(L, "statusPartial")) : t(L, "statusNone");
  const colon = L === "en" ? ": " : "：";
  const body = items.length ? `
${hero ? `<div class="hero"><div class="kicker">${t(L, "leadKicker")}</div>
<h2><a href="${esc(hero.url)}" target="_blank" rel="noopener">${esc(hero.title)}</a></h2>
<div class="meta"><span class="src">${esc(hero.source)}</span> · ${fmtTimeCST(hero.ts)} · ${esc(regionName(L, hero.region))}${badgesHTML(hero, L)}</div>
${hero.snippet ? `<p>${esc(hero.snippet)}</p>` : ""}</div>` : ""}
${briefPaperHTML(brief, L)}
${desksHTML}` : `<div class="empty">${t(L, "empty1")}<br>${t(L, "empty2")}</div>`;
  return `<!DOCTYPE html>
<html lang="${L === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t(L, "pageTitle")}</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<div class="classif">${t(L, "classif")}</div>
<div class="wrap">
<header class="masthead">
<div class="mast-tools">${langToggleHTML(L)}</div>
${sealSVG("main", 118)}
<h1>${t(L, "mastTitle")}</h1>
<div class="hub-en">${t(L, "mastSub")}</div>
<div class="tagline">${t(L, "tagline")}</div>
<div class="rule"></div>
<div class="statusline">${fmtDateLong(L, now)}${t(L, "beijingTag")} · ${t(L, "statusLabel")}${colon}<b>${statusText}</b> · ${t(L, "lastSweep")} <b>${meta ? fmtTimeCST(meta.ts) : "-"}</b> · ${t(L, "itemsLabel")} <b>${items.length}</b> · ${t(L, "sourcesLabel")} <b>${meta ? meta.sourcesOk + "/" + meta.sourcesTotal : "-"}</b></div>
</header>
<div class="controls">
<button class="btn" id="refreshBtn" type="button">${t(L, "refreshBtn")}</button>
<input class="search" id="searchBox" type="search" placeholder="${t(L, "searchPh")}">
<span>
<button class="chip on" data-region-filter="all" type="button">${t(L, "chipAll")}</button>
<button class="chip" data-region-filter="na" type="button">${regionName(L, "na")}</button>
<button class="chip" data-region-filter="eu" type="button">${regionName(L, "eu")}</button>
<button class="chip" data-region-filter="apac" type="button">${regionName(L, "apac")}</button>
<button class="chip" data-region-filter="me" type="button">${regionName(L, "me")}</button>
</span>
</div>
<nav class="navdesk">
<a href="#brief">${t(L, "navBrief")}</a>${DESK_SECTIONS.map((d) => `<a href="#desk-${d.key}">${d.num} · ${L === "en" ? d.nameEn : d.name}</a>`).join("")}
</nav>
<div class="health-title">${t(L, "healthHeading")}</div>
<div class="health">${healthHTML}</div>
<span id="refreshMsg" style="display:block;text-align:center;color:#c9a227;font-size:12.5px;min-height:16px"></span>
${body}
<footer>${t(L, "footerMain")}<br>
GLOBAL OSINT HUB · RULES-BASED AGGREGATION OF PUBLIC SOURCES · NOT AN OFFICIAL DOCUMENT</footer>
</div>
<button class="fab" id="fabBrief" type="button">${t(L, "fabBrief")}</button>
<script>
var regionFilter = "all";
function applyFilters() {
  var q = (document.getElementById("searchBox").value || "").trim().toLowerCase();
  document.querySelectorAll(".item").forEach(function (el) {
    var okR = regionFilter === "all" || el.getAttribute("data-region") === regionFilter;
    var okQ = !q || (el.getAttribute("data-search") || "").indexOf(q) >= 0;
    el.classList.toggle("hidden", !(okR && okQ));
  });
}
document.getElementById("searchBox").addEventListener("input", applyFilters);
document.querySelectorAll("[data-region-filter]").forEach(function (chip) {
  chip.addEventListener("click", function () {
    document.querySelectorAll("[data-region-filter]").forEach(function (c) { c.classList.remove("on"); });
    chip.classList.add("on");
    regionFilter = chip.getAttribute("data-region-filter");
    applyFilters();
  });
});
document.getElementById("fabBrief").addEventListener("click", function () {
  var el = document.getElementById("brief");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("refreshBtn").addEventListener("click", function () {
  var btn = this, msg = document.getElementById("refreshMsg");
  btn.disabled = true; msg.textContent = ${JSON.stringify(t(L, "jsSweeping"))};
  fetch("/api/refresh", { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.throttled) {
      msg.textContent = ${JSON.stringify(t(L, "jsThrottled"))};
      btn.disabled = false;
    } else {
      msg.textContent = ${JSON.stringify(t(L, "jsDone"))};
      setTimeout(function () { location.reload(); }, 700);
    }
  }).catch(function () { msg.textContent = ${JSON.stringify(t(L, "jsFailed"))}; btn.disabled = false; });
});
</script>
</body>
</html>`;
}

// ============================================================
// 【核心模块】HTTP 路由 — 面板 / 数据接口 / 简报 / 手动巡检 / 手动推送（PUSH_KEY 鉴权）
// ============================================================
async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    if (!env.OSINT_KV) return new Response("OSINT_KV binding missing", { status: 500 });
    const html = await renderPanel(env, resolveLang(request).lang);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname === "/api/items" && request.method === "GET") {
    const data = await loadJSON(env, CONFIG.kvItems, null);
    const items = data && Array.isArray(data.items) ? data.items : [];
    return Response.json({ ok: true, ts: data ? data.ts : 0, count: items.length, items });
  }
  if (url.pathname === "/api/stats" && request.method === "GET") {
    const meta = await loadJSON(env, CONFIG.kvMeta, null);
    return Response.json({ ok: true, meta });
  }
  if (url.pathname === "/api/brief" && request.method === "GET") {
    const brief = await loadBrief(env);
    const blang = resolveLang(request).lang;
    brief.lang = blang;
    brief.labels = briefLabels(blang);
    const targets = resolvePushTargets(env);
    const bp = (await loadJSON(env, CONFIG.kvBriefPush, {})) || {};
    brief.push = {
      configured: { dm: targets.length > 0 },
      anyConfigured: targets.length > 0,
      lastPushDate: bp.date || null,
      targets: bp.date === cstDateStr(Date.now()) ? (bp.targets || {}) : {},
    };
    return Response.json({ ok: true, brief });
  }
  if (url.pathname === "/api/brief/push" && request.method === "POST") {
    // 手动推送：未配 PUSH_KEY 时接口关闭（403 push_disabled）；x-push-key 不一致 401 且不推送、不写节流。
    // 鉴权通过后按目标分别判定 6 小时节流（osint:pushmanual 为 {目标键: ts} 映射）。
    if (!env.PUSH_KEY) return Response.json({ ok: false, pushed: false, status: "push_disabled" }, { status: 403 });
    if (request.headers.get("x-push-key") !== env.PUSH_KEY) return Response.json({ ok: false, pushed: false, status: "unauthorized" }, { status: 401 });
    const targets = resolvePushTargets(env);
    if (!targets.length) return Response.json({ ok: false, pushed: false, status: "not_configured" });
    const stamps = await loadPushManualStamps(env);
    const now = Date.now();
    const eligible = targets.filter((t) => !(stamps[t.key] != null && now - stamps[t.key] < CONFIG.pushThrottleMs));
    const skipped = targets.filter((t) => !eligible.includes(t)).map((t) => t.key);
    if (!eligible.length) {
      const earliest = Math.min(...targets.map((t) => (stamps[t.key] || 0) + CONFIG.pushThrottleMs));
      return Response.json({ ok: true, pushed: false, status: "throttled", retryAfterMs: earliest - now, targets: [], skipped });
    }
    const brief = await loadBrief(env);
    const results = await pushBriefToTargets(env, brief, eligible);
    const anyOk = Object.values(results).some(Boolean);
    if (anyOk) {
      const next = { ...stamps };
      for (const t of eligible) next[t.key] = now;
      await env.OSINT_KV.put(CONFIG.kvPushManual, JSON.stringify(next));
    }
    return Response.json({ ok: anyOk, pushed: anyOk, status: anyOk ? "pushed" : "tg_failed", results, targets: eligible.map((t) => t.key), skipped });
  }
  if (url.pathname === "/api/refresh" && request.method === "POST") {
    const stamp = await loadJSON(env, CONFIG.kvRefresh, null);
    if (stamp && stamp.ts && Date.now() - stamp.ts < CONFIG.refreshThrottleMs) {
      return Response.json({ ok: true, throttled: true, lastSweep: stamp.ts, retryAfterMs: CONFIG.refreshThrottleMs - (Date.now() - stamp.ts) });
    }
    const meta = await runSweep(env);
    try { await purgeOsintCache(url.origin); } catch {}
    return Response.json({ ok: meta.ok !== false, throttled: false, sweep: meta });
  }
  return new Response("not found", { status: 404 });
}

// ============================================================
// 【核心模块】边缘缓存 — 只读 GET 路由（/ /api/items /api/stats /api/brief）走 Cache API 读穿缓存：
// 数据只在巡检时变化，故缓存 30 分钟且巡检后主动失效。存入副本不带 x-osint-cache 标记，
// 命中标 HIT、未命中标 MISS。空数据与错误响应永不缓存；caches 不可用时自动降级为直读。
// ============================================================
const CACHE_PATHS = ["/", "/api/items", "/api/stats", "/api/brief"];
function osintCache() {
  try { return (typeof caches !== "undefined" && caches.default) ? caches.default : null; } catch { return null; }
}
async function osintCacheWorthStoring(pathname, res) {
  if (res.status !== 200) return false;
  try {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = await res.clone().json();
      if (pathname === "/api/items") return (body.count || 0) > 0;
      if (pathname === "/api/stats") return body.meta != null;
      if (pathname === "/api/brief") return !!(body.brief && body.brief.totals && body.brief.totals.items > 0);
      return false;
    }
    const html = await res.clone().text();
    return !html.includes('class="empty"');
  } catch { return false; }
}
async function purgeOsintCache(base) {
  const cache = osintCache();
  if (!cache || !base) return;
  const root = String(base).replace(/\/$/, "");
  const keys = [];
  for (const p of CACHE_PATHS) {
    if (p === "/" || p === "/api/brief") keys.push(root + p + "?lang=zh", root + p + "?lang=en");
    else keys.push(root + p);
  }
  await Promise.all(keys.map(async (k) => {
    try { await cache.delete(k); } catch {}
  }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const langInfo = resolveLang(request);
    // A valid ?lang= persists the preference as a cookie — applied only to the
    // response returned to the browser, never to the copy stored in the cache.
    const withCookie = (res) => {
      if (request.method === "GET" && url.pathname === "/" && langInfo.fromQuery) {
        try { res.headers.set("Set-Cookie", `osint-lang=${langInfo.lang}; Path=/; Max-Age=2592000; SameSite=Lax`); } catch {}
      }
      return res;
    };
    const cache = (request.method === "GET" && env.OSINT_KV && CACHE_PATHS.includes(url.pathname)) ? osintCache() : null;
    if (!cache) return withCookie(await handleFetch(request, env));
    // Panel and brief are cached per language; the other read routes keep neutral keys.
    const localized = url.pathname === "/" || url.pathname === "/api/brief";
    const key = url.origin + url.pathname + (localized ? "?lang=" + langInfo.lang : "");
    try {
      const hit = await cache.match(key);
      if (hit) {
        const out = new Response(hit.body, hit);
        out.headers.set("x-osint-cache", "HIT");
        return withCookie(out);
      }
    } catch {}
    const res = await handleFetch(request, env);
    if (await osintCacheWorthStoring(url.pathname, res)) {
      res.headers.set("Cache-Control", "public, max-age=" + CONFIG.cacheTtlSec);
      const stored = res.clone();
      const putP = Promise.resolve().then(() => cache.put(key, stored)).catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putP);
    }
    res.headers.set("x-osint-cache", "MISS");
    return withCookie(res);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const meta = await runSweep(env);
      try { await purgeOsintCache(CONFIG.panelUrl); } catch {}
      if (meta && meta.ok) await maybePushDailyBrief(env);
    })());
  },
};
