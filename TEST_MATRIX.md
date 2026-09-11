# 斗地主测试矩阵

2026-09-11，`codex/guest-rooms`，Node 24.17.0。本轮全部使用临时数据及人工身份，未调用线上模型。

| 检查 | 实际结果 | 证据入口 |
|---|---|---|
| 规则、牌型、压制、发牌、结算、存档 | 通过 | `npm test` 中既有 rules / adapters / service |
| 原选人组合、本地与模型路由、停止行为 | 通过 | `scripts/test-modes.js` |
| 官端身份、排他 lease、合法动作、过期与重复提交 | 通过 | `scripts/test-official-player.js` |
| 同 response 多次 wait/read/act、最新游标、15 秒空等、请求取消留座 | 通过 | `scripts/test-doudizhu-mcp.js`，实际本地 MCP HTTP |
| 官端活动保留、重启恢复、真实空闲及明确结束 | 通过 | `scripts/test-seat-lifecycle.js`；25 小时是模拟时钟，不是本轮真实时长 |
| Guest 签发、同名不同身份、私牌、越权、原座恢复 | 通过 | `scripts/test-guest-rooms.js` |
| 多房间实例/文件、异房计时 token、结束与离开分离、挂起/失败写入不开放授权、结束后排队回调不能复活房间 | 通过 | `scripts/test-guest-rooms.js` |
| Cookie / Origin、匿名拒绝、跨房读取/头像/动作、WS 连接与冒充拒绝 | 通过 | `scripts/test-guest-http.js`，真实 HTTP + WebSocket |
| 独立广播、多人同桌、本地 AI 出牌、断开与重连、服务重启、房主结束 | 通过 | `scripts/test-guest-http.js` |
| 两个独立浏览器上下文，实际 DOM 私牌、同名不同 Guest、刷新原座、手机宽度 | 通过 | `scripts/test-game-ui.js`，本地 Edge + Playwright |
| 原官端 UI、选人、资料/头像、IME、聊天道具、离开浏览器留座、直接/iframe 返回 | 通过 | 同一个 `scripts/test-game-ui.js`；没有替换原回归 |
| 语法、diff 空白检查、静态资源版本 | 通过 | `node --check`、`git diff --check`、`test-standalone.js` |
| 管理员旧主桌迁移：指定访客、陌生人拒绝、原名字/分数保留、幂等、活跃牌局/官端席位拒绝 | 通过 | `scripts/test-guest-rooms.js`，先红后绿，原真实裁判存储 |
| 隧道等待 MCP 启动、子进程退出与凭据隔离 | 通过 | `bash scripts/test-container.sh`；等待参数缺失时失败 |

`npm test` 已包含两份新增服务端回归。浏览器回归沿用开发机已安装的 Playwright：
设置 `PLAYWRIGHT_MODULE` 为模块路径后运行 `node scripts/test-game-ui.js`；默认 `PLAYWRIGHT_CHANNEL=msedge`。
测试只创建/删除自己的临时目录，测试子进程屏蔽真实 Gateway/MCP 环境变量；官端回归使用人工 MCP 身份。

## 消融对照

在 `test-guest-rooms.js` 内，将**同一真实裁判和手牌**交给两种解析方式：

| 验证 | 新 session→room→seat | 旧固定 aurex + 单裁判映射 |
|---|---|---|
| A/B 不同席位 | 通过 | 失效 |
| B 得到自己的手牌 | 通过 | 失效，得到 A 的手牌 |
| A 访问 C 的房间被拒绝 | 通过 | 失效 |
| 第二个房间使用独立裁判 | 通过 | 失效 |
| B 凭原 Cookie 恢复自己的席位 | 通过 | 失效，仍映射 A |
| A 回合时 B 通过裁判轮次检查 | 拒绝 | 旧映射会以 A 通过 |

旧映射仅存在于测试进程，不增加关闭鉴权的生产开关；没有把实际旧版本部署到公网。
恢复存档、真实 HTTP/WS 及两个浏览器的验证另行执行，不能用消融探针替代这些检查。
保留了一个确有作用的绑定边界，没有添加通用 Controller 接口、持久化 Session 副本或插件层。

基线 `npm test` 曾在静态版本断言失败：JS 实际 `20260907seat`，断言仍为 `20260907freeplayers`。
本轮修改页面后统一发布标记为 `20260911guestrooms`，同时更新对应精确断言，没有移除检查。

未执行：云端部署/真实公网朋友邀请、三星实机、真实付费模型、多进程共享存储、旧线上房主迁移。
本轮官端证据是本地回归；普通 ChatGPT 旧验收仅沿用 README 历史记录，不冒充本轮实测。
