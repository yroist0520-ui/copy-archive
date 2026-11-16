/* COPY ARCHIVE — 应用入口 */
import { initCore, refreshSession, renderRoute, loadCategories, navigate, stripBase } from './core.js';
import { registerHome } from './home.js';
import { registerArchive } from './archive.js';
import { registerUpload } from './upload.js';
import { registerCategories } from './categories.js';
import { registerFavorites } from './favorites.js';
import { registerProfile } from './profile.js';
import { registerDiscover } from './discover.js';
import { maybeShowEntryGate } from './entry-gate.js';

registerHome();
registerArchive();
registerUpload();
registerCategories();
registerFavorites();
registerProfile();
registerDiscover();

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
