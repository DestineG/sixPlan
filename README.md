# sixPlan

sixPlan 是一个支持多用户的个人 DAG 计划管理工具。桌面端可完整编辑领域、计划、节点、依赖关系和 Markdown，移动端提供只读浏览。

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
| `SIXPLAN_COOKIE_SECURE` | `false` | 使用 HTTPS 时设为 `true` |
| `SIXPLAN_ADMIN_PASSWORD` | 无 | 创建管理员时使用的初始密码 |
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
