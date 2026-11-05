import { Card, CardContent } from "@/components/ui/card.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRangeControl, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { ZKALI_WALLPAPERS } from "./wallpapers.js";

/** 外观设置中的壁纸卡：开关 + 画廊 + 模糊/scrim 调节。 */
export function WallpaperSection() {
  const { intl } = useZCodeIntl();
  const settings = useZCodeStore((state) => state.wallpaperSettings);
  const setSettings = useZCodeStore((state) => state.setWallpaperSettings);

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
                </div>
              </div>
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
