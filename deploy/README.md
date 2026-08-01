# Docker HTTP 与 HTTPS 部署

sixPlan 提供两种 Docker Compose 启动方式：

```text
HTTP：http://本地服务器IP:4173
HTTPS：https://证书对应的公网IPv4
```

HTTP 模式只运行 sixPlan。HTTPS 模式在本地额外运行 Caddy，由 Caddy 负责证书、TLS 终止和反向代理。项目不包含公网端口转发、隧道或云服务器组件；如需公网访问，应在项目外部把公网 `80/443` 转发到本地 Caddy 的 `80/443`。

## 前置条件

- 本地服务器已安装 Docker Engine 和 Docker Compose v2。
- 本地服务器用于保存 SQLite 数据和备份。
- 使用 HTTP 时，局域网设备能够访问本地服务器的 `4173` 端口。
- 使用受信任的公网 IP HTTPS 时，证书对应的公网 IPv4 必须可用，公网 `80/443` 必须能够到达本地服务器的 `80/443`。

公网 IP 证书由 Let's Encrypt 免费签发，是有效期约六天的短期证书。Caddy 使用 ACME `shortlived` 配置自动申请和续期，因此公网 `80/443` 必须持续可达，且 `sixplan-caddy-data` volume 不应删除。外部如何完成端口映射不属于 sixPlan 的部署配置。

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

HTTPS 部署切换版本时，停止和启动命令都应追加 `-f compose.yaml -f compose.https.yaml`。当前配置使用固定的 HTTP/HTTPS 端口和容器网络，因此一次只运行一个版本。切换数据卷不会自动迁移数据，也不要把一个版本的全站备份直接恢复到另一个版本。

## 启动 HTTP

在项目目录执行：

```bash
docker compose up -d --build
```

访问 `http://本地服务器IP:4173`。应用数据保存在 `SIXPLAN_DATA_VOLUME` 指定的 volume 中，未设置时使用 `sixplan-data`。

## 启动 HTTPS

复制环境变量模板：

```bash
cp .env.example .env
```

至少修改以下值：

```dotenv
SIXPLAN_HTTPS_HOST=203.0.113.10
ACME_EMAIL=admin@example.com
```

`SIXPLAN_HTTPS_HOST` 必须是浏览器最终访问且证书覆盖的公网 IPv4。先确保外部网络已经把该地址的 `80/443` 转到本地服务器的 `80/443`，然后启动：

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

此时：

- `http://本地服务器IP:4173` 仍可在局域网直接访问 sixPlan。
- `https://SIXPLAN_HTTPS_HOST` 通过本地 Caddy 访问同一份 sixPlan 数据。
- HTTP 与 HTTPS 地址的登录 Cookie 相互独立，需要分别登录。
- Caddy 代理地址固定为 `172.30.67.3`，Fastify 只信任该地址提供的代理协议。
- HTTPS 网关禁止调用“打开数据目录”。

如果宿主机的 `80` 或 `443` 已被占用，可通过 `SIXPLAN_HTTPS_HTTP_PORT` 和 `SIXPLAN_HTTPS_PORT` 修改本地映射，同时让外部网络转发到修改后的端口。如果 `172.30.67.0/24` 与现有 Docker 或局域网网段冲突，需要同时修改 `compose.yaml`、`compose.https.yaml` 中的网络地址和 `SIXPLAN_TRUST_PROXY`。

## 初始化管理员

创建管理员：

```bash
docker compose exec -e SIXPLAN_ADMIN_PASSWORD='请使用安全密码' app \
  node apps/server/dist/admin-cli.js create admin
```

提升已有用户：

```bash
docker compose exec app node apps/server/dist/admin-cli.js promote username
```

允许公网访问前建议管理员关闭网页注册。

## 运维命令

查看 HTTP 部署状态和日志：

```bash
docker compose ps
docker compose logs -f app
```

查看 HTTPS 网关日志：

```bash
docker compose -f compose.yaml -f compose.https.yaml logs -f gateway
```

升级 HTTP 部署：

```bash
docker compose up -d --build
```

升级 HTTPS 部署：

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

停止容器不会删除数据。不要执行带 `-v` 的 `docker compose down`，除非已经备份并明确要删除 SQLite 数据和证书状态。
