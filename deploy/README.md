# sixPlan Docker 部署指南

本文档提供两种部署方式：

- **HTTPS + 局域网 HTTP**：适合从公网和局域网同时访问。
- **仅局域网 HTTP**：适合只在家庭或办公局域网中使用。

项目不包含 FRP、端口映射或云服务器配置。公网转发对 sixPlan 是透明的。

## 已配置公网 80/443：直接执行

如果云服务器的 TCP `80/443` 已经透明转发到本地服务器的 TCP `80/443`，只需在**本地服务器**执行：

```bash
cd ~/projects/tools/sixPlan
git switch codex/v0.1-simple
git pull --ff-only origin codex/v0.1-simple
cp -n .env.example .env
nano .env
```

在 `.env` 中填写：

```dotenv
SIXPLAN_HTTPS_HOST=你的云服务器公网IP
ACME_EMAIL=你的邮箱
```

保存后启动并查看状态：

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
docker compose -f compose.yaml -f compose.https.yaml ps
docker compose -f compose.yaml -f compose.https.yaml logs --tail=100 gateway
```

然后访问 `https://云服务器公网IP`。局域网仍可访问 `http://本地服务器IP:4173`。

如果这些步骤已经成功，后面的内容只需在升级或排查问题时查阅。

## 先确认部署结构

HTTPS 模式下，各组件的关系如下：

```text
公网浏览器
  -> https://云服务器公网IP:443
  -> 云服务器透明转发 TCP 443
  -> 本地服务器 Caddy:443
  -> sixPlan:4173

Let's Encrypt
  -> 云服务器公网IP:80/443
  -> 云服务器透明转发 TCP 80/443
  -> 本地服务器 Caddy:80/443

局域网浏览器
  -> http://本地服务器IP:4173
  -> sixPlan:4173
```

职责划分：

| 设备 | 需要做什么 |
| --- | --- |
| 本地服务器 | 保存项目、运行 Docker Compose、保存数据库和证书 |
| 云服务器 | 只把公网 TCP `80/443` 透明转发到本地服务器的 TCP `80/443` |
| 浏览器 | 公网使用云服务器公网 IP，局域网使用本地服务器 IP |

本文档中的 `git` 和 `docker compose` 命令都在**本地服务器的 sixPlan 项目目录**执行。云服务器不需要部署 sixPlan 或 Caddy。

## 方式一：HTTPS + 局域网 HTTP

### 1. 检查前置条件

开始前确认：

- 本地服务器已安装 Docker Engine 和 Docker Compose v2。
- 云服务器安全组及系统防火墙允许 TCP `80/443`。
- 云服务器已将 TCP `80` 转发到本地服务器 TCP `80`。
- 云服务器已将 TCP `443` 转发到本地服务器 TCP `443`。
- 转发的是原始 TCP 连接，不是在云服务器上终止 HTTPS。
- 本地服务器的 TCP `80/443` 没有被其他程序占用。

公网 `80/443` 必须持续可达，否则首次证书申请或后续自动续期会失败。

### 2. 获取 v0.1 最新代码

```bash
cd ~/projects/tools/sixPlan
git fetch origin --prune --tags
git switch codex/v0.1-simple
git pull --ff-only origin codex/v0.1-simple
```

如果项目实际位于其他目录，请替换第一行路径。

### 3. 配置公网 IP 和邮箱

首次部署时创建 `.env`：

```bash
cp -n .env.example .env
nano .env
```

至少修改下面两项：

```dotenv
# 必须填写浏览器最终访问的云服务器公网 IPv4
SIXPLAN_HTTPS_HOST=你的云服务器公网IP

# 用于接收证书相关通知
ACME_EMAIL=你的邮箱
```

例如云服务器公网 IP 为 `198.51.100.24`：

```dotenv
SIXPLAN_HTTPS_HOST=198.51.100.24
ACME_EMAIL=admin@example.com
```

不要保留 `.env.example` 中的 `203.0.113.10`，它只是文档示例地址，不能用于实际部署。

保存 `nano`：按 `Ctrl+O`、回车，再按 `Ctrl+X`。

### 4. 启动

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

该命令会同时启动：

- `app`：sixPlan 应用，局域网端口为 `4173`。
- `gateway`：Caddy HTTPS 网关，占用本地服务器 `80/443`。

首次构建需要下载镜像和 npm 依赖，耗时通常比后续升级更长。

### 5. 检查运行状态

```bash
docker compose -f compose.yaml -f compose.https.yaml ps
```

`app` 和 `gateway` 都应为运行状态，`app` 最终应显示健康。

查看证书申请和 HTTPS 网关日志：

```bash
docker compose -f compose.yaml -f compose.https.yaml logs --tail=100 gateway
```

持续查看日志：

```bash
docker compose -f compose.yaml -f compose.https.yaml logs -f gateway
```

按 `Ctrl+C` 只会退出日志查看，不会停止容器。

### 6. 访问

```text
公网：https://云服务器公网IP
局域网：http://本地服务器IP:4173
```

两个地址访问的是同一份数据，但浏览器 Cookie 按主机和协议隔离，因此需要分别登录。

### 7. 初始化管理员

在本地服务器执行：

```bash
docker compose exec -e SIXPLAN_ADMIN_PASSWORD='请替换为安全密码' app \
  node apps/server/dist/admin-cli.js create admin
```

提升已有用户为管理员：

```bash
docker compose exec app node apps/server/dist/admin-cli.js promote username
```

公网访问可用后，建议管理员登录设置页面并关闭开放注册。

## 方式二：仅局域网 HTTP

如果不需要公网 HTTPS，不需要填写 `SIXPLAN_HTTPS_HOST` 和 `ACME_EMAIL`，直接在本地服务器启动：

```bash
docker compose up -d --build
```

访问：

```text
http://本地服务器IP:4173
```

查看状态和日志：

```bash
docker compose ps
docker compose logs --tail=100 app
```

## 常用运维命令

以下命令均在本地服务器的项目目录执行。

### HTTPS 部署

查看状态：

```bash
docker compose -f compose.yaml -f compose.https.yaml ps
```

查看全部日志：

```bash
docker compose -f compose.yaml -f compose.https.yaml logs -f
```

拉取代码并升级：

```bash
git pull --ff-only origin codex/v0.1-simple
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

重启：

```bash
docker compose -f compose.yaml -f compose.https.yaml restart
```

停止：

```bash
docker compose -f compose.yaml -f compose.https.yaml down
```

### HTTP 部署

```bash
docker compose ps
docker compose logs -f app
docker compose up -d --build
docker compose restart
docker compose down
```

`docker compose down` 不会删除数据卷。不要执行带 `-v` 的 `docker compose down -v`，除非已经备份并明确要删除数据库和证书状态。

## 数据保存与版本选择

### 默认数据卷

SQLite 数据和用户备份默认保存在 Docker volume `sixplan-data` 中。停止或重建容器不会删除该 volume。

已有部署继续使用原数据时，保持：

```dotenv
SIXPLAN_DATA_VOLUME=sixplan-data
```

修改这个名称会让应用使用另一个数据卷，看起来就像数据消失，但原数据卷仍然存在。

### v0.1 与 v0.2

| 版本 | 分支 | 特点 |
| --- | --- | --- |
| v0.1 简化版 | `codex/v0.1-simple` | 节点内使用一层有序子阶段，不包含子计划关联 |
| v0.2 子计划版 | `codex/v0.2-child-plans` | 节点可以关联普通计划作为子计划 |

两个版本不得共用生产数据库。需要同时保留两套数据时，在 `.env` 中使用不同的数据卷名称，例如：

```dotenv
# v0.1
SIXPLAN_DATA_VOLUME=sixplan-v01-data
```

```dotenv
# v0.2
SIXPLAN_DATA_VOLUME=sixplan-v02-data
```

切换版本前，先在网页中创建备份，再停止容器、切换分支并重新构建。不要把一个版本的全站备份直接恢复到另一个版本。

## 故障排查

### Compose 提示缺少 `SIXPLAN_HTTPS_HOST`

确认当前目录存在 `.env`，并检查：

```bash
grep -E '^(SIXPLAN_HTTPS_HOST|ACME_EMAIL)=' .env
```

`SIXPLAN_HTTPS_HOST` 必须是云服务器的真实公网 IPv4，不能是本地服务器局域网 IP，也不能是示例地址。

### 局域网 HTTP 正常，但公网 HTTPS 无法访问

依次检查：

1. 云服务器安全组是否开放 TCP `80/443`。
2. 云服务器系统防火墙是否开放 TCP `80/443`。
3. TCP `80/443` 是否都转发到本地服务器的同名端口。
4. 本地服务器防火墙是否允许 TCP `80/443`。
5. 本地 Caddy 是否正在监听并且日志中没有证书错误。

本地检查容器和端口：

```bash
docker compose -f compose.yaml -f compose.https.yaml ps
docker compose -f compose.yaml -f compose.https.yaml logs --tail=200 gateway
sudo ss -lntp | grep -E ':(80|443|4173)\b'
```

不要只在同一局域网内测试公网 IP。部分路由器不支持 NAT 回环，建议关闭手机 Wi-Fi，使用移动网络访问公网 HTTPS 地址。

### Caddy 无法申请证书

公网 IP 证书由 Let's Encrypt 签发，属于短期证书，Caddy 会自动申请和续期。证书失败通常不是 sixPlan 应用错误，而是公网校验无法到达本地 Caddy。

重点确认：

- 公网 IP 与 `.env` 中的 `SIXPLAN_HTTPS_HOST` 完全一致。
- 公网 TCP `80` 和 `443` 都能到达本地 Caddy。
- 云服务器转发服务没有在中间终止或改写 TLS。
- `sixplan-caddy-data` volume 没有被删除。

### 本地端口 `80` 或 `443` 已被占用

先查看占用者：

```bash
sudo ss -lntp | grep -E ':(80|443)\b'
```

如果必须改用其他本地端口，在 `.env` 中设置：

```dotenv
SIXPLAN_HTTPS_HTTP_PORT=8080
SIXPLAN_HTTPS_PORT=8443
```

同时必须把云服务器公网 `80/443` 分别转发到本地 `8080/8443`。

### Docker 网段冲突

默认 Compose 网络为 `172.30.67.0/24`，其中应用固定为 `172.30.67.2`，Caddy 固定为 `172.30.67.3`。如果该网段与现有 Docker 或局域网冲突，需要同时修改：

- `compose.yaml` 中的子网和应用地址。
- `compose.https.yaml` 中的 Caddy 地址。
- `SIXPLAN_TRUST_PROXY` 的值。

### HTTPS 下登录状态与局域网不同

这是正常现象。公网 HTTPS 地址和局域网 HTTP 地址使用不同 Cookie，需要分别登录，但两者访问同一数据库。

## 配置说明

常用配置均位于项目根目录 `.env`：

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `SIXPLAN_HTTP_BIND` | `0.0.0.0` | 局域网 HTTP 监听地址 |
| `SIXPLAN_HTTP_PORT` | `4173` | 局域网 HTTP 端口 |
| `SIXPLAN_DATA_VOLUME` | `sixplan-data` | SQLite 数据和备份所在 volume |
| `SIXPLAN_HTTPS_HOST` | 无 | 浏览器最终访问的云服务器公网 IPv4 |
| `SIXPLAN_HTTPS_BIND` | `0.0.0.0` | 本地 Caddy 监听地址 |
| `SIXPLAN_HTTPS_HTTP_PORT` | `80` | 本地 Caddy HTTP 校验端口 |
| `SIXPLAN_HTTPS_PORT` | `443` | 本地 Caddy HTTPS 端口 |
| `ACME_EMAIL` | 无 | 证书通知邮箱 |

计划导入大小和并发限制等高级配置保留在 [`.env.example`](../.env.example) 中，通常不需要修改。
