// zkali 壁纸主题模块：偏好的归一化、持久化与 DOM 应用。
// 与 useTheme 同构——localStorage 持久 + documentElement class 驱动 CSS 覆盖。

export interface WallpaperSettings {
  /** 关闭时整张壁纸层不渲染，也不施加 bg-background 穿透覆盖。 */
  enabled: boolean;
  /** ZKALI_WALLPAPERS 中的条目 id，或 CUSTOM_WALLPAPER_ID 表示使用自定义图。 */
  id: string;
  /**
   * 用户导入的自定义壁纸（canvas 降采样后的 data URL）。
   * 直接走 data URL 而不是本地路径：桌面打包态是 file:// 源、dev/Web 是 http 源，
   * file:// 图片在 http 源下会被浏览器拦截；授权式媒体预览协议又有 30 分钟 TTL，
   * 都不适合常驻壁纸。降采样到 ≤4K 后 data URL 一般在 2MB 内，localStorage 放得下。
   */
  customDataUrl: string | null;
  /** 背景图高斯模糊半径 px。 */
  blurPx: number;
  /** 深色 scrim 强度（0-95），保证前景可读性。 */
  scrimPercent: number;
}

export const WALLPAPER_SETTINGS_STORAGE_KEY = "zkali-wallpaper-settings";
export const WALLPAPER_ENABLED_CLASS = "zkali-wallpaper";

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  enabled: true,
  id: "hex-mesh",
  customDataUrl: null,
  blurPx: 0,
  scrimPercent: 55,
};

export function normalizeWallpaperSettings(raw: unknown): WallpaperSettings {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_WALLPAPER_SETTINGS.enabled,
    id:
      typeof source.id === "string" && source.id.trim().length > 0
        ? source.id.trim()
        : DEFAULT_WALLPAPER_SETTINGS.id,
    customDataUrl:
      typeof source.customDataUrl === "string" && source.customDataUrl.startsWith("data:image/")
        ? source.customDataUrl
        : null,
    blurPx: clamp(source.blurPx, 0, 40, DEFAULT_WALLPAPER_SETTINGS.blurPx),
    scrimPercent: clamp(source.scrimPercent, 0, 95, DEFAULT_WALLPAPER_SETTINGS.scrimPercent),
  };
}

export function loadWallpaperSettings(
  read: (key: string) => string | null,
): WallpaperSettings {
  try {
    const raw = read(WALLPAPER_SETTINGS_STORAGE_KEY);
    return normalizeWallpaperSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_WALLPAPER_SETTINGS };
  }
}

/** 应用到 DOM：class 驱动 styles.css 中的画布穿透规则，scrim/blur 走内联 CSS 变量。 */
export function applyWallpaperSettings(settings: WallpaperSettings): void {
  const root = document.documentElement;
  root.classList.toggle(WALLPAPER_ENABLED_CLASS, settings.enabled);
  root.style.setProperty("--zkali-wallpaper-scrim", String(settings.scrimPercent / 100));
}
