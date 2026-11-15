# COPY ARCHIVE｜个人文案档案馆

一个真正可长期使用的文案收集、整理、复制与分享平台。前端为无构建步骤的原生 ES Modules，
后端为 Python 标准库 HTTP 服务 + **SQLite 真实数据库**（非 localStorage），账号数据按用户隔离，
公开档案的可见性由服务端强制过滤。

## 设计定调

INS 韩系极简 × 轻玻璃拟态 × 现代编辑设计。轻盈通透的界面质感，安静的留白，低饱和的灰绿／雾蓝／浅米点缀。

**色彩**：浅色主题页面底色 `#F7F7F5`，卡片为半透明白 `rgba(255,255,255,.72)`，主文字 `#292929`、
次级 `#929292`、辅助 `#B5B5B5`，边框统一 `rgba(0,0,0,.07)`。深色主题采用炭黑 `#1A1A1C` 与柔和灰白
`#E7E5E0`，不使用纯黑背景搭配刺眼纯白。分类标签以 `color-mix` 融入所属分类色，保持统一色彩体系。

**字体**：Bodoni Moda 承担标题与展示文字（拉丁），思源宋体 Noto Serif SC 承担中英文正文，
IBM Plex Mono 承载编号、时间戳与元信息并启用等宽数字，避免数字跳动。
界面小字（导航、按钮、标签、字段名）统一走等宽字体，保持档案索引的编辑感。

**质感**：顶部导航、搜索浮层、弹窗、复制提示、移动端菜单采用低模糊度磨砂玻璃；文案卡片只用极细边框
与弱阴影，不叠加强模糊以保证性能。圆角体系统一为 10 / 14 / 18 / 24px 与胶囊形。

**动效**：页面切换淡入、卡片悬停轻微上浮 3px、按钮按下缩放、弹窗柔和浮入、分类标签状态过渡，
时长 160–560ms，全部尊重 `prefers-reduced-motion`。

**图标**：全部采用线性 SVG（以 CSS mask 承载 `currentColor`），不依赖图标字体或位图素材。

三套主题：纸白 PAPER（默认）、墨黑 INK、新闻纸 NEWSPRINT，导航右侧一键循环切换，选择会被记住。

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

## 头像与封面

档案页的头像、封面**直接选择本地图片**，不需要填写任何外部链接：

- 浏览器端用 canvas 压缩后再保存——头像居中裁剪为 256×256，封面裁剪为 1600×500（16:5），
  优先输出 WebP，不支持时退回 JPEG，原始文件不会离开浏览器。
- 压缩结果以 data URL 形式写入档案字段，因此**纯静态托管形态同样可用**，不依赖后端文件服务。
- 上传槽提供即时预览、容量提示与「移除」，保存后页面顶部头像与封面即时更新，无需刷新。

## 测试

```bash
python3 scripts/test_api.py          # 后端 API 集成测试
node scripts/test_ui.mjs             # 浏览器 UI 冒烟测试（需 headless Chromium）
node scripts/test_avatar.mjs         # 头像 / 封面上传专项测试
node scripts/test_live.mjs           # 线上端到端验收
```

覆盖范围：注册登录、会话保持、30 个默认分类、多分类关联去重、分类改名同步、完全重复检测、
批量导入原文无损（空格/标点/Unicode/换行）、正文/标题/分类/标签/多关键词搜索、多分类筛选、
复制计数、收藏与取消收藏、三档隐私、跨账号越权拦截、批量管理、删除分类保留文案、
重新登录持久化、分页与五种排序，以及头像上传的压缩、预览、保存、持久化、访客可见与移除。

| 环境 | UI 冒烟 | 头像专项 | API |
|---|---|---|---|
| Python 后端服务器模式 | 26/26 | 18/18 | 41/41 |
| 根路径静态托管 | 28/28 | 18/18 | — |
| 子路径静态托管 | 28/28 | 18/18 | — |
| **线上站点** | **28/28** | **18/18** | — |

线上端到端验收另计 **12/12 通过**（含分享链接、访客访问、复制只取正文）。

复现静态托管环境：

```bash
python3 scripts/serve_static.py 8080                                    # 根路径
CA_BASE_PATH=/copy-archive python3 scripts/serve_static.py 8081          # 子路径
CA_BASE=http://127.0.0.1:8081/copy-archive CA_EXPECT_LOCAL=1 node scripts/test_ui.mjs
```

### 部署备用通道

若本机到 `github.com` 的 git 传输端点被代理阻断（`api.github.com` 仍可用），
可改走 REST API 推送：

```bash
GH_TOKEN=ghp_xxx python3 scripts/push_via_api.py main
GH_TOKEN=ghp_xxx python3 scripts/push_via_api.py gh-pages
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
