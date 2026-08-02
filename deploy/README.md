# sixPlan Docker 部署指南

sixPlan 默认使用局域网 HTTP，也可以在保留局域网 HTTP 的同时启用公网 HTTPS。

| 模式 | 访问地址 | 运行服务 |
| --- | --- | --- |
| 局域网 HTTP（默认） | `http://本地服务器IP:4173` | sixPlan |
| 公网 HTTPS + 局域网 HTTP | `https://公网IP` 和 `http://本地服务器IP:4173` | sixPlan + Caddy |

本文档中的 `git` 和 `docker compose` 命令均在**本地服务器的 sixPlan 项目目录**执行。

## 一、局域网 HTTP

这是最简单的默认部署方式，不需要 `.env`，也不需要云服务器。

### 前置条件

- 本地服务器已安装 Docker Engine。
- `docker compose version` 能正常输出 Compose v2 版本。
- 局域网设备能够访问本地服务器 TCP `4173`。

### 首次启动

```bash
cd ~/projects/tools/sixPlan
git fetch origin --prune --tags
git switch codex/v0.1-simple
git pull --ff-only origin codex/v0.1-simple
docker compose up -d --build
```

项目不在该目录时，请替换第一行路径。

查看运行状态：

```bash
docker compose ps
```

`app` 应显示为运行状态，并最终变为健康。然后访问：

```text
http://本地服务器IP:4173
```

查看应用日志：

```bash
docker compose logs --tail=100 app
```

### 停止 HTTP 服务

```bash
docker compose down
```

普通的 `down` 只删除容器和 Compose 网络，不删除 SQLite 数据卷。

## 二、公网 HTTPS + 局域网 HTTP

HTTPS 模式会在本地服务器增加 Caddy。云服务器只负责透明转发公网端口，不部署 sixPlan 或 Caddy。

```text
公网浏览器
  -> 云服务器公网 TCP 443
  -> 透明转发到本地服务器 TCP 443
  -> Caddy
  -> sixPlan:4173

局域网浏览器
  -> 本地服务器 TCP 4173
  -> sixPlan:4173
```

### 前置条件

- HTTP 模式所需条件已经满足。
- 云服务器安全组和系统防火墙允许 TCP `80/443`。
- 云服务器 TCP `80` 已透明转发到本地服务器 TCP `80`。
- 云服务器 TCP `443` 已透明转发到本地服务器 TCP `443`。
- 转发的是原始 TCP 连接，不在云服务器上终止 HTTPS。
- 本地服务器 TCP `80/443` 未被其他程序占用。

公网 `80/443` 必须持续可达，否则证书首次申请或自动续期会失败。

### 配置 HTTPS

在本地服务器的项目目录执行：

```bash
cp -n .env.example .env
nano .env
```

在 `.env` 中取消并填写以下配置：

```dotenv
# 让所有 docker compose 命令自动加载 HTTP 和 HTTPS 两个配置文件
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=compose.yaml:compose.https.yaml

# 浏览器最终访问的云服务器公网 IPv4
SIXPLAN_HTTPS_HOST=你的云服务器公网IP

# Let's Encrypt 证书通知邮箱
ACME_EMAIL=你的邮箱
```

`SIXPLAN_HTTPS_HOST` 不能填写本地局域网 IP，也不能保留示例值。

保存 `nano`：按 `Ctrl+O`、回车，再按 `Ctrl+X`。

### 确认 Compose 已识别 HTTPS

```bash
docker compose config --services
```

正确输出应同时包含：

```text
app
gateway
```

如果只有 `app`，不要继续启动，先检查 `.env` 中的 `COMPOSE_FILE` 和 `COMPOSE_PATH_SEPARATOR`。

### 启动 HTTPS

完成 `.env` 配置后，不再需要手动输入两个 `-f`：

```bash
docker compose up -d --build
docker compose ps
```

查看证书申请和网关日志：

```bash
docker compose logs --tail=100 gateway
```

持续查看日志：

```bash
docker compose logs -f gateway
```

按 `Ctrl+C` 只会退出日志查看，不会停止容器。

访问地址：

```text
公网：https://云服务器公网IP
局域网：http://本地服务器IP:4173
```

两个入口访问同一份数据，但 Cookie 按主机和协议隔离，因此需要分别登录。

### 停止全部服务

确认 `docker compose config --services` 能看到 `app` 和 `gateway` 后执行：

```bash
docker compose down
```

该命令会同时停止并删除 sixPlan 和 Caddy 容器，不会删除数据库及证书数据卷。

从 HTTPS 改回仅 HTTP 时：

1. 先在仍保留 `COMPOSE_FILE` 的情况下执行 `docker compose down`。
2. 再从 `.env` 删除或注释 `COMPOSE_FILE` 和 `COMPOSE_PATH_SEPARATOR`。
3. 执行 `docker compose up -d --build`，此时只会启动 `app`。

## 三、日常运维

无论使用 HTTP 还是 HTTPS，配置完成后都使用普通的 `docker compose` 命令。

### 查看状态

```bash
docker compose ps
```

### 查看日志

```bash
docker compose logs -f app
docker compose logs -f gateway  # 仅 HTTPS 模式
```

### 升级

```bash
git pull --ff-only origin codex/v0.1-simple
docker compose up -d --build
```

### 重启

```bash
docker compose restart
```

仅重启 HTTPS 网关：

```bash
docker compose restart gateway
```

### 停止

```bash
docker compose down
```

不要执行 `docker compose down -v`，除非已经备份并明确需要删除数据库和证书状态。

## 四、初始化管理员

创建管理员：

```bash
docker compose exec -e SIXPLAN_ADMIN_PASSWORD='请替换为安全密码' app \
  node apps/server/dist/admin-cli.js create admin
```

提升已有用户：

```bash
docker compose exec app node apps/server/dist/admin-cli.js promote username
```

启用公网访问后，建议管理员登录设置页面并关闭开放注册。

## 五、数据与版本

### 数据卷

SQLite 数据和用户备份默认保存在 Docker volume `sixplan-data` 中。停止或重建容器不会删除该 volume。

已有部署继续使用原数据时，保持：

```dotenv
SIXPLAN_DATA_VOLUME=sixplan-data
```

修改这个名称会让应用使用另一个数据卷，看起来像数据消失，但原数据卷仍然存在。

### v0.1 与 v0.2

| 版本 | 分支 | 特点 |
| --- | --- | --- |
| v0.1 简化版 | `codex/v0.1-simple` | 节点内使用一层有序子阶段，不包含子计划关联 |
| v0.2 子计划版 | `codex/v0.2-child-plans` | 节点可以关联普通计划作为子计划 |

两个版本不得共用生产数据库。需要保留两套数据时，在各自 `.env` 中使用不同的数据卷名称：

```dotenv
# v0.1
SIXPLAN_DATA_VOLUME=sixplan-v01-data
```

```dotenv
# v0.2
SIXPLAN_DATA_VOLUME=sixplan-v02-data
```

切换版本前先在网页中创建备份，再停止容器、切换分支并重新构建。不要把一个版本的全站备份直接恢复到另一个版本。

## 六、故障排查

### `docker compose down` 后 gateway 仍在运行

先执行：

```bash
docker compose config --services
```

如果只显示 `app`，说明当前 Compose 没有加载 `compose.https.yaml`。将下面两项加入 `.env`：

```dotenv
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=compose.yaml:compose.https.yaml
```

再次确认能看到 `app` 和 `gateway`，然后执行：

```bash
docker compose down
```

对于尚未配置 `COMPOSE_FILE` 的旧部署，也可执行一次：

```bash
docker compose -f compose.yaml -f compose.https.yaml down
```

### 局域网 HTTP 正常，但公网 HTTPS 无法访问

依次检查：

1. `docker compose config --services` 是否同时显示 `app` 和 `gateway`。
2. 云服务器安全组是否开放 TCP `80/443`。
3. 云服务器系统防火墙是否开放 TCP `80/443`。
4. 公网 TCP `80/443` 是否转发到本地服务器同名端口。
5. 本地服务器防火墙是否允许 TCP `80/443`。
6. Caddy 日志中是否有证书错误。

本地检查：

```bash
docker compose ps
docker compose logs --tail=200 gateway
sudo ss -lntp | grep -E ':(80|443|4173)\b'
```

部分路由器不支持 NAT 回环。不要只在同一局域网内测试公网 IP，建议关闭手机 Wi-Fi，使用移动网络测试。

### Caddy 无法申请证书

公网 IP 证书由 Let's Encrypt 签发，属于短期证书，Caddy 会自动申请和续期。重点确认：

- `.env` 中的公网 IP 正确。
- 公网 TCP `80/443` 都能到达本地 Caddy。
- 转发服务没有在中间终止或改写 TLS。
- `sixplan-caddy-data` volume 没有被删除。

### 本地端口被占用

检查端口：

```bash
sudo ss -lntp | grep -E ':(80|443|4173)\b'
```

如果必须修改 Caddy 的本地端口，在 `.env` 中设置：

```dotenv
SIXPLAN_HTTPS_HTTP_PORT=8080
SIXPLAN_HTTPS_PORT=8443
```

同时把云服务器公网 `80/443` 分别转发到本地 `8080/8443`。

### Docker 网段冲突

默认网络为 `172.30.67.0/24`，应用固定为 `172.30.67.2`，Caddy 固定为 `172.30.67.3`。发生冲突时需要同时修改：

- `compose.yaml` 中的子网和应用地址。
- `compose.https.yaml` 中的 Caddy 地址。
- `SIXPLAN_TRUST_PROXY` 的值。

### HTTPS 与局域网登录状态不同

这是正常现象。公网 HTTPS 和局域网 HTTP 使用不同 Cookie，需要分别登录，但访问的是同一数据库。

### 构建提示缺少 buildx

以下警告不影响普通构建和运行：

```text
Docker Compose is configured to build using Bake, but buildx isn't installed
```

只要构建最终显示 `Built`，可以忽略该警告。

## 七、配置参考

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `SIXPLAN_HTTP_BIND` | `0.0.0.0` | 局域网 HTTP 监听地址 |
| `SIXPLAN_HTTP_PORT` | `4173` | 局域网 HTTP 端口 |
| `SIXPLAN_DATA_VOLUME` | `sixplan-data` | SQLite 数据和备份 volume |
| `COMPOSE_PATH_SEPARATOR` | 无 | 固定 Compose 文件列表的分隔符 |
| `COMPOSE_FILE` | 无 | HTTPS 模式设为 `compose.yaml:compose.https.yaml` |
| `SIXPLAN_HTTPS_HOST` | 无 | 浏览器最终访问的公网 IPv4 |
| `SIXPLAN_HTTPS_BIND` | `0.0.0.0` | 本地 Caddy 监听地址 |
| `SIXPLAN_HTTPS_HTTP_PORT` | `80` | Caddy HTTP 校验端口 |
| `SIXPLAN_HTTPS_PORT` | `443` | Caddy HTTPS 端口 |
| `ACME_EMAIL` | 无 | 证书通知邮箱 |

计划导入大小及并发限制等高级配置见项目根目录 [`.env.example`](../.env.example)，通常不需要修改。
