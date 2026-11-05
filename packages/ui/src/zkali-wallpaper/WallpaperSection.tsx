import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRangeControl, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { downscaleImageFileToDataUrl } from "./customWallpaper.js";
import { CUSTOM_WALLPAPER_ID, ZKALI_WALLPAPERS } from "./wallpapers.js";

const WALLPAPER_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

/** 外观设置中的壁纸卡：开关 + 画廊（内置 + 自定义导入）+ 模糊/scrim 调节。 */
export function WallpaperSection() {
  const { intl } = useZCodeIntl();
  const settings = useZCodeStore((state) => state.wallpaperSettings);
  const setSettings = useZCodeStore((state) => state.setWallpaperSettings);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importFailed, setImportFailed] = useState(false);

  const handleFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportFailed(false);
    try {
      const customDataUrl = await downscaleImageFileToDataUrl(file);
      setSettings({ id: CUSTOM_WALLPAPER_ID, customDataUrl });
    } catch (error) {
      // 非图片文件、解码失败、canvas 不可用时给出可见提示，不静默吞掉。
      logger.warn("custom wallpaper import failed", error);
      setImportFailed(true);
    } finally {
      setImporting(false);
    }
  };

  const removeCustom = () => {
    setSettings({
      customDataUrl: null,
      // 当前正用自定义图时回退到默认内置壁纸，否则壁纸层会空图。
      ...(settings.id === CUSTOM_WALLPAPER_ID
        ? { id: ZKALI_WALLPAPERS[0]?.id ?? "hex-mesh" }
        : {}),
    });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.wallpaper.title" })}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.wallpaper.description" })}
        </p>
      </div>
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          <SettingsRow
            label={intl.formatMessage({ id: "settings.wallpaper.enable" })}
            description={intl.formatMessage({ id: "settings.wallpaper.enableDescription" })}
            control={
              <Switch
                checked={settings.enabled}
                onCheckedChange={(enabled) => setSettings({ enabled })}
              />
            }
          />
          {settings.enabled ? (
            <>
              <div className="border-t border-border px-4 py-3">
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {ZKALI_WALLPAPERS.map((wallpaper) => {
                    const active = wallpaper.id === settings.id;
                    return (
                      <button
                        key={wallpaper.id}
                        type="button"
                        aria-pressed={active}
                        title={intl.formatMessage({ id: `settings.wallpaper.name.${wallpaper.id}` })}
                        onClick={() => setSettings({ id: wallpaper.id })}
                        className={cn(
                          "aspect-video overflow-hidden rounded-md border-2 transition-colors",
                          active
                            ? "border-primary"
                            : "border-transparent hover:border-foreground/30",
                        )}
                      >
                        <img
                          src={wallpaper.url}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                          style={{ backgroundColor: wallpaper.baseColor }}
                        />
                      </button>
                    );
                  })}
                  {settings.customDataUrl ? (
                    <div
                      className={cn(
                        "group relative aspect-video overflow-hidden rounded-md border-2 transition-colors",
                        settings.id === CUSTOM_WALLPAPER_ID
                          ? "border-primary"
                          : "border-transparent hover:border-foreground/30",
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={settings.id === CUSTOM_WALLPAPER_ID}
                        title={intl.formatMessage({ id: "settings.wallpaper.name.custom" })}
                        onClick={() => setSettings({ id: CUSTOM_WALLPAPER_ID })}
                        className="h-full w-full"
                      >
                        <img
                          src={settings.customDataUrl}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                        />
                      </button>
                      <button
                        type="button"
                        aria-label={intl.formatMessage({
                          id: "settings.wallpaper.removeCustom",
                        })}
                        title={intl.formatMessage({ id: "settings.wallpaper.removeCustom" })}
                        onClick={removeCustom}
                        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <SettingsRow
                label={intl.formatMessage({ id: "settings.wallpaper.import" })}
                description={
                  importFailed
                    ? intl.formatMessage({ id: "settings.wallpaper.importFailed" })
                    : intl.formatMessage({ id: "settings.wallpaper.importDescription" })
                }
                control={
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={WALLPAPER_FILE_ACCEPT}
                      className="hidden"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        // 同一文件二次选择也要触发 change。
                        event.currentTarget.value = "";
                        void handleFilePicked(file);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={importing}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {importing
                        ? intl.formatMessage({ id: "settings.wallpaper.importing" })
                        : intl.formatMessage({ id: "settings.wallpaper.importButton" })}
                    </Button>
                  </>
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.wallpaper.blur" })}
                description={intl.formatMessage({ id: "settings.wallpaper.blurDescription" })}
                control={
                  <SettingsRangeControl
                    value={settings.blurPx}
                    min={0}
                    max={40}
                    step={1}
                    onChange={(blurPx) => setSettings({ blurPx })}
                    valueLabel={`${settings.blurPx}px`}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.wallpaper.scrim" })}
                description={intl.formatMessage({ id: "settings.wallpaper.scrimDescription" })}
                control={
                  <SettingsRangeControl
                    value={settings.scrimPercent}
                    min={0}
                    max={95}
                    step={5}
                    onChange={(scrimPercent) => setSettings({ scrimPercent })}
                    valueLabel={`${settings.scrimPercent}%`}
                  />
                }
              />
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
