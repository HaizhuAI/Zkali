import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * zkali 发行版功能开关区（通用设置页）。
 * 自动领取活动投放：登录后服务端下发 claim_zcode_plan 弹窗/banner 时自动走
 * 原有领取链路；关闭后恢复纯手动领取。
 */
export function ZkaliFeatureSection() {
  const { intl } = useZCodeIntl();
  const zkaliAutoClaim = useZCodeStore((state) => state.zkaliAutoClaim);
  const setZkaliAutoClaim = useZCodeStore((state) => state.setZkaliAutoClaim);

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.zkaliFeatures.title" })}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.zkaliFeatures.description" })}
        </p>
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.zkaliAutoClaim" })}
          description={intl.formatMessage({ id: "settings.zkaliAutoClaimDescription" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.zkaliAutoClaim" })}
              checked={zkaliAutoClaim}
              onCheckedChange={setZkaliAutoClaim}
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
