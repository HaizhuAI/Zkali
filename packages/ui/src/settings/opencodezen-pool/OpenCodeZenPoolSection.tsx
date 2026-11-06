import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 池 admin API 返回的脱敏状态投影（与 zkali-opencodezen-pool.mjs adminState 对齐）。 */
interface PoolAccount {
  id: string;
  label: string;
  proxyId: string | null;
  proxyLabel: string | null;
  createdAt: string | null;
  coolingDown: boolean;
  cooldownUntil: number;
  consecutiveFails: number;
  requests: number;
  failures: number;
  lastError: string | null;
  lastUsedAt: string | null;
}

interface PoolProxy {
  id: string;
  label: string;
  url: string;
  scheme: string;
  host: string;
  assignedTo: string[];
}

interface PoolState {
  version: string;
  enabled: boolean;
  port: number;
  pid: number;
  upstream: string;
  requestTimeoutMs: number;
  accounts: PoolAccount[];
  proxies: PoolProxy[];
  models: string[];
  stats: {
    accountCount: number;
    proxyCount: number;
    healthyAccounts: number;
    totalRequests: number;
    totalFailures: number;
  };
}

type BusyKey =
  | "toggle"
  | "addAccount"
  | "importAccounts"
  | "importProxies"
  | "assign"
  | "unassign"
  | `account:${string}`
  | `proxy:${string}`
  | `test:${string}`;

/** OpenCodeZen 免费号池管理页（仅桌面可见）：设备身份/代理池/轮询状态一体管理。 */
export function OpenCodeZenPoolSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [state, setState] = useState<PoolState | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const [accountImportText, setAccountImportText] = useState("");
  const [proxyImportText, setProxyImportText] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const t = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id }, values),
    [intl],
  );

  const request = useCallback(
    async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => {
      const res = await platform.zkaliOpencodeZenPoolRequest({ method, path, body });
      if (res.running === false) {
        setRunning(false);
        return { ok: false as const, status: res.status, body: undefined };
      }
      setRunning(true);
      const errBody = res.body as { error?: { message?: string } } | undefined;
      if (res.status >= 400) {
        return { ok: false as const, status: res.status, error: errBody?.error?.message ?? res.error };
      }
      return { ok: true as const, status: res.status, body: res.body };
    },
    [platform],
  );

  const refresh = useCallback(async () => {
    setLoadError(null);
    const res = await request("GET", "/admin/state");
    if (res.ok) {
      setState(res.body as PoolState);
    } else if (res.status === 0) {
      setState(null);
      setLoadError(t("settings.opencodezenPool.notRunning"));
    } else {
      setLoadError(res.error ?? `HTTP ${res.status}`);
    }
  }, [request, t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(
    async (key: BusyKey, fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(key);
      setActionNotice(null);
      try {
        await fn();
        await refresh();
      } catch (error) {
        logger.warn("opencodezen pool action failed", { key, error: String(error) });
        setActionNotice(String(error));
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  const proxyOptions = useMemo(
    () => state?.proxies ?? [],
    [state],
  );

  if (!isDesktop) {
    return (
      <div className="px-1 py-4 text-ui-base text-foreground-subtle">
        {t("settings.opencodezenPool.desktopOnly")}
      </div>
    );
  }

  const enabled = state?.enabled ?? false;

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.opencodezenPool.enable")}
          description={t("settings.opencodezenPool.enableDesc")}
          control={
            <Switch
              checked={enabled && running === true}
              disabled={busy === "toggle"}
              onCheckedChange={(checked) =>
                void act("toggle", async () => {
                  await request("POST", "/admin/enabled", { enabled: checked });
                })
              }
            />
          }
        />
        <SettingsRow
          label={t("settings.opencodezenPool.status")}
          description={
            running === false
              ? t("settings.opencodezenPool.notRunning")
              : loadError
                ? loadError
                : state
                  ? t("settings.opencodezenPool.statusDesc", {
                      port: state.port,
                      accounts: state.stats.accountCount,
                      healthy: state.stats.healthyAccounts,
                      requests: state.stats.totalRequests,
                    })
                  : "…"
          }
          control={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t("settings.opencodezenPool.refresh")}
            </Button>
          }
        />
      </SettingsGroupCard>

      {actionNotice ? (
        <div className="rounded-lg border border-border bg-card px-4 py-2 text-ui-base text-destructive">
          {actionNotice}
        </div>
      ) : null}

      <div className="text-ui-base font-medium text-foreground">
        {t("settings.opencodezenPool.accounts")}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.opencodezenPool.addAccount")}
          description={t("settings.opencodezenPool.addAccountDesc")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void act("addAccount", () => request("POST", "/admin/accounts", {}))}
            >
              {busy === "addAccount" ? "…" : t("settings.opencodezenPool.add")}
            </Button>
          }
        />
        <SettingsRow
          label={t("settings.opencodezenPool.importAccounts")}
          description={t("settings.opencodezenPool.importAccountsDesc")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !accountImportText.trim()}
              onClick={() =>
                void act("importAccounts", async () => {
                  await request("POST", "/admin/accounts/import", { text: accountImportText });
                  setAccountImportText("");
                })
              }
            >
              {busy === "importAccounts" ? "…" : t("settings.opencodezenPool.import")}
            </Button>
          }
          detail={
            <textarea
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
              rows={3}
              placeholder={t("settings.opencodezenPool.importAccountsPlaceholder")}
              value={accountImportText}
              onChange={(e) => setAccountImportText(e.target.value)}
            />
          }
        />
        {(state?.accounts ?? []).map((account) => (
          <div key={account.id} className="border-t border-border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-ui-sm text-foreground">
                  {account.label ? `${account.label} · ` : ""}
                  {account.id}
                </div>
                <div className="mt-0.5 text-ui-sm text-foreground-subtle">
                  {account.coolingDown
                    ? t("settings.opencodezenPool.accountCooling")
                    : t("settings.opencodezenPool.accountReady")}
                  {" · "}
                  {t("settings.opencodezenPool.accountStats", {
                    requests: account.requests,
                    failures: account.failures,
                  })}
                  {account.lastError ? ` · ${account.lastError}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  className="h-8 rounded-md border border-border bg-surface px-2 text-ui-sm text-foreground"
                  value={account.proxyId ?? ""}
                  disabled={busy !== null}
                  onChange={(e) =>
                    void act(`account:${account.id}`, () =>
                      request("PATCH", `/admin/accounts/${account.id}`, {
                        proxyId: e.target.value || null,
                      }),
                    )
                  }
                >
                  <option value="">{t("settings.opencodezenPool.noProxy")}</option>
                  {proxyOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label || p.url}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`test:${account.id}`, async () => {
                      const res = await request("POST", `/admin/accounts/${account.id}/test`);
                      setTestResults((prev) => ({
                        ...prev,
                        [account.id]: res.ok
                          ? {
                              ok: (res.body as { ok?: boolean })?.ok === true,
                              text: (res.body as { error?: string; latencyMs?: number })?.error ??
                                `${(res.body as { latencyMs?: number })?.latencyMs ?? "?"}ms`,
                            }
                          : { ok: false, text: res.error ?? `HTTP ${res.status}` },
                      }));
                    })
                  }
                >
                  {busy === `test:${account.id}` ? "…" : t("settings.opencodezenPool.test")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`account:${account.id}`, () =>
                      request("DELETE", `/admin/accounts/${account.id}`),
                    )
                  }
                >
                  {t("settings.opencodezenPool.delete")}
                </Button>
              </div>
            </div>
            {testResults[account.id] ? (
              <div
                className={
                  testResults[account.id]?.ok
                    ? "mt-1 text-ui-sm text-emerald-500"
                    : "mt-1 text-ui-sm text-destructive"
                }
              >
                {testResults[account.id]?.text}
              </div>
            ) : null}
          </div>
        ))}
        {(state?.accounts ?? []).length === 0 ? (
          <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
            {t("settings.opencodezenPool.noAccounts")}
          </div>
        ) : null}
      </SettingsGroupCard>

      <div className="text-ui-base font-medium text-foreground">
        {t("settings.opencodezenPool.proxies")}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.opencodezenPool.importProxies")}
          description={t("settings.opencodezenPool.importProxiesDesc")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !proxyImportText.trim()}
              onClick={() =>
                void act("importProxies", async () => {
                  await request("POST", "/admin/proxies/import", { text: proxyImportText });
                  setProxyImportText("");
                })
              }
            >
              {busy === "importProxies" ? "…" : t("settings.opencodezenPool.import")}
            </Button>
          }
          detail={
            <textarea
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
              rows={3}
              placeholder={t("settings.opencodezenPool.importProxiesPlaceholder")}
              value={proxyImportText}
              onChange={(e) => setProxyImportText(e.target.value)}
            />
          }
        />
        <SettingsRow
          label={t("settings.opencodezenPool.assignAll")}
          description={t("settings.opencodezenPool.assignAllDesc")}
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || (state?.proxies.length ?? 0) === 0}
                onClick={() => void act("assign", () => request("POST", "/admin/assign"))}
              >
                {busy === "assign" ? "…" : t("settings.opencodezenPool.assign")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void act("unassign", () => request("POST", "/admin/unassign"))}
              >
                {t("settings.opencodezenPool.unassign")}
              </Button>
            </div>
          }
        />
        {(state?.proxies ?? []).map((proxy) => (
          <div key={proxy.id} className="border-t border-border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-ui-sm text-foreground">{proxy.url}</div>
                <div className="mt-0.5 text-ui-sm text-foreground-subtle">
                  {proxy.scheme} ·{" "}
                  {proxy.assignedTo.length > 0
                    ? t("settings.opencodezenPool.proxyAssigned", { count: proxy.assignedTo.length })
                    : t("settings.opencodezenPool.proxyIdle")}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void act(`proxy:${proxy.id}`, () => request("DELETE", `/admin/proxies/${proxy.id}`))
                }
              >
                {t("settings.opencodezenPool.delete")}
              </Button>
            </div>
          </div>
        ))}
        {(state?.proxies ?? []).length === 0 ? (
          <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
            {t("settings.opencodezenPool.noProxies")}
          </div>
        ) : null}
      </SettingsGroupCard>

      <div className="text-ui-base font-medium text-foreground">
        {t("settings.opencodezenPool.models")}
      </div>
      <SettingsGroupCard>
        <div className="px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {(state?.models ?? []).map((id) => (
              <span
                key={id}
                className="rounded-md bg-surface px-2 py-1 font-mono text-ui-sm text-foreground"
              >
                {id}
              </span>
            ))}
            {(state?.models ?? []).length === 0 ? (
              <span className="text-ui-sm text-foreground-subtle">
                {t("settings.opencodezenPool.noModels")}
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-ui-sm text-foreground-subtle">
            {t("settings.opencodezenPool.modelsDesc")}
          </div>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
