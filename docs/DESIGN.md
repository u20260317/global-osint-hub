# 设计与研判 · DESIGN

## 视觉体系

「总统简报档案」风：深海军蓝 + 古董金 + 米纸象牙白，酒红密级条压顶（UNCLASSIFIED · OPEN SOURCE INTELLIGENCE），原创抽象徽章（雷达之眼意象，**非任何官方印章的复制**），衬线大标题，报纸式头条 Hero，总统简报呈现为一张米纸文档块（纸面纹理、文档页眉、红色「规则聚合 · 非 AI」印章）。

双语切换器是这套视觉的一部分：金印胶囊钮（双层金边、星钉、激活段金渐变），刊头与简报纸面各一枚，纸面版反色。见主 README「双语」一节。

## 六张情报桌

| 桌 | 判定 |
|---|---|
| I 头条 | 全源按评分排序，前列条目另以 Hero 呈现 |
| II 冲突与安全 | 冲突关键词 + cyber 关键词（勒索/漏洞/ransomware/breach…）；Bellingcat 来源默认入此桌 |
| III 经济与市场 | 央行/利率/通胀/关税等关键词 |
| IV 科技前沿 | AI/芯片/航天等关键词；Lobsters 帖命中可由社区桌改道至此 |
| V 社区热议 | 社区型来源（HN/Reddit/Lobsters/Lemmy/Mastodon/Bluesky/4chan） |
| VI 风向与小道 | Polymarket 信号卡 + GDELT 突发 + USGS 事件 + 社区小道 |

地区判定：关键词，优先级 中东 > 亚太 > 欧洲 > 北美（事件发生地优先于表态方），其余为「全球」。短英文词（≤3 字母）用单词边界匹配，避免 war 命中 warning 之类误报。

## 评分

`score = 层级权重（tier1 50 / tier2 35 / tier3 20）+ 新鲜度（≤30，24h 线性衰减）+ 社交加成（≤20，HN 分数 / 4chan 回复数 / 社区互动）`。

去重：URL 规范化 + 标题双路；同一 URL 被聚合源与原文同时抓到时，折叠保留**高层级原文**。

## 诚实标注规则（不可妥协）

- 社区/匿名来源（Reddit、4chan、Mastodon、Lemmy、Bluesky）条目强制 `unverified` 标记；4chan 仅进社区桌与风向桌，简报里仅进「小道消息」栏。
- USGS 地震等官方监测事件不标未证实（`kind=event`）。
- 来源不可达时健康条如实标红并写错误原文，**不伪造、不绕过**：首轮巡检即如实记录 4chan 403（平台封 Cloudflare 服务器 IP）、Reddit 404、Bluesky 403、BleepingComputer 403、GDELT 429。
- 简报与面板多处明示「规则聚合，非 AI 生成，非官方立场」。
- 无公开接口、须爬登录墙的平台（X / Gab / Truth Social）明确不接。
