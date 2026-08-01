# sixPlan

sixPlan 是一个支持多用户的个人 DAG 计划管理工具。桌面端可完整编辑领域、计划、节点、依赖关系和 Markdown，移动端提供只读浏览。

## AI 辅助计划 JSON

总览页“导入”菜单提供“AI 生成新计划”和“AI 扩展现有计划”。sixPlan 不内置模型，也不保存模型 API Key：用户描述目标后，应用生成只读提示词，用户可复制或下载到任意外部大模型，再把模型返回的 JSON 粘贴或上传回来校验、预览并确认写入。

- `sixplan-plan-snapshot` v2 始终创建新计划，不覆盖原数据。
- `sixplan-plan-changeset` v2 按稳定节点 `key` 增量新增、更新或删除节点和连接。
- 上传文件先流式写入临时目录，节点和连接逐项解析；临时会话默认 24 小时后清理。
- 所有写入在事务中再次检查日期、引用、重复边、环和图版本；删除操作使用红色预览并再次确认。
- 扩展计划默认选择所有节点，也可在只读 DAG 中自行勾选，或使用“选择全部”“仅选择叶节点”快捷操作；可选携带目标节点现有 Markdown，并显示预计内容大小。
- 提示词完整说明 v2 协议和界面字段映射，服务端只对所选范围及可客观判定的数据规则做严格校验。复制提示词在局域网 HTTP 下会自动使用兼容方案，仍保留 TXT 下载入口。
- v1 文件不再兼容。节点 `key` 是计划内唯一且不可变的外部引用，内部数据库 ID 仍使用 UUID。

## 环境要求

- Node.js 20
- npm 10 或更高版本

## 安装与开发

```powershell
npm install
npm run dev
```

开发模式会同时启动 Fastify API 和 Vite。浏览器访问 Vite 输出的本地地址；`/api` 请求会代理到后端。

## 生产运行

```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

默认访问地址为 `http://127.0.0.1:4173`。生产模式由 Fastify 在同一端口提供 API 和前端静态文件。

## Docker Compose

仅启动局域网 HTTP：

```bash
docker compose up -d --build
```

默认访问 `http://本地服务器IP:4173`，SQLite、备份和导出文件保存在 Docker volume 中。

同时启用局域网 HTTP 和经 FRP 转发的公网 IP HTTPS：

```bash
cp .env.example .env
docker compose -f compose.yaml -f compose.frp.yaml up -d --build
```

云服务器只运行 frps，本地运行 sixPlan、frpc 和 Caddy。完整配置、端口和安全说明见 [deploy/README.md](deploy/README.md)。

## 管理员命令

创建管理员：

```powershell
$env:SIXPLAN_ADMIN_PASSWORD="请使用安全密码"
npm run admin -- create admin
```

也可以不设置 `SIXPLAN_ADMIN_PASSWORD`，由命令行交互输入密码。将已有用户提升为管理员：

```powershell
npm run admin -- promote username
```

管理员可在网页中关闭开放注册、管理账号、执行全站备份和恢复。管理员不能查看其他用户的计划内容。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SIXPLAN_HOST` | `127.0.0.1` | 服务监听地址；需要局域网访问时可设为 `0.0.0.0` |
| `SIXPLAN_PORT` | `4173` | 服务端口 |
| `SIXPLAN_DATA_DIR` | 系统应用数据目录下的 `sixplan` | 数据库、备份和导出文件目录 |
| `SIXPLAN_COOKIE_SECURE` | `auto` | `true`、`false` 或按可信代理协议自动判断的 `auto` |
| `SIXPLAN_TRUST_PROXY` | 无 | 允许提供代理协议头的固定代理 IP 或 CIDR |
| `SIXPLAN_ALLOW_OPEN_DATA_DIR` | `true` | Docker 或公网部署时设为 `false` |
| `SIXPLAN_ADMIN_PASSWORD` | 无 | 创建管理员时使用的初始密码 |
| `SIXPLAN_IMPORT_MAX_FILE_BYTES` | `536870912` | 单个计划 JSON 的服务端硬上限（512 MB） |
| `SIXPLAN_IMPORT_MAX_NODES` | `50000` | 单次导入节点硬上限 |
| `SIXPLAN_IMPORT_MAX_EDGES` | `250000` | 单次导入连接硬上限 |
| `SIXPLAN_IMPORT_MAX_MARKDOWN_BYTES` | `5242880` | 单节点 Markdown 硬上限（5 MB） |
| `SIXPLAN_IMPORT_MAX_TEMP_BYTES` | `2147483648` | 每用户临时导入空间硬上限（2 GB） |
| `SIXPLAN_IMPORT_MAX_CONCURRENT_USER` | `2` | 每用户并发导入任务上限 |
| `SIXPLAN_IMPORT_MAX_CONCURRENT_GLOBAL` | `8` | 全站并发导入任务上限 |
| `SIXPLAN_IMPORT_TASK_TIMEOUT_MS` | `1800000` | 单个导入任务超时（30 分钟） |
| `SIXPLAN_IMPORT_SESSION_HOURS` | `24` | 临时导入会话最长保留小时数 |
| `NODE_ENV` | 无 | 生产启动时设为 `production` |

默认数据目录：

- Windows：`%APPDATA%\sixplan`
- macOS：`~/Library/Application Support/sixplan`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/sixplan`

首次启动会自动创建目录、SQLite 数据库和表结构。SQLite 会启用外键、WAL 和 busy timeout。

## 质量检查

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

端到端测试会使用 `.sixplan-data/e2e` 中的隔离数据，并自动启动测试服务。
