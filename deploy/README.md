# Docker 与 FRP 部署

本方案同时提供以下两个入口，并使用同一份 SQLite 数据：

```text
局域网：http://本地服务器IP:4173
公网：https://云服务器公网IPv4
```

云服务器只需要运行 `frps`。sixPlan、Caddy、frpc、证书和数据全部位于本地服务器。

## 前置条件

- 本地服务器已安装 Docker Engine 和 Docker Compose v2。
- 云服务器具有固定公网 IPv4。
- 云服务器的 `80`、`443` 和 FRP 控制端口可用。
- 云服务器安全组和防火墙允许这些端口。
- 本地服务器可以主动连接云服务器的 FRP 控制端口。

公网 IP 证书由 Let's Encrypt 免费签发，是有效期约六天的短期证书。Caddy 使用 ACME `shortlived` 配置自动申请和续期，因此公网 `80/443` 必须持续转发到本地 Caddy，且 `sixplan-caddy-data` volume 不应删除。

## 选择应用版本

项目保留两条独立的产品分支：

| 版本 | 分支 | 适用方式 |
| --- | --- | --- |
| v0.1 简化版 | `codex/v0.1-simple` | 节点内部使用一层有序子阶段，不包含子计划关联；该分支包含 `v0.1.0` 标签发布后的最新修改 |
| v0.2 子计划版 | `codex/v0.2-child-plans` | 节点可以关联普通计划作为子计划，适合需要独立 DAG 的阶段 |

这两个版本是并行方案，不是必须逐级升级的前后版本。部署最新分支前，先获取远程更新并切换到需要的分支：

```bash
git fetch origin --prune --tags
git switch codex/v0.1-simple
git pull --ff-only origin codex/v0.1-simple
```

部署 v0.2 时，将上面两处 `codex/v0.1-simple` 换成 `codex/v0.2-child-plans`。如果需要严格复现发布时的历史快照，可使用 `git switch --detach v0.1.0` 或 `git switch --detach v0.2.0`；标签不会包含对应分支之后的新修改。

### 分别保存两个版本的数据

两个版本不得直接共用同一个生产数据库。Compose 支持通过 `SIXPLAN_DATA_VOLUME` 指定数据卷：

```bash
# v0.1
SIXPLAN_DATA_VOLUME=sixplan-v01-data docker compose up -d --build

# v0.2
SIXPLAN_DATA_VOLUME=sixplan-v02-data docker compose up -d --build
```

使用 PowerShell 时先设置当前终端的环境变量：

```powershell
$env:SIXPLAN_DATA_VOLUME="sixplan-v01-data"
docker compose up -d --build
```

也可以在 `.env` 中固定填写 `SIXPLAN_DATA_VOLUME=sixplan-v01-data` 或 `SIXPLAN_DATA_VOLUME=sixplan-v02-data`。已有部署如需继续使用原数据，应保持默认的 `sixplan-data`，不要在未迁移数据的情况下改名。

切换版本时先在网页中创建备份，再停止当前版本、切换分支、选择对应数据卷并重新构建：

```bash
docker compose down
git switch codex/v0.2-child-plans
git pull --ff-only origin codex/v0.2-child-plans
SIXPLAN_DATA_VOLUME=sixplan-v02-data docker compose up -d --build
```

启用 FRP 时，启动命令同样需要设置对应的 `SIXPLAN_DATA_VOLUME`，并追加 `-f compose.yaml -f compose.frp.yaml`。当前 Compose 配置使用固定的 HTTP/HTTPS 端口、容器网络和 FRP 入口，因此一次只运行一个版本；切换数据卷不会自动迁移数据，也不要把一个版本的全站备份直接恢复到另一个版本。

## 只启动局域网 HTTP

在项目目录执行：

```bash
docker compose up -d --build
```

访问 `http://本地服务器IP:4173`。应用数据保存在 `SIXPLAN_DATA_VOLUME` 指定的 volume 中，未设置时使用 `sixplan-data`。

## 配置云服务器 frps

以 [frps.toml.example](./frps.toml.example) 为模板创建 `frps.toml`，将 `auth.token` 替换为足够长的随机十六进制令牌。云服务器仍按你现有的方式启动 frps，不需要安装 Caddy、Nginx、证书工具或 sixPlan。

frps 必须能够绑定：

- `7000`：示例中的 FRP 控制端口，可自行修改。
- `80`：IP 证书 HTTP 校验和 HTTPS 跳转。
- `443`：公网 HTTPS TCP 透传。

不要开放 frps 管理面板。若云服务器防火墙支持来源限制，可以只允许本地服务器访问 FRP 控制端口。

## 同时启动 HTTP 与公网 IP HTTPS

复制环境变量模板：

```bash
cp .env.example .env
```

至少修改以下值：

```dotenv
SIXPLAN_PUBLIC_IP=203.0.113.10
ACME_EMAIL=admin@example.com
FRP_SERVER_ADDR=203.0.113.10
FRP_SERVER_PORT=7000
FRP_AUTH_TOKEN=与frps完全相同的长随机十六进制令牌
```

启动完整栈：

```bash
docker compose -f compose.yaml -f compose.frp.yaml up -d --build
```

`.env.example` 还列出了计划 JSON 导入的服务端硬上限。保持默认值即可支持 512 MB 文件、50,000 个节点和 250,000 条连接；可按本地服务器内存和磁盘容量调低。网页设置中的个人限制只能进一步收紧，不能超过这些部署级上限。

此时：

- `http://本地服务器IP:4173` 直接访问 sixPlan。
- `https://云服务器公网IP` 经 frps、frpc 和本地 Caddy 访问 sixPlan。
- HTTP 与 HTTPS 地址的登录 Cookie 相互独立，业务数据相同。
- Caddy 代理地址固定为 `172.30.67.3`，Fastify 只信任该地址提供的代理协议。
- 公网入口和 Docker 部署均禁止调用“打开数据目录”。

如果 `172.30.67.0/24` 与现有 Docker 或局域网网段冲突，需要同时修改 `compose.yaml`、`compose.frp.yaml` 中的网络地址和 `SIXPLAN_TRUST_PROXY`。

## 初始化管理员

```bash
docker compose exec -e SIXPLAN_ADMIN_PASSWORD='请使用安全密码' app \
  node apps/server/dist/admin-cli.js create admin
```

提升已有用户：

```bash
docker compose exec app node apps/server/dist/admin-cli.js promote username
```

公网开放前建议管理员关闭网页注册。

## 运维命令

查看状态和健康检查：

```bash
docker compose ps
docker compose logs -f app
docker compose -f compose.yaml -f compose.frp.yaml logs -f gateway frpc
```

升级应用：

```bash
docker compose -f compose.yaml -f compose.frp.yaml up -d --build
```

停止容器不会删除数据。不要执行带 `-v` 的 `docker compose down`，除非已经备份并明确要删除 SQLite 数据和证书状态。
