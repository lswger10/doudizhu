# Aevi 家庭斗地主

## 小家 TEST 娱乐室接入

`codex/tidal-entertainment` 分支供小家「娱乐室 → 斗地主」使用，原 main 保留。
默认本地策略；开局前可切换椒椒/老克模型模式，当前场内固定模式。
模型使用 Gateway 中两人的私聊 Profile 绑定和版本化人设，仅发送当前手牌和
公开牌桌信息，不读取私人聊天、长期记忆或日历。每次模型决策只尝试一次，
裁判仍验证动作；失败或超时按原规则代打。模型回合最多 60 秒。
停止模型场、关闭最后一个牌桌连接或重启服务时停止模型场，保留已有积分与
终止记录；已发出的模型请求可能已经计费。默认不开任何付费验收。

Dockerfile 使用 Node 24，私网监听 `8080`，挂载持久卷到 `/data`。
仅配置 `DOUDIZHU_GATEWAY_URL`（Gateway 私网根地址）和独立
`DOUDIZHU_SERVICE_KEY`（与 Gateway 同名变量匹配）即可启用模型按钮。
浏览器不持有该凭据。Tidal nginx 对牌桌与 HTTP/WebSocket API 统一执行
Relay 登录校验；不要为这个无独立账号系统的服务直接配置公开域名。
部署前同步 Tidal 云端 Dockerfile COPY 覆盖项，先启动游戏服务再更新 nginx。

牌局/积分仍由本服务 JSON 文件唯一持久化。内部旧座位 ID 保留，显示名为
薇薇、椒椒、老克和本地牌友。本地模式只是策略玩家，不代表调用了人物模型。
手机大厅支持竖屏；实际牌桌沿用横向布局。素材许可说明仍然有效。

一张带实时裁判、AI 命令适配器、聊天、表情、互动道具、四套桌布、背景音乐和完整扑克牌素材的浏览器斗地主牌桌。

这个仓库只包含斗地主模块，不包含 Aevi 主站、聊天系统、Bio、记忆、人格提示词、VPS 配置或任何真实运行存档。

## 直接运行

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

打开 <http://127.0.0.1:8788/doudizhu/>。

公开版默认给三个 AI 座位接入了真实的本地策略玩家，不需要 API Key，也不会使用 mock 数据。裁判服务会在首次运行时创建 `data/doudizhu/`，保存积分、资料和牌局状态。

## 包含什么

- 54 张完整牌组、牌型识别、比较、发牌、叫分、过牌、炸弹/王炸、春天/反春天与跨局积分
- 15 秒回合时限，适配器异常时由裁判兜底，牌局不会卡死
- WebSocket 实时状态同步和 HTTP 操作接口
- 4 / 8 / 16 / 24 局家庭场，默认 4 局；固定一个真人座位，从三位 AI 中任选两位上桌
- 牌桌聊天、整场结束后按局整理的聊天记录与一键复制（支持摘要、整页展开、收起和退出）、13 个表情、番茄/鸡蛋/干杯互动道具、玩家资料与解散投票
- 四套桌布、完整图片素材、浏览器音效，以及 `normal.mp3` / `intense.mp3` 两首背景音乐
- 可替换的 stdin/stdout JSON 命令玩家协议

## 项目结构

```text
public/doudizhu/          前端牌桌与全部图片/音频素材
src/doudizhu-rules.js    牌组和牌型规则
src/doudizhu-service.js  权威裁判、状态机、计分和持久化
src/doudizhu-adapters.js 命令玩家进程管理与输出校验
src/server.js             独立 HTTP/WebSocket 服务
scripts/                  本地策略玩家和测试
```

## 接入自己的 AI

每个命令玩家从 stdin 接收一行 JSON，并向 stdout 输出一个 JSON 对象。最小输出示例：

```json
{"action":{"type":"play","cards":["S3"]},"say":"","emote":null,"prop":null}
```

首次运行后可修改 `data/doudizhu/players.json` 中对应玩家的 `command`、`cwd` 和 `env`。裁判会验证所有动作；超时、崩溃、非法 JSON 或非法出牌会重试一次，仍失败则自动代打。

## 测试

```bash
npm test
```

测试覆盖牌型、压制关系、AI 输出归一化、发牌与叫分、炸弹倍数、春天/反春天、持久化、互动、解散投票，以及完整扑克牌和两首 MP3 的资源校验。

## 许可

程序代码和文档使用 MIT License。图片与音频的许可边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，Kenney 音效许可保留在素材目录中。
