# mailsift

多邮箱统一监控：把所有邮箱（**包括垃圾箱**）里真正要紧的邮件挑出来，推到飞书 / Webhook。

邮箱多了以后有两个麻烦：一个个点开太累，而误判进垃圾箱的验证码、账单、快递通知又最容易漏。
mailsift 常驻扫描所有邮箱的所有文件夹，用大模型按**你自己的背景**判轻重，只把要紧的推给你，
其余攒成每日简报。

> ⚠️ 这是**辅助工具**，不是邮件客户端的替代品。它只读不写，不能收发、回复、整理邮件，
> 判断也依赖大模型，存在误判可能。请继续以邮件客户端为主，把它当成一层"别漏掉"的兜底。

## 能做什么

- **任何 IMAP 邮箱都能接**，数量不限。QQ / 163 / Gmail / Outlook / iCloud / 企业邮箱混着配都行
- **垃圾箱一起扫**，自动识别各家不同的垃圾箱叫法，可以把垃圾箱里的邮件提级处理
- **按你的背景判轻重**，而不是通用的垃圾邮件分类。你说"银行消费超 200 才推"，它就这么判
- **中英繁都能读**，输出统一是简体中文摘要
- **推送 + 每日简报**两档出口，要紧的实时推，其余攒起来一天看一次
- **崩溃安全**：进程被中断留下的半成品会被检出并告警，`--recover` 可重放，不静默丢邮件
- 可选 **MCP server**，让 AI 助手直接查你的邮件（默认不开）

## 快速开始

```bash
git clone https://github.com/itswl/mailsift.git
cd mailsift
cp .env.example .env
vim .env          # 至少填：一个邮箱账号 + 一个推送出口 + 大模型 key

docker compose up -d
```

不用 Docker（需要 Node >= 22.5）：

```bash
npm install
npm run check     # 先自检配置
npm run dev       # 前台跑
```

## 配置

所有配置都在 `.env` 里，没有第二个配置文件。完整说明见 [.env.example](.env.example)，
这里只讲最关键的三件事。

### 1. 邮箱账号

```bash
MAIL_ACCOUNT_1=qq|me@qq.com|授权码
MAIL_ACCOUNT_1_NAME=QQ主号
MAIL_ACCOUNT_1_FOLDERS=all

MAIL_ACCOUNT_2=163|me@163.com|授权码
MAIL_ACCOUNT_3=imap|me@mycorp.com|密码|imap.mycorp.com
```

序号往下加就能配任意多个，同一家配多个账号也没问题。

这里的"密码"几乎都不是登录密码，而是各家的**授权码 / 应用专用密码**，
一般在邮箱网页版的「设置 → 账户 → IMAP/SMTP」附近开启并生成。

`MAIL_ACCOUNT_N_FOLDERS` 决定扫哪些文件夹：

| 值 | 含义 |
|---|---|
| `all` | 除已发送/草稿/废纸篓外的所有文件夹（**推荐**，归档和自定义文件夹也不漏） |
| `INBOX,spam` | 默认值。`spam` 会自动匹配各家的垃圾箱叫法 |
| 具体名字 | 如 `INBOX,Junk,其他文件夹/test` |

### 2. 告诉它你是谁

`MAIL_CONTEXT` 是判得准不准的关键，它把通用分类器变成你的助理：

```bash
MAIL_CONTEXT=我是一名软件工程师。银行的日常小额消费提醒不用推，只有单笔超过 200 元或出现异常/盗刷才要立刻知道。GitHub 上只是抄送我的 PR 讨论和日常 CI 失败不用推，@我、请我 review、安全公告才推。验证码、账单到期、快递异常要重点关注。
```

> ⚠️ **写成一行**。`.env` 里不加引号的换行会被静默截断成第一行，
> 后面的规则会无声丢失——判得不准还查不出原因。

写得越具体越准。上面这段的实测效果：一笔 496 元的消费判 `critical` 并推送，
22.9 元和 100 元的判 `info` 只进简报。

### 3. 推多少

```bash
PUSH_MIN_IMPORTANCE=warning   # info / warning / critical，嫌吵就调 critical
SPAM_RANK_BONUS=1             # 垃圾箱里的邮件提升 1 档，怕漏就开
DIGEST_ENABLED=true           # 没到门槛的攒成每日简报
DIGEST_HOUR=9
```

三档的含义：`critical` 不及时处理会有实际损失，`warning` 需要你处理但不紧急，
`info` 知会即可。

## Gmail / Outlook

这两家已关闭密码登录，必须走 OAuth，比其他邮箱多一步：

```bash
npm run oauth     # 按提示在浏览器授权，token 存在 data/tokens.json
```

无浏览器的服务器上（Docker 部署）在容器里跑授权，token 直接写进数据卷，不用拷贝：

```bash
docker compose run --rm mailsift node dist/scripts/oauth-setup.js --manual
```

`--manual` 会打印授权链接：在自己电脑的浏览器里打开、同意，浏览器跳到一个
打不开的 `localhost:8765/...` 是正常的——把地址栏里的**完整 URL** 粘回终端即可。

已经在本地授权过的，也可以把 token 直接带走：`data/tokens.json` 与机器无关，
所有账号的 refresh token 都在这一个文件里，拷一次全部生效。源码部署 scp 过去
即可；Docker 部署要拷进命名卷并修正属主（容器以 uid 10001 运行，读不了属主
不对的 600 权限文件）：

```bash
scp data/tokens.json server:~/mailsift/data/     # 源码部署，完事

# Docker 部署（先 docker compose up -d 把卷建起来再执行）：
docker compose cp /tmp/tokens.json mailsift:/app/data/tokens.json
docker compose exec -u root mailsift chown 10001:10001 /app/data/tokens.json
docker compose restart
```

该文件等同邮箱的长期访问凭据，注意别提交进仓库（已在 `.gitignore`）；迁移后
只在一处常驻运行。有效期与失效处理见「常见问题」。

需要先到 Google Cloud Console / Azure 门户注册一个应用拿到 client id/secret，
填进 `.env` 的 `GMAIL_CLIENT_ID` 或 `OUTLOOK_CLIENT_ID`。
不想自己注册应用的话，公开渠道也能搜索到现成可用的公开凭据，填法相同。

个人 Gmail 也可以用 `gmail_pw` + 应用专用密码绕开 OAuth（Workspace 账号不行）：

```bash
MAIL_ACCOUNT_1=gmail_pw|me@gmail.com|应用专用密码
```

> Google Cloud 里应用发布状态若停留在「测试」，refresh token 只有 7 天有效期，
> 到期要重新授权。改成「已发布」即可长期有效。

完全不想碰 OAuth 还有个兜底：让 Gmail 全量转发到 QQ 邮箱（含垃圾邮件，靠过滤器
的「不包含一个永不匹配的字符串」实现全量匹配）。代价是分不清邮件原本发给哪个
邮箱、无法按 Message-ID 跳转，且多一层可能静默中断的转发链路，一般不如直接接
IMAP。注意这个兜底**只对 Gmail 成立**：Outlook.com 的转发和规则只对进了收件箱的
邮件生效，被判为垃圾的压根不会被转发——转发 Outlook 等于丢掉整个垃圾箱，恰恰
是最容易漏要紧邮件的地方。

## 大模型

任何兼容 OpenAI `/chat/completions` 的服务都能接：

```bash
LLM_PROVIDER=deepseek        # 预设：deepseek/xai/glm/minimax/moonshot/openrouter/
LLM_MODEL=deepseek-flash     #       dashscope/siliconflow/openai/zhipu
LLM_API_KEY=sk-xxx
```

接预设之外的服务（含自建中转）就留空 `LLM_PROVIDER`，直接写地址：

```bash
LLM_PROVIDER=
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_MODEL=gpt-5.6-luna
```

不配也能跑，但会退化成关键词匹配，判得很粗。

**成本**：默认每封约 500-1000 token。按 deepseek 的价格，一天几百封邮件的量级
每月也就几块钱。建议给这把 key **单独设一个每日额度上限**，跑飞了有兜底。
嫌贵可以调 `LLM_BODY_CHARS`（默认 1200）和 `LLM_BATCH_SIZE`（默认 10）。

## 运行

```bash
docker compose up -d              # 常驻
docker compose logs -f            # 看日志
docker compose pull && docker compose up -d   # 升级

npm run check                     # 配置自检
npm run dev -- --once             # 只跑一轮就退出（适合 cron）
npm run dev -- --once --dry-run   # 只打印不真发，试配置用
npm run probe                     # 探测邮箱有哪些文件夹、各有多少信
```

源码方式常驻可用 systemd，unit 模板见 [deploy/mailsift.service](deploy/mailsift.service)：

```bash
sudo cp deploy/mailsift.service /etc/systemd/system/mailsift.service
sudo systemctl daemon-reload && sudo systemctl enable --now mailsift
```

首次运行只回看 `INITIAL_LOOKBACK_DAYS`（默认 3）天，不会把历史邮件全推一遍。
如果单个文件夹的首次回看命中超过 `MAX_MESSAGES_PER_LOOKBACK`（默认 500）封，
会跳过整批并推进该文件夹游标，不做历史补账，避免重复回看和刷屏。

每个文件夹单轮最多拉取 `MAX_MESSAGES_PER_POLL`（默认 200）封，所有账号和文件夹合计还受
`MAX_MESSAGES_PER_POLL_TOTAL`（默认 500）限制，防止首次补账一次性刷屏或失控消耗模型额度。
达到上限时只推进已经实际处理的文件夹游标，剩余邮件会留到下一轮，不会被跳过。

状态存在 SQLite（`data/mailsift.db`）里，记录每个文件夹扫到哪了以及每封信的判定结果。
Docker 用命名卷持久化，删容器不丢。

## MCP（可选）

让 Claude 等 AI 助手直接查你的邮件。**默认不启动**，需要时再开：

```bash
docker compose --profile mcp up -d
```

本地 stdio 方式接入，在 MCP 客户端配置里加：

```json
{
  "mcpServers": {
    "mailsift": {
      "command": "node",
      "args": ["/绝对路径/mailsift/dist/src/mcp.js"]
    }
  }
}
```

服务器上的 stdio 还有零配置一招——让 MCP 客户端直接通过 SSH 拉起远程进程，
stdio 走的是 SSH 通道，不用开任何端口：

```json
{
  "mcpServers": {
    "mailsift": {
      "command": "ssh",
      "args": ["server", "node", "/opt/mailsift/dist/src/mcp.js"]
    }
  }
}
```

远程接入用 Streamable HTTP（`.env` 里 `MCP_TRANSPORT=http` 后启动），
端点是 `/mcp`，可配 `MCP_PORT` / `MCP_BIND` / `MCP_TOKEN`（Bearer 鉴权）：

```bash
# Claude Code 接入示例
claude mcp add --transport http mailsift http://服务器:8410/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Docker 的 `--profile mcp` 就是这个模式（容器内绑 0.0.0.0，宿主机默认只发布到
回环地址）。**对外暴露前务必设置 `MCP_TOKEN`**——这个端点能读你所有邮箱的
分诊结果；更稳妥的做法是不设 token、只回环发布，远程走 SSH 隧道。

提供 8 个工具：

| 工具 | 作用 |
|---|---|
| `list_mail` | 列最近的邮件，可按重要性、账号、是否在垃圾箱筛选 |
| `search_mail` | 按关键词搜标题、发件人、摘要 |
| `get_mail` | 看某封信的完整判定结果和正文摘录 |
| `mail_summary` | 按重要性/账号/分类统计 |
| `list_accounts` | 列已配置的账号和各自监控的文件夹 |
| `health` | 各账号与大模型的连通状态 |
| `poll_now` | 立刻触发一轮扫描 |
| `send_digest_now` | 立刻发一份简报 |

## 常见问题

**会不会重复推送？**
正常不会。每封信按"邮箱 + Message-ID"去重，同一封信发到两个邮箱算两条。

进程如果在一封信处理到一半时被杀，这封信会留下一条只有标记、没有结论的记录。
下一轮会检出并告警，跑 `--recover` 把它们放回待处理队列重新走一遍：

```bash
docker compose run --rm mailsift node dist/src/main.js --recover
```

之所以不自动重放，是怕某封信稳定触发崩溃时陷入"每轮重跑一次"的死循环，
白烧模型额度。

**QQ 邮箱为什么每次都扫全部？**
QQ 的 IMAP 不支持 `SINCE` 过滤（实测 1 天和 365 天返回一样多），只能靠本地游标去重。
不影响正确性，只是每轮多一点网络开销。

**会不会把我的邮件标成已读？**
不会。全程以只读模式打开邮箱，用 `BODY.PEEK[]` 取信，不改动任何标记。

**邮件内容会发给大模型吗？**
会，默认发送发件人、标题和正文前 1200 字。介意的话可以调小 `LLM_BODY_CHARS`，
或者干脆不配 `LLM_API_KEY` 走本地关键词匹配，也可以接自建的模型服务。

**OAuth 的 token 会过期吗？要定期续期吗？**
不用管。access_token 约 1 小时过期，程序自动刷新并回写；refresh_token 长期有效，
服务常驻运行时每小时刷新等于持续续命（微软 90 天 / Google 约 6 个月**不用**才会
失效，跑着就碰不到）。会触发失效的情况：改密码、在账号设置里撤销授权、平台
策略变化导致所用的公开凭据失效。撤销授权的入口：

- Outlook 个人账号：[account.live.com/consent/Manage](https://account.live.com/consent/Manage)
  （工作/学校账号在 [myapps.microsoft.com](https://myapps.microsoft.com) →
  右上角头像 → 查看帐户 → 管理应用程序，管理员也可代为撤销）
- Google：[myaccount.google.com/linkedapps](https://myaccount.google.com/linkedapps)
  （或「Google 帐号 → 安全性 → 第三方应用访问」）

失效不会静默：账号连续失败 2 次
（`ACCOUNT_ALERT_AFTER_FAILURES`）即触发推送告警，重新授权即可——tokens.json 里
留着旧记录，要加 `--force`：

```bash
npm run oauth -- --account 邮箱地址 --force
```

## 开发

```bash
npm test          # 147 个测试
npm run typecheck
npm run build
```

## License

MIT
