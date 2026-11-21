# 变更日志 · CHANGELOG

## v1.0.0 — 2026-11-21（首个 Release；含当日双语升级）

- **首发上线**：27 个抓取口（通讯社 RSS ×9、专业 OSINT/安全媒体 ×3、Reddit ×3、4chan 六板、HN、GDELT、Polymarket、USGS、Lobsters、Lemmy、Mastodon ×2、Bluesky 尝试接入）；六张情报桌、地区标注、规则评分与去重折叠；来源健康条如实标注被限流/被拒的源。
- **总统简报**：米纸文档块 + `/api/brief`；Telegram 每日私聊推送（08:00 后首轮，按天门禁）；手动推送 `PUSH_KEY` 门禁 + 按目标 6 小时节流。
- **双语（同日升级，随 v1.0.0 一并发布）**：中/英双语面板与简报（54 个 UI 键），金印胶囊切换钮（刊头 + 简报纸面反色版），语言解析 `?lang=` > Cookie（30 天）> Accept-Language > zh；缓存按语言分键；TG 推送保持中文。
- **本地测试**：Mock  harness 107 项断言全过（79 项 v1 巡检/简报/门禁/缓存 + 28 项双语 Phase D）。
- **首轮真实巡检**：281 条入库，15/27 源成功；4chan 403、Reddit 404、Bluesky 403、BleepingComputer 403、GDELT 429 均如实标红，未绕过。
