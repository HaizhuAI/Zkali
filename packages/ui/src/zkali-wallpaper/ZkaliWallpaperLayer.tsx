import { useZCodeStore } from "@/store/StoreProvider.js";
import { CUSTOM_WALLPAPER_ID, findWallpaper } from "./wallpapers.js";

/**
 * 全局壁纸层：挂在 RootShell 第一个子位，absolute 铺满窗口。
 * 画布透明由 styles.css 中 `html.zkali-wallpaper .bg-background` 规则完成；
 * 卡片、弹层、终端等不透明 token 浮在壁纸与 scrim 之上，对应 dsh 玻璃观感。
 */
export function ZkaliWallpaperLayer() {
  const settings = useZCodeStore((state) => state.wallpaperSettings);
  if (!settings.enabled) return null;

  const wallpaper = findWallpaper(settings.id);
  const isCustom = settings.id === CUSTOM_WALLPAPER_ID;
  const src = isCustom ? settings.customDataUrl : wallpaper?.url;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          style={{
            backgroundColor: wallpaper?.baseColor ?? "#04090e",
            filter: settings.blurPx > 0 ? `blur(${settings.blurPx}px)` : undefined,
            transform: settings.blurPx > 0 ? "scale(1.05)" : undefined,
          }}
        />
      ) : null}
      <div
        className="absolute inset-0 bg-black"
        style={{ opacity: settings.scrimPercent / 100 }}
      />
    </div>
  );
}
