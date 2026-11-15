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

## 测试

```bash
python3 scripts/test_api.py
```

覆盖 40 项：注册登录、会话保持、30 个默认分类、多分类关联去重、分类改名同步、完全重复检测、
批量导入原文无损（空格/标点/Unicode/换行）、正文/标题/分类/标签/多关键词搜索、多分类筛选、
复制计数、收藏与取消收藏、三档隐私、跨账号越权拦截、批量管理、删除分类保留文案、
重新登录持久化、分页与五种排序。当前结果：**41/41 通过**。

浏览器端冒烟测试（需本机可用的 headless Chromium，先以 `--remote-debugging-port=9222` 启动）：

```bash
node scripts/test_ui.mjs
```

覆盖首页渲染、注册登录、单条/批量上传、原文保留、多分类、搜索高亮、长文折叠、批量选择/复制、
分类管理、档案设置、公开分享与访客复制，当前 **26/26 项通过**，且无浏览器运行时错误。

## GitHub Pages

`.github/workflows/deploy-pages.yml` 会在 push 时部署 `public/` 静态前端，`404.html` 负责深链回退。
注意：GitHub Pages 只能托管静态文件，**账号与数据库 API 需要运行 `server.py`**；仅部署前端时注册/登录
不可用。完整体验请本地运行 Python 服务，或将后端部署到支持 Python 的托管环境后配置同源访问。

## 目录

```
server.py                 后端 API + SQLite
public/index.html         单页应用外壳
public/styles/            设计令牌 / 基础层 / 组件层
public/js/core.js         API、路由、状态、弹层、复制
public/js/ui.js           卡片、分类 chip、空状态、分页
public/js/*.js            各页面
scripts/test_api.py       集成测试
scripts/backup.py         数据库备份
```
