# COPY ARCHIVE — 部署说明

本项目是「静态前端 + Python 后端 + SQLite」的单体应用：同一个进程既提供静态页面，也提供 API。
只要把它跑在支持常驻进程的平台上，公开档案就是**真正多人共享**的——任何人打开 `/u/用户名` 都能看到你的文案。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8765` | 监听端口。设置后服务自动绑定 `0.0.0.0` |
| `HOST` | `127.0.0.1`（设了 `PORT` 时为 `0.0.0.0`） | 监听地址 |
| `COPY_ARCHIVE_VERBOSE` | — | 设为任意值即打印请求错误与访问日志 |
| `COPY_ARCHIVE_DB` | `data/copyarchive.db` | 数据库文件位置，可指向持久化卷 |

## 本地运行

```bash
python3 server.py                       # http://127.0.0.1:8765
PORT=8080 HOST=0.0.0.0 python3 server.py   # 容器形态
```

## 部署到平台

零第三方依赖，`pip install` 不需要任何包。任选其一：

### Railway / Render / Fly.io（推荐）

仓库已包含 `railway.json` 与 `render.yaml`，直接连接仓库即可，启动命令统一为 `python3 server.py`。

### Docker

```bash
docker build -t copy-archive .
docker run -p 8765:8765 -v copy-archive-data:/app/data copy-archive
```

`/app/data` 是数据库目录，挂载卷即可持久化。

### 任意支持 Python 的 PaaS

启动命令 `python3 server.py`，监听 `$PORT`，把 `data/` 挂到持久化存储。

## 数据与备份

```bash
python3 scripts/backup.py    # 生成 backups/copyarchive-YYYYMMDD-HHMMSS.db，保留最近 30 份
```

恢复：停服后用备份文件覆盖 `data/copyarchive.db`（或 `$COPY_ARCHIVE_DB` 指定的位置）再启动。

## 两种形态的区别

| | 自建后端（本文件） | GitHub Pages 静态托管 |
|---|---|---|
| 公开档案 | ✅ 任何人生成链接都能看 | ❌ 数据存在各自浏览器，仅本机可见 |
| 跨设备同步 | ✅ | ❌ |
| 分享链接 | ✅ 真实可分享 | 仅当前浏览器内生效 |
| 数据存储 | 服务端 SQLite | 浏览器 localStorage |

Pages 形态由 `public/js/local-api.js` 以**完全一致的 API 契约**复刻全部功能，可离线体验；
一旦把本项目（含 `server.py`）部署到任意常驻平台，即自动升级为真正的共享档案馆。
