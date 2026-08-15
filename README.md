# dsh-channel-telegram

Telegram **薄桥**插件：把 DSH 的 agent 通过 Telegram Bot 暴露出来——长轮询接收私聊消息，按 chatId 映射一个 DSH agent 会话（session id `telegram-<chatId>`），走与 ACP 桥完全相同的驱动模式（`agents.create` → `agent.followup` → `agent.whenIdle`），回复最终 assistant 文本。

独立交付：不需要改动 DSH 仓库；DSH 的 Host loader 支持**绝对路径插件 entry**（`mountRootInclude` 对 `isAbsolute` 的 name 直接 file-URL 加载）。

## 文件

| 文件 | 说明 |
|---|---|
| `index.mjs` | Cordis 插件本体（named exports：`name`/`inject`/`Config`/`apply`，规避 Loader 默认解包丢 Config 的问题） |
| `telegram-client.mjs` | 纯 Bot API 客户端（无 DSH 依赖，POST JSON body；4096 分块；401/409 错误映射） |
| `cordis.telegram.yml` | DSH overlay 模板（`insert` 进用户 patch 层） |
| `test/telegram-client.test.mjs` | mock Bot API 服务器单测（`node test/telegram-client.test.mjs`） |

## 启用步骤

1. **Bot token**：@BotFather 建 bot，拿 token。DSH 进程环境需有 `TELEGRAM_BOT_TOKEN`（改 `tokenEnv` 可换变量名）。
2. **拿到你的 chat id**：给 @userinfobot 发条消息即可看到。
3. **配置**：把 `cordis.telegram.yml` 的 `insert` 合并进 `$DSH_HOME/cordis.patch.yml`（全部 profile）或 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（单 profile），`allowlist` 填你的 chat id（**空 = 全部拒绝**）。
4. **重启 dsh web**（新 host 插件在启动时加载），日志应出现 `[dsh-channel-telegram] connected as @...`。

```yaml
- insert:
    - id: channel-telegram
      name: dsh-channel-telegram          # bundle 安装后按包名解析
      config:
        tokenEnv: TELEGRAM_BOT_TOKEN
        allowlist: [123456789]            # 你的私聊 id
        # workspace: /abs/path            # 可选，agent 会话 cwd（默认 ~/.dsh-telegram/workspace）
        # provider: los-gateway           # 可选：agent 走的 provider 路由（比如上一轮配的 los 网关）
        # model: deepseek                 # 可选：该路由上的模型
```

本地开发（未安装 bundle、直接引用源码）时把 `name` 换成
`/absolute/path/to/dsh-channel-telegram/index.mjs`（DSH Host loader 支持
绝对路径插件 entry）。

## 行为

- **允许名单**：非 allowlist 的私聊第一次收到"未授权"提示；非私聊（群/频道）忽略。
- **每聊一会话**：`telegram-<chatId>`，会话内上下文连续；`/new` 销毁重建。
- **串行队列**：每个 chat 一个队列，长任务不阻塞轮询；忙碌时新消息排队。
- **回复**：turn 结束发最终 assistant 文本（>4096 自动分块）；期间发 typing 动作。多步工具调用只取最后一条 assistant 消息。
- **命令**：`/start`、`/help`、`/new`、`/status`。
- **轮询**：getUpdates 长轮询（timeout 30s）+ 指数退避；409（双 poller）或 401（token 失效）自动停轮询并报错。
- **生命周期**：插件 dispose 时停止轮询并 dispose 所有 agent。

## 安全

v1 与 ACP/web 同信任模型：agent 继承宿主全局权限设置（含默认 permission preset）。**allowlist 是唯一闸门**——bot token 泄露或 allowlist 配错都会让外部聊天驱动 agent。建议：bot 只开私聊、token 严格保管、在低权限 preset 或独立 DSH profile 下运行本插件。

## 已知限制（v1）

- 无流式输出（等整轮完成才回复）；无媒体处理（只收文本消息）。
- 会话映射在内存中（重启后 `/new` 语义自然达成：新 agent 新会话）。
- 未做消息去重（getUpdates offset 已保证不重投，但 DSH 侧 no-op 确认）。
