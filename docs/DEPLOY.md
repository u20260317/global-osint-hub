# 部署手册 · DEPLOY

单文件 Worker，零依赖，数据存 KV。部署顺序：

1. **KV 命名空间**：创建命名空间（如 `global-osint-hub-data`），绑定名必须为 **`OSINT_KV`**。
2. **Worker**：上传 `worker.js`（脚本名示例 `global-osint-hub`），开启 workers.dev 子域名。`CONFIG.panelUrl` 改为你的面板地址（简报推送里的链接用它）。
3. **Cron**：`47 */6 * * *`（UTC），即北京时间 02:47 / 08:47 / 14:47 / 20:47。与其他面板错峰，避免同分钟抢额度。
4. **Secrets（可选）**：
   - `TG_BOT_TOKEN` + `TG_CHAT_ID`：每日总统简报私聊推送（每天 CST 08:00 后首轮巡检推送，按天门禁，失败当天后续巡检重试）。
   - `PUSH_KEY`：手动推送接口 `POST /api/brief/push` 的钥匙（请求头 `x-push-key`）；不配则该接口 403 禁用。
5. **验收**：打开面板点「立即巡检」，确认条目出现、来源健康条有绿点；`/api/stats` 返回最近一轮巡检元信息。

## 省流约定（Workers 免费版）

- 一轮巡检约 28 个子请求，低于免费版单次 50 子请求上限；单源失败只记健康状态，绝不拖垮整轮。
- Cron 每 6 小时一轮；手动巡检 30 分钟节流（KV `osint:refresh`）。
- 只读 GET 接口走边缘缓存 30 分钟，巡检后主动失效（中英双键 + 中性键全清）。
- KV 写入每轮仅数个键；条目保留 48 小时、上限 400 条。

## KV 键

| 键 | 内容 |
|---|---|
| `osint:items` | 条目数组（≤400 条 / 48h） |
| `osint:meta` | 最近一轮巡检元信息（时间、每源健康、新增数） |
| `osint:topics` | 话题命中快照（供简报「明日关注」跨轮对比） |
| `osint:briefpush` | 每日推送门禁（日期戳） |
| `osint:pushmanual` | 手动推送按目标节流戳 |
| `osint:refresh` | 手动巡检节流戳 |
