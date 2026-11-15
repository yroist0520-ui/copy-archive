/* COPY ARCHIVE — 图片处理：本地压缩、上传槽绑定
 *
 * 头像与封面都由用户在本地选择图片，浏览器端压缩后再提交，
 * 不需要填写任何外部链接。压缩结果以 data URL 形式存入档案字段，
 * 因此在纯静态托管（GitHub Pages）形态下同样可用，不依赖后端文件服务。
 */

/**
 * 压缩图片。
 * @param {File} file 用户选择的原始图片
 * @param {object} opts
 *   maxWidth  最大宽度；maxHeight 最大高度
 *   crop      是否居中裁剪到目标宽高比（头像用 true，封面用 true）
 *   quality   JPEG/WebP 质量
 * @returns {Promise<string>} data URL
 */
export function compressImage(file, { maxWidth = 256, maxHeight = 256, crop = true, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) {
      reject(new Error('请选择图片文件'));
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      reject(new Error('图片过大，请选择 20MB 以内的文件'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片无法解析，请换一张试试'));
      img.onload = () => {
        const sw = img.naturalWidth || img.width;
        const sh = img.naturalHeight || img.height;
        if (!sw || !sh) { reject(new Error('图片尺寸无效')); return; }

        const canvas = document.createElement('canvas');
        let sx = 0;
        let sy = 0;
        let cw = sw;
        let ch = sh;

        if (crop) {
          // 居中裁剪到目标宽高比，避免拉伸变形
          const target = maxWidth / maxHeight;
          const source = sw / sh;
          if (source > target) {
            cw = sh * target;
            sx = (sw - cw) / 2;
          } else {
            ch = sw / target;
            sy = (sh - ch) / 2;
          }
          canvas.width = maxWidth;
          canvas.height = maxHeight;
        } else {
          const scale = Math.min(1, maxWidth / sw, maxHeight / sh);
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          cw = canvas.width;
          ch = canvas.height;
        }

        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);

        // 优先 WebP（体积更小），浏览器不支持时退回 JPEG
        const webp = canvas.toDataURL('image/webp', quality);
        const out = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 估算 data URL 的体积，用于提示用户 */
export function dataUrlSize(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return 0;
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.round((base64.length * 3) / 4);
}

/**
 * 把一个上传槽元素绑定为「点击选择图片」。
 *
 * 结构约定：
 *   .upload-slot            容器（点击触发文件选择）
 *   input[type=file]        隐藏的文件输入
 *   .upload-preview         预览图（可隐藏）
 *   .upload-empty           空态占位（可隐藏）
 *   .upload-meta            说明文字
 *   .upload-clear           移除按钮（可隐藏）
 *
 * @param {HTMLElement} slot
 * @param {object} opts
 *   maxWidth/maxHeight/crop/quality  压缩参数
 *   value        当前值（data URL 或空串）
 *   onChange     (dataUrl: string) => void  选择或移除后回调
 *   onStatus     (message: string, kind: 'ok'|'error') => void  状态提示
 */
export function bindImageSlot(slot, {
  maxWidth = 256, maxHeight = 256, crop = true, quality = 0.82,
  value = '', onChange = () => {}, onStatus = () => {},
} = {}) {
  const input = slot.querySelector('input[type="file"]');
  const preview = slot.querySelector('.upload-preview');
  const empty = slot.querySelector('.upload-empty');
  const meta = slot.querySelector('.upload-meta');
  const clear = slot.querySelector('.upload-clear');
  if (!input) return;

  let current = value || '';

  function paint() {
    if (current) {
      if (preview) {
        preview.src = current;
        preview.hidden = false;
      }
      if (empty) empty.hidden = true;
      if (clear) clear.hidden = false;
      if (meta) meta.textContent = `已选择 · ${Math.round(dataUrlSize(current) / 1024)} KB · 点击可更换`;
    } else {
      if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
      if (empty) empty.hidden = false;
      if (clear) clear.hidden = true;
      if (meta) meta.textContent = '支持 JPG / PNG / WebP，浏览器本地压缩后保存';
    }
  }
  paint();

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      onStatus('正在处理图片…', 'ok');
      const dataUrl = await compressImage(file, { maxWidth, maxHeight, crop, quality });
      current = dataUrl;
      paint();
      onChange(current);
      onStatus(`图片已就绪（${Math.round(dataUrlSize(current) / 1024)} KB）`, 'ok');
    } catch (err) {
      onStatus(err.message || '图片处理失败', 'error');
    }
  });

  slot.addEventListener('click', (e) => {
    if (e.target.closest('.upload-clear')) return;
    input.click();
  });

  if (clear) {
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      current = '';
      paint();
      onChange('');
      onStatus('已移除图片', 'ok');
    });
  }
}
