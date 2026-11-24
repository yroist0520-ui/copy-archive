/* COPY ARCHIVE — 应用入口 */
import { initCore, refreshSession, renderRoute, loadCategories, navigate, stripBase } from './core.js';
import { registerHome } from './home.js';
import { registerArchive } from './archive.js';
import { registerUpload } from './upload.js';
import { registerCategories } from './categories.js';
import { registerFavorites } from './favorites.js';
import { registerProfile } from './profile.js';
import { registerDiscover } from './discover.js';
import { registerSerendipity } from './serendipity.js';
import { registerContribute } from './contribute.js';
import { maybeShowEntryGate } from './entry-gate.js';

/**
 * 静态托管子路径保护（GitHub Pages /copy-archive/ 等）：
 * SPA 深链下浏览器会把相对路径的 favicon/manifest 解析到当前路径而 404，
 * 导致"添加到主屏幕"拿不到图标。这里按脚本自身位置推算站点根，
 * 把 head 里的图标/manifest 引用锚定为绝对路径。
 */
const SITE_ROOT = new URL('../', import.meta.url).pathname;
if (SITE_ROOT !== '/') {
  for (const link of document.head.querySelectorAll('link[rel*="icon"], link[rel="manifest"]')) {
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('/') || href.startsWith('http') || href.startsWith('data:')) continue;
    link.setAttribute('href', SITE_ROOT + href.replace(/^\.\//, ''));
  }
}

registerHome();
registerArchive();
registerUpload();
registerCategories();
registerFavorites();
registerProfile();
registerDiscover();
registerSerendipity();
registerContribute();

initCore();
await refreshSession();
await loadCategories();

// 本地模式（纯静态托管）首次打开时给出版本选择：完整版 or 本地版
maybeShowEntryGate();

const redirect = sessionStorage.getItem('ca_redirect');
if (redirect) {
  sessionStorage.removeItem('ca_redirect');
  navigate(stripBase(redirect), true);
} else {
  await renderRoute();
}
