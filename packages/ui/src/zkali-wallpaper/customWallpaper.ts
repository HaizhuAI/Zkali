// 自定义壁纸导入：把用户选的本地图片经 canvas 降采样后转 data URL。
// 不用本地路径的原因见 wallpaperSettings.ts 注释——http 源下 file:// 图片会被浏览器拦截，
// 授权式媒体预览协议又会过期；data URL 在桌面打包态、dev server、Web 端行为一致。

/** 超过此尺寸等比缩小，避免大体积 data URL 撑爆 localStorage（配额约 5MB）。 */
const MAX_WALLPAPER_EDGE = 3840;
/** JPEG 质量：4K 壁纸此档位通常 < 1.5MB（base64 后 < 2MB）。 */
const JPEG_QUALITY = 0.85;

async function loadImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image decode failed"));
    });
    image.src = objectUrl;
    await loaded;
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 读取图片文件并降采样到 ≤3840 边长，返回 JPEG data URL。 */
export async function downscaleImageFileToDataUrl(file: File): Promise<string> {
  const image = await loadImage(file);
  const scale = Math.min(
    1,
    MAX_WALLPAPER_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
