import { useEffect, useState, useCallback } from "react";

export type Theme =
  | "light"
  | "dark"
  | "zai-light"
  | "zai-dark"
  | "zkali-dream"
  | "zkali-cyber"
  | "zkali-nightops"
  | "system";
export type ResolvedTheme = "light" | "dark";

// zkali 沉浸式主题（Dream Skin 风格：主题色 + 半透明玻璃面板 + 配对壁纸）。
const ZKALI_THEMES = new Set<Theme>(["zkali-dream", "zkali-cyber", "zkali-nightops"]);

/** 与 styles.css 中变量块类名一一对应的应用类名。 */
const APPLIED_THEME_CLASSES = [
  "theme-zai-light",
  "theme-zai-dark",
  "theme-zkali-dream",
  "theme-zkali-cyber",
  "theme-zkali-nightops",
] as const;

function appliedThemeClass(theme: Theme): string | null {
  switch (theme) {
    case "zai-light":
      return "theme-zai-light";
    case "zkali-dream":
      return "theme-zkali-dream";
    case "zkali-cyber":
      return "theme-zkali-cyber";
    case "zkali-nightops":
      return "theme-zkali-nightops";
    default:
      return "theme-zai-dark";
  }
}

const STORAGE_KEY = "zcode-theme";
const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-zcode-browser-theme-surface";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }

  return theme === "dark" || theme === "zai-dark" || ZKALI_THEMES.has(theme) ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

export function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  const appliedTheme =
    theme === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : normalizeThemePreference(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  const activeClass = appliedThemeClass(appliedTheme);
  for (const cls of APPLIED_THEME_CLASSES) {
    document.documentElement.classList.toggle(cls, cls === activeClass);
  }
  syncBrowserThemeSurface(resolved);
}

function isTheme(value: string | null): value is Theme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "zkali-dream" ||
    value === "zkali-cyber" ||
    value === "zkali-nightops" ||
    value === "system"
  );
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    // 默认主题统一收敛到 Zai dark，避免旧 hook 兜底值和 Zustand store 默认值分叉。
    return isTheme(saved) ? normalizeThemePreference(saved) : "zai-dark";
  });

  const setTheme = useCallback((t: Theme) => {
    const normalizedTheme = normalizeThemePreference(t);
    localStorage.setItem(STORAGE_KEY, normalizedTheme);
    setThemeState(normalizedTheme);
    applyTheme(normalizedTheme);
  }, []);

  // 初始化 + system 模式下监听系统偏好变化
  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return { theme, setTheme } as const;
}
