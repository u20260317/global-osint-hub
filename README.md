<p align="center">
  <img src="docs/assets/banner.jpg" alt="GLOBAL OSINT HUB" width="100%">
</p>

<h1 align="center">全球 OSINT 枢纽 · GLOBAL OSINT HUB</h1>

<p align="center">
  总统府级的开源情报面板：27 路全球来源巡检 · 六张情报桌 · 每日总统简报 · 中英双语金印切换<br>
  A presidential open-source intelligence hub — 27 global feeds, six desks, a daily President's Brief, bilingual by a golden seal switch.
</p>

<p align="center">
  <a href="https://global-osint-hub.u20261103.workers.dev"><b>在线面板 Live Panel</b></a> ·
  <a href="docs/README.md">文档 Docs</a> ·
  <a href="docs/DEPLOY.md">部署 Deploy</a> ·
  <a href="docs/DESIGN.md">设计 Design</a> ·
  <a href="docs/API.md">接口 API</a> ·
  <a href="docs/CHANGELOG.md">变更日志 Changelog</a>
</p>

一个跑在 Cloudflare Workers 上的「总统简报档案」风格公开情报聚合面板：定时巡检全球新闻通讯社、专业 OSINT 媒体、开发者/联邦社区、预测市场与自然事件监测，用**规则引擎**（不是 AI）做分类、地区标注与评分，每天组装一份纸面质感的「总统简报」。

单文件 `worker.js`，零依赖，数据存 KV。视觉：深蓝 + 金 + 米纸，酒红密级条，原创抽象徽章（非任何官方印章），衬线大标题。

## 来源（共 28 个抓取口，一轮巡检约 28 个子请求，低于免费版 50 上限）

层级：tier 1 通讯社/主流媒体（权重 50）、tier 2 聚合/专业媒体/官方监测（35）、tier 3 社区/开放数据（20，信号弱、需交叉验证）。

| 来源 | 类型 | Tier | 说明 |
|---|---|---|---|
| BBC World | RSS | 1 | 世界新闻 |
| The Guardian World | RSS | 1 | 世界新闻 |
| Al Jazeera | RSS | 1 | 世界新闻（中东视角） |
| NYT World | RSS | 1 | 世界新闻 |
| France 24 | RSS | 2 | 国际台 |
| Google News World | RSS | 2 | 聚合（与原文同 URL 时折叠保留高层级原文） |
| Bellingcat | RSS | 2 | 专业 OSINT 调查，来源默认进冲突/安全桌 |
| Krebs on Security | RSS | 2 | 网络安全，cyber 关键词进安全桌 |
| BleepingComputer | RSS | 2 | 网络安全，同上 |
| Hacker News（Algolia） | API | 3 | 社区桌 |
| Reddit r/worldnews / r/geopolitics / r/technology | Atom | 3 | 社区桌，未证实标记；**服务端抓取常被 Reddit 限流（429）**，失败只记健康状态、社区桌由其他源兜底 |
| Lobsters | JSON | 3 | 技术社区，可按关键词改道科技桌 |
| Lemmy（lemmy.world） | API | 3 | 联邦社区，未证实标记 |
| Mastodon #ukraine / #osint | API | 3 | 联邦社交，未证实标记，进社区桌与风向桌 |
| Bluesky 搜索 | API | 3 | **尝试性接入**：出口 IP 受限时返回 403，与 Reddit 同等待遇，面板如实标红 |
| GDELT | API | 3 | 全球事件长尾覆盖，带「突发」标记进风向桌 |
| Polymarket | API | 信号 | 预测市场：概率、24h 涨跌、成交量，风向桌信号卡 |
| USGS 地震（4.5 级+/24h） | GeoJSON | 2 | 官方监测，kind=event，进风向桌带「突发 · 自然」徽章 |
| 4chan /news/ /pol/ /int/ /biz/ /g/ /k/ | catalog API | 3 | **匿名社区 · 未证实**：跳过置顶/关闭帖，卫生过滤（标题 <8 字符、纯链接/文件名丢弃），每板块按回复数取前 8，进社区桌与风向桌 |

面板顶部的来源健康条实时显示每个来源的 ok/失败状态（含被限流的 Reddit、被拒的 Bluesky），不掩饰。

## 情报桌（Desks）

| 桌 | 内容 |
|---|---|
| I 头条 | 全源按评分排序（头条条目另有报纸式 Hero 展示） |
| II 冲突与安全 | 战争/冲突 + cyber（勒索/漏洞/黑客/ransomware/breach…）关键词命中；Bellingcat 默认入此桌 |
| III 经济与市场 | 央行/利率/通胀/关税等关键词 |
| IV 科技前沿 | AI/芯片/航天等关键词（Lobsters 社区帖可改道至此） |
| V 社区热议 | HN / Reddit / Lobsters / Lemmy / Mastodon / Bluesky / 4chan（用户生成内容） |
| VI 风向与小道 | Polymarket 信号卡 + GDELT 突发 + USGS 事件 + Reddit/4chan/Mastodon 小道 |

地区标签（关键词判定，优先级 中东 > 亚太 > 欧洲 > 北美）：北美 / 欧洲 / 亚太 / 中东 / 全球，面板可按地区筛选。

评分 = 层级权重（50/35/20）+ 新鲜度（≤30，24h 线性衰减）+ 社交加成（HN 分数 / 4chan 回复 / 各社区互动，≤20）。

## 每日总统简报

面板内的米纸文档块（同时提供 `GET /api/brief`）：头条研判、地区动态（北美/欧洲/亚太/中东各一）、冲突与安全、市场风向（Polymarket 概率 + 经济桌）、小道消息（未证实）、明日关注（话题命中数与上轮快照对比的升温话题）。

Telegram：配置 `TG_BOT_TOKEN` + `TG_CHAT_ID` 后，每天 CST 08:00 后首轮巡检把简报文本推到私聊（仅 DM 一个目标，按天门禁，失败当天后续巡检重试）。手动推送 `POST /api/brief/push` 需 `PUSH_KEY`（请求头 `x-push-key`）：未配密钥 403 关闭、错钥匙 401、按目标 6 小时节流。

## 双语（中 / 英）

面板与简报支持中文（默认）/ English 双语，仅 UI 层本地化：条目标题、摘要、来源名保持原文，Telegram 推送文案恒为中文。

- **语言解析顺序**：合法 `?lang=`（zh | en）> Cookie `osint-lang` > `Accept-Language` 首项（en → 英文、zh → 中文）> zh。
- **金印切换器**：刊头右上与简报纸面各一枚胶囊形切换钮——双层金边、深蓝底、衬线小 caps 分段（中文 / ENGLISH），激活段金渐变填充配藏青字、左缘金色星钉，悬停泛金光；纸面版反色（藏青双线描边，激活段藏青填充配米色字）。点击即整页重载（`/?lang=zh` / `/?lang=en`，服务端渲染、无 JS 状态），窄屏自动居中换行。
- **偏好记忆**：合法 `?lang=` 的面板响应带 `Set-Cookie: osint-lang=<lang>`（30 天）；Cookie 只写在返回浏览器的响应上，绝不写进边缘缓存副本。
- **缓存按语言分键**：`/` 与 `/api/brief` 的缓存键带 `?lang=<lang>`，巡检后 zh / en 两份一并失效；`/api/items`、`/api/stats` 保持语言中性键。
- **简报接口**：`GET /api/brief?lang=en` 在 `brief` 内附带 `lang` 与 `labels`（分节名 / 地区名本地化），默认 zh 载荷形状不变；日期行英文为长格式（如 November 21, 2026）。

## 部署

1. 创建 KV 命名空间，绑定名 **`OSINT_KV`**。
2. 部署 `worker.js` 为 Worker（脚本名 `global-osint-hub`），开启 workers.dev 子域名。
3. Cron 触发器：`47 */6 * * *`（UTC；对应北京时间 02:47 / 08:47 / 14:47 / 20:47，省流节奏）。
4. Secrets（可选，按需）：
   - `TG_BOT_TOKEN`、`TG_CHAT_ID`：每日简报私聊推送
   - `PUSH_KEY`：手动推送接口钥匙（不配则该接口禁用）
5. 打开面板点「立即巡检」验证首轮数据（手动巡检有 30 分钟节流）。

## 接口

| 接口 | 说明 |
|---|---|
| `GET /` | 面板（服务端渲染） |
| `GET /api/items` | 当前全部条目（含 desk/region/score/未证实标记） |
| `GET /api/stats` | 最近一轮巡检元信息与每来源健康 |
| `GET /api/brief` | 总统简报结构化数据（含推送状态） |
| `POST /api/refresh` | 手动巡检（30 分钟节流） |
| `POST /api/brief/push` | 手动推送简报（PUSH_KEY 鉴权） |

只读 GET 接口走边缘缓存（30 分钟，响应头 `x-osint-cache: HIT/MISS`），巡检后自动失效；空数据与错误响应不缓存。

KV 键：`osint:items`（条目，≤400 条/48h）、`osint:meta`、`osint:topics`（话题快照）、`osint:briefpush`、`osint:pushmanual`、`osint:refresh`。

## 数据诚实说明

- 本站为公开来源自动聚合，分类/评分/简报均为**规则引擎**产出，非 AI 生成、非官方立场。
- Reddit、4chan、Mastodon、Bluesky、Lemmy 等社区内容为用户生成，**未经证实**，面板与简报均有标记；请以原文与官方发布为准。
- 来源不可达（限流/出口受限）时面板如实标红，不伪造数据。

## 本地测试

`/tmp/osint-harness.mjs`（Mock KV/fetch/caches + 全部来源夹具）：**79 项断言全过**，覆盖 RSS/Atom 双风格解析、实体解码、URL+标题双去重、同 URL 多源折叠保留高层级、desk/region 分类（含 cyber→安全、Bellingcat 默认桌、Lobsters flex 改道）、评分排序、Reddit 429 与 Bluesky 403 的优雅降级、4chan 置顶/关闭跳过与卫生过滤、Polymarket 概率解析、USGS 事件、简报全节组装与小道未证实标记、话题升温（双轮对比）、巡检节流、PUSH_KEY 门禁（403/401/成功/节流）、每日推送按天门禁、缓存 MISS→HIT 与巡检后失效。双语版新增 Phase D 28 项断言：默认 zh 渲染与金印切换器中文段激活、纸面反色切换器、?lang=en 全英文界面（六桌与简报分节英文名齐全、12 个中文界面词零残留）、Cookie 回写（30 天）与缓存副本无 Set-Cookie、en 缓存 MISS→HIT 且 zh 键独立、巡检后双语缓存一并失效、仅 Cookie / Accept-Language 亦可命中英文、非法 ?lang=fr 回退 zh、/api/brief?lang=en 标签本地化而 TG 推送文案恒中文——合计 **107 项断言全过**。
