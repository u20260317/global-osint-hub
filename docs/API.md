# 接口手册 · API

基础地址即面板地址。只读 GET 接口走边缘缓存（TTL 30 分钟，响应头 `x-osint-cache: HIT/MISS`，巡检后失效；空数据与错误响应不缓存）。

| 接口 | 说明 |
|---|---|
| `GET /` | 面板（服务端渲染）。支持 `?lang=zh\|en`，见下 |
| `GET /api/items` | 当前全部条目：标题、链接、来源、tier、desk、region、score、未证实标记、时间 |
| `GET /api/stats` | 最近一轮巡检元信息：时间、条目数、新增数、每来源健康（ok/错误原文） |
| `GET /api/brief` | 总统简报结构化数据：头条研判、地区动态、冲突与安全、市场风向、小道消息、明日关注 + 推送状态 |
| `POST /api/refresh` | 手动触发巡检；30 分钟节流，节流中返回剩余等待 |
| `POST /api/brief/push` | 手动推送简报到 Telegram 私聊；需 `PUSH_KEY` |

## 双语参数

`/` 与 `/api/brief` 接受 `?lang=zh|en`。解析顺序：合法 `?lang=` > Cookie `osint-lang`（30 天）> `Accept-Language` > zh。`/api/brief?lang=en` 在 `brief` 内附带 `lang` 与 `labels`（分节/地区名本地化）；条目内容恒为来源原文；Telegram 推送恒为中文。缓存按语言分键，互不串味。

## PUSH_KEY 门禁

`POST /api/brief/push`，请求头 `x-push-key: <PUSH_KEY>`：

- 未配置 `PUSH_KEY` → 403（接口禁用）
- 钥匙错误 → 401，且不发送、不写节流戳
- 成功 → 按目标 6 小时节流（`osint:pushmanual` 存每目标时间戳）
