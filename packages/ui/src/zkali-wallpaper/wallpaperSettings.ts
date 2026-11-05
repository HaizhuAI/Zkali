// zkali 壁纸主题模块：偏好的归一化、持久化与 DOM 应用。
// 与 useTheme 同构——localStorage 持久 + documentElement class 驱动 CSS 覆盖。

export interface WallpaperSettings {
  /** 关闭时整张壁纸层不渲染，也不施加 bg-background 穿透覆盖。 */
  enabled: boolean;
  /** ZKALI_WALLPAPERS 中的条目 id；"none" 表示仅保留玻璃观感占位（无图）。 */
  id: string;
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
