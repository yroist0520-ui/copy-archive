# COPY ARCHIVE｜个人文案档案馆

一个真正可长期使用的文案收集、整理、复制与分享平台。前端为无构建步骤的原生 ES Modules，
后端为 Python 标准库 HTTP 服务 + **SQLite 真实数据库**（非 localStorage），账号数据按用户隔离，
公开档案的可见性由服务端强制过滤。

## 设计定调

Editorial / Swiss Archive：黑白灰纸感基底 + 单一信号红强调，Bodoni Moda 与思源宋体构成标题与正文，
IBM Plex Mono 承载编号、时间戳与元数据。文案卡片没有圆角和阴影，只有发丝线、编号与留白；
记忆点是「NO. 0001」式档案索引与细线分割的编辑部排版。所有动效克制并在 `prefers-reduced-motion` 下关闭。

## 启动

```bash
cd copy-archive
python3 server.py
# 打开 http://127.0.0.1:8765
```

可选环境变量：`PORT`（默认 8765）、`HOST`（默认 127.0.0.1）、`COPY_ARCHIVE_VERBOSE=1`（打印请求错误）。

无需 npm install，无第三方 Python 依赖。数据库首次启动时自动创建于 `data/copyarchive.db`。

## 数据模型

| 表 | 作用 |
|---|---|
| `users` | 账号（用户名/邮箱唯一，PBKDF2 加盐哈希密码） |
| `profiles` | 昵称、简介、头像、封面、主题、隐私模式、公开分类白名单 |
| `categories` | 分类（含内置分组、颜色、排序） |
| `copies` | 文案正文、标题、备注、标签、复制次数 |
| `copy_categories` | 文案 ↔ 分类 多对多关联（联合主键去重） |
| `favorites` | 用户 ↔ 文案 收藏关系（独立存储） |
| `sessions` | 服务端会话（HttpOnly Cookie，仅保存 token 哈希） |

索引覆盖 `user_id + 时间 / 更新时间 / 复制次数`、分类关联与收藏，搜索使用带 `ESCAPE` 的
`LIKE` 多字段匹配，支持正文、标题、备注、标签、分类名与多关键词组合。

## 权限

- 所有 `/api/copies`、`/api/categories`、`/api/profile` 写操作都要求会话身份，并带 `user_id` 约束。
- 跨账号读取/修改/删除返回 404。
- 公开档案三档：`public` 全部可见；`partial` 仅白名单分类可见；`private` 任何公开入口均不可见。
- 未公开文案无法通过列表、详情、复制计数、分享链接或他人档案页访问。
- 写操作要求 `X-Requested-With` 头，Cookie 为 SameSite=Lax + HttpOnly。

## 备份

```bash
python3 scripts/backup.py
```

生成 `backups/copyarchive-YYYYMMDD-HHMMSS.db`，自动只保留最近 30 份。恢复时停服后用备份文件覆盖
`data/copyarchive.db` 再启动即可。

## GitHub Pages 部署

线上地址：**https://yroist0520-ui.github.io/copy-archive/**

仓库 `yroist0520-ui/copy-archive` 采用 **gh-pages 分支**方式部署（`main` 存源码，`gh-pages` 存构建产物）。
这是因为 GitHub Pages 只能托管静态文件，无法运行 Python 后端。

> 注：`main` 分支同时保留了 `.github/workflows/deploy-pages.yml`。若使用带 `workflow` scope 的
> Personal Access Token，可切换为 Actions 自动部署；当前 PAT 权限不足，故默认走 gh-pages 分支。

### 两种运行形态

| 形态 | 入口 | 数据存储 | 账号隔离 | 跨设备同步 | 分享链接 |
|---|---|---|---|---|---|
| **完整版** | `python3 server.py` | SQLite 真数据库 | 服务端强制 | 支持 | 支持真实跨用户访问 |
| **静态托管版**（GitHub Pages） | 线上域名 | 浏览器 localStorage | 单浏览器内模拟 | 不支持 | 仅当前浏览器内生效 |

静态托管版由 `public/js/local-api.js` 提供与 `server.py` **完全一致的 API 契约**（账号隔离、多分类关联、
搜索、收藏、三档隐私全部按后端同一套规则实现），前端启动时探测 `/api/health`，探测不到即自动切换。
界面顶部持续显示 `LOCAL MODE` 标识，明确告知数据保存在当前浏览器，不会伪装成已联网同步。

### 部署路径适配

应用通过 `import.meta.url` 推导自身根路径（`BASE`），因此根路径部署（`/`）与子路径部署
（`/copy-archive/`）都能正确解析资源与路由。`404.html` 通过逐级向上探测 `index.html` 定位应用根，
深链（如 `/u/用户名`、`/archive`）刷新后自动回到入口并恢复路由。

## 测试

```bash
python3 scripts/test_api.py          # 后端 API 集成测试
node scripts/test_ui.mjs             # 浏览器 UI 冒烟测试（需 headless Chromium）
node scripts/test_live.mjs           # 线上端到端验收
```

覆盖范围：注册登录、会话保持、30 个默认分类、多分类关联去重、分类改名同步、完全重复检测、
批量导入原文无损（空格/标点/Unicode/换行）、正文/标题/分类/标签/多关键词搜索、多分类筛选、
复制计数、收藏与取消收藏、三档隐私、跨账号越权拦截、批量管理、删除分类保留文案、
重新登录持久化、分页与五种排序。

| 环境 | 结果 |
|---|---|
| 后端 API 集成测试 | **41/41 通过** |
| UI 冒烟 · Python 后端服务器模式 | **26/26 通过** |
| UI 冒烟 · 根路径静态托管 | **28/28 通过** |
| UI 冒烟 · 子路径静态托管 | **28/28 通过** |
| UI 冒烟 · **线上站点** | **28/28 通过** |
| 线上端到端验收 | **12/12 通过** |

复现静态托管环境：

```bash
python3 scripts/serve_static.py 8080                                    # 根路径
CA_BASE_PATH=/copy-archive python3 scripts/serve_static.py 8081          # 子路径
CA_BASE=http://127.0.0.1:8081/copy-archive CA_EXPECT_LOCAL=1 node scripts/test_ui.mjs
```

## 目录

```
server.py                     后端 API + SQLite
public/index.html             单页应用外壳
public/styles/                设计令牌 / 基础层 / 组件层
public/js/core.js             API、路由、基路径推导、状态、弹层、复制
public/js/local-api.js        静态托管降级：与后端同契约的本地实现
public/js/ui.js               卡片、分类 chip、空状态、分页
public/js/*.js                各页面
scripts/test_api.py           后端集成测试
scripts/test_ui.mjs           浏览器 UI 冒烟测试
scripts/test_live.mjs         线上端到端验收
scripts/serve_static.py       模拟 Pages 托管（含子路径）
scripts/backup.py             数据库备份
```
