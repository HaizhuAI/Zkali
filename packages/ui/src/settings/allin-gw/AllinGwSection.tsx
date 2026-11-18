import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 网关 /admin/state 返回的脱敏状态投影（与 zkali-allin-gw.mjs adminState 对齐）。 */
interface GwAccount {
  id: string;
  label?: string;
  type?: string;
  access?: string;
  proxy?: string | null;
  enabled: boolean;
  createdAt?: string;
  health?: { fail?: number; cooldownUntil?: number; lastError?: string };
}

interface GwProvider {
  name: string;
  lane: string;
  enabled: boolean;
  baseUrl?: string;
  authFlow?: string;
  loginUrl?: string;
  models?: string[];
  keyProvider?: boolean;
  placeholder?: boolean;
  accounts?: GwAccount[];
  keys?: string[];
}

interface GwProxy {
  id: string;
  url: string;
}

interface GwState {
  version: string;
  port: number;
  enabled: boolean;
  providers: Record<string, GwProvider>;
  groups: Record<string, { display?: string; targets?: string[] }>;
  proxies: GwProxy[];
  models: number;
}

interface AuthFlowInfo {
  flowId: string;
  kind?: string;
  authorizeUrl?: string;
  userCode?: string;
  instructions?: string;
  manualHint?: boolean;
  status?: string;
  error?: string;
  phonePending?: boolean;
}

type BusyKey = string | null;

/** Allin 聚合网关管理页（仅桌面可见）：21+ 供应商账号/授权流/代理池/分组路由。 */
export function AllinGwSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [state, setState] = useState<GwState | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flow, setFlow] = useState<AuthFlowInfo | null>(null);
  const [flowCode, setFlowCode] = useState("");
  const [flowPhone, setFlowPhone] = useState("");
  const [tokenText, setTokenText] = useState("");
  const [keysText, setKeysText] = useState("");
  const [proxyImportText, setProxyImportText] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const flowTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const t = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id }, values),
    [intl],
  );

  const request = useCallback(
    async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => {
      const res = await platform.zkaliAllinRequest({ method, path, body });
      if (res.running === false) {
        setRunning(false);
        return { ok: false as const, status: res.status, body: undefined };
      }
      setRunning(true);
      const errBody = res.body as { error?: { message?: string } | string } | undefined;
      const errMsg = typeof errBody?.error === "string" ? errBody.error : errBody?.error?.message;
      if (res.status >= 400) {
        return { ok: false as const, status: res.status, error: errMsg ?? res.error };
      }
      return { ok: true as const, status: res.status, body: res.body };
    },
    [platform],
  );

  const refresh = useCallback(async () => {
    setLoadError(null);
    const res = await request("GET", "/admin/state");
    if (res.ok) {
      setState(res.body as GwState);
    } else if (res.status === 0) {
      setState(null);
      setLoadError(t("settings.allinGw.notRunning"));
    } else {
      setLoadError(res.error ?? `HTTP ${res.status}`);
    }
  }, [request, t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 授权流轮询：device-poll 类流程自动续轮直到 done/failed
  useEffect(() => {
    if (flowTimer.current) clearInterval(flowTimer.current);
    flowTimer.current = null;
    if (!flow?.flowId || flow.kind !== "device-poll" || flow.status === "done" || flow.status === "failed") return;
    flowTimer.current = setInterval(async () => {
      const res = await request("POST", "/admin/auth/poll", { flowId: flow.flowId });
      if (!res.ok) return;
      const body = res.body as AuthFlowInfo & { account?: { id?: string } };
      if (body.status === "done") {
        setFlow(null);
        setActionNotice(t("settings.allinGw.authDone"));
        void refresh();
      } else if (body.status === "failed") {
        setFlow((prev) => (prev ? { ...prev, status: "failed", error: body.error } : prev));
      }
    }, 2500);
    return () => {
      if (flowTimer.current) clearInterval(flowTimer.current);
      flowTimer.current = null;
    };
  }, [flow, request, refresh, t]);

  const act = useCallback(
    async (key: BusyKey, fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(key);
      setActionNotice(null);
      try {
        await fn();
        await refresh();
      } catch (error) {
        logger.warn("allin gw action failed", { key, error: String(error) });
        setActionNotice(String(error));
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  const providerEntries = useMemo(
    () => Object.entries(state?.providers ?? {}),
    [state],
  );

  const accountCountTotal = useMemo(
    () => providerEntries.reduce((n, [, p]) => n + (p.accounts?.length ?? 0) + (p.keys?.length ?? 0), 0),
    [providerEntries],
  );

  if (!isDesktop) {
    return (
      <div className="px-1 py-4 text-ui-base text-foreground-subtle">
        {t("settings.allinGw.desktopOnly")}
      </div>
    );
  }

  const enabled = state?.enabled ?? false;
  const startAuth = (pid: string) =>
    void act(`auth:${pid}`, async () => {
      setFlow(null);
      setFlowCode("");
      const body: Record<string, unknown> = { provider: pid };
      if (pid === "loomy") body.phone = flowPhone;
      const res = await request("POST", "/admin/auth/start", body);
      if (res.ok) {
        const info = res.body as AuthFlowInfo;
        setFlow({ ...info });
      } else {
        setActionNotice(res.error ?? `HTTP ${res.status}`);
      }
    });

  const submitCode = () =>
    void act("auth-code", async () => {
      if (!flow?.flowId || !flowCode.trim()) return;
      const res = await request("POST", "/admin/auth/code", { flowId: flow.flowId, code: flowCode.trim() });
      if (res.ok) {
        const body = res.body as { status?: string; error?: string };
        if (body.status === "done") {
          setFlow(null);
          setFlowCode("");
          setActionNotice(t("settings.allinGw.authDone"));
        } else {
          setFlow((prev) => (prev ? { ...prev, status: "failed", error: body.error ?? "failed" } : prev));
        }
      } else {
        setFlow((prev) => (prev ? { ...prev, status: "failed", error: res.error } : prev));
      }
      await refresh();
    });

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.allinGw.enable")}
          description={t("settings.allinGw.enableDesc")}
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
          label={t("settings.allinGw.status")}
          description={
            running === false
              ? t("settings.allinGw.notRunning")
              : loadError
                ? loadError
                : state
                  ? t("settings.allinGw.statusDesc", {
                      port: state.port,
                      providers: providerEntries.length,
                      accounts: accountCountTotal,
                      models: state.models,
                    })
                  : "…"
          }
          control={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t("settings.allinGw.refresh")}
            </Button>
          }
        />
      </SettingsGroupCard>

      {actionNotice ? (
        <div className="rounded-lg border border-border bg-card px-4 py-2 text-ui-base text-foreground">
          {actionNotice}
        </div>
      ) : null}

      {/* 授权流卡片：start 后的进行态统一展示 */}
      {flow ? (
        <SettingsGroupCard>
          <div className="px-4 py-3">
            <div className="text-ui-base font-medium text-foreground">
              {t("settings.allinGw.authTitle")}
            </div>
            {flow.instructions ? (
              <div className="mt-1 text-ui-sm text-foreground-subtle">{flow.instructions}</div>
            ) : null}
            {flow.authorizeUrl ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  className="h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-ui-sm text-foreground"
                  value={flow.authorizeUrl}
                  onFocus={(e) => e.target.select()}
                />
                {flow.userCode ? (
                  <span className="shrink-0 rounded-md bg-surface px-2 py-1 font-mono text-ui-base text-foreground">
                    {flow.userCode}
                  </span>
                ) : null}
              </div>
            ) : null}
            {flow.kind === "code-paste" && flow.status !== "failed" ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
                  placeholder={t("settings.allinGw.authCodePlaceholder")}
                  value={flowCode}
                  onChange={(e) => setFlowCode(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !flowCode.trim()}
                  onClick={submitCode}
                >
                  {busy === "auth-code" ? "…" : t("settings.allinGw.authSubmit")}
                </Button>
              </div>
            ) : null}
            {flow.kind === "device-poll" && flow.status !== "failed" ? (
              <div className="mt-2 text-ui-sm text-foreground-subtle">
                {t("settings.allinGw.authPolling")}
              </div>
            ) : null}
            {flow.status === "failed" ? (
              <div className="mt-2 text-ui-sm text-destructive">
                {t("settings.allinGw.authFailed")}: {flow.error}
              </div>
            ) : null}
            <div className="mt-2">
              <Button variant="outline" size="sm" onClick={() => setFlow(null)}>
                {t("settings.allinGw.authCancel")}
              </Button>
            </div>
          </div>
        </SettingsGroupCard>
      ) : null}

      <div className="text-ui-base font-medium text-foreground">
        {t("settings.allinGw.providers")}
      </div>
      <SettingsGroupCard>
        {providerEntries.map(([pid, p]) => {
          const isOpen = expanded === pid;
          const accts = p.accounts ?? [];
          const keys = p.keys ?? [];
          return (
            <div key={pid} className="border-t border-border first:border-t-0">
              <div
                className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3"
                onClick={() => setExpanded(isOpen ? null : pid)}
              >
                <div className="min-w-0">
                  <div className="text-ui-base text-foreground">
                    {p.name}
                    <span className="ml-2 font-mono text-ui-sm text-foreground-faint">{pid}</span>
                    {p.placeholder ? (
                      <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                        {t("settings.allinGw.placeholder")}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-ui-sm text-foreground-subtle">
                    {t("settings.allinGw.providerMeta", {
                      accounts: accts.length + keys.length,
                      models: p.models?.length ?? 0,
                    })}
                    {p.models?.length ? ` · ${p.models.slice(0, 4).join(", ")}${p.models.length > 4 ? "…" : ""}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={p.enabled}
                    disabled={busy !== null}
                    onCheckedChange={(checked) =>
                      void act(`p:${pid}`, () =>
                        request("PATCH", `/admin/providers/${pid}`, { enabled: checked }),
                      )
                    }
                  />
                  <span className="text-ui-sm text-foreground-faint">{isOpen ? "-" : "+"}</span>
                </div>
              </div>

              {isOpen ? (
                <div className="border-t border-border px-4 py-3">
                  {/* 登录/授权入口 */}
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {p.authFlow === "loomy-phone" ? (
                      <>
                        <input
                          className="h-8 w-44 rounded-md border border-border bg-surface px-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
                          placeholder={t("settings.allinGw.phonePlaceholder")}
                          value={flowPhone}
                          onChange={(e) => setFlowPhone(e.target.value)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null || !/^1\d{10}$/.test(flowPhone)}
                          onClick={() => startAuth(pid)}
                        >
                          {busy === `auth:${pid}` ? "…" : t("settings.allinGw.sendCode")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => startAuth(pid)}
                      >
                        {busy === `auth:${pid}` ? "…" : t("settings.allinGw.login")}
                      </Button>
                    )}
                    {p.loginUrl ? (
                      <span className="text-ui-sm text-foreground-faint">{p.loginUrl}</span>
                    ) : null}
                  </div>

                  {/* 手动 token / key 导入（所有供应商都可直接粘凭据；key 供应商走 keys 池） */}
                  {p.keyProvider ? (
                    <div className="mb-3">
                      <div className="mb-1 text-ui-sm text-foreground-subtle">
                        {t("settings.allinGw.importKeysDesc")}
                      </div>
                      <div className="flex items-start gap-2">
                        <textarea
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
                          rows={2}
                          placeholder="sk-... (每行一个)"
                          value={keysText}
                          onChange={(e) => setKeysText(e.target.value)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null || !keysText.trim()}
                          onClick={() =>
                            void act(`keys:${pid}`, async () => {
                              const res = await request("POST", "/admin/keys", {
                                provider: pid,
                                keys: keysText.split("\n").map((k) => k.trim()).filter(Boolean),
                              });
                              if (res.ok) setKeysText("");
                              else setActionNotice(res.error ?? `HTTP ${res.status}`);
                            })
                          }
                        >
                          {busy === `keys:${pid}` ? "…" : t("settings.allinGw.import")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mb-3">
                      <div className="mb-1 text-ui-sm text-foreground-subtle">
                        {t("settings.allinGw.manualTokenDesc")}
                      </div>
                      <div className="flex items-start gap-2">
                        <input
                          className="h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
                          placeholder={t("settings.allinGw.tokenPlaceholder")}
                          value={tokenText}
                          onChange={(e) => setTokenText(e.target.value)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null || !tokenText.trim()}
                          onClick={() =>
                            void act(`tok:${pid}`, async () => {
                              const res = await request("POST", "/admin/accounts", {
                                provider: pid,
                                access: tokenText.trim(),
                                type: "token",
                              });
                              if (res.ok) setTokenText("");
                              else setActionNotice(res.error ?? `HTTP ${res.status}`);
                            })
                          }
                        >
                          {busy === `tok:${pid}` ? "…" : t("settings.allinGw.import")}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* 账号列表 */}
                  {accts.map((a) => {
                    const cooling = (a.health?.cooldownUntil ?? 0) > Date.now();
                    return (
                      <div key={a.id} className="flex items-center justify-between gap-3 border-t border-border py-2 first:border-t-0">
                        <div className="min-w-0">
                          <div className="truncate font-mono text-ui-sm text-foreground">
                            {a.label ? `${a.label} · ` : ""}
                            {a.access ?? a.id}
                          </div>
                          <div className="text-ui-sm text-foreground-subtle">
                            {cooling
                              ? t("settings.allinGw.accountCooling")
                              : t("settings.allinGw.accountReady")}
                            {a.health?.lastError ? ` · ${a.health.lastError}` : ""}
                            {a.proxy ? ` · ${a.proxy}` : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(`test:${a.id}`, async () => {
                                const res = await request("POST", `/admin/accounts/${a.id}/test`);
                                setTestResults((prev) => ({
                                  ...prev,
                                  [a.id]: res.ok
                                    ? (res.body as { ok?: boolean; error?: string; ms?: number })?.ok === true
                                      ? { ok: true, text: `${(res.body as { ms?: number })?.ms ?? "?"}ms` }
                                      : { ok: false, text: (res.body as { error?: string })?.error ?? "failed" }
                                    : { ok: false, text: res.error ?? `HTTP ${res.status}` },
                                }));
                              })
                            }
                          >
                            {busy === `test:${a.id}` ? "…" : t("settings.allinGw.test")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(`a:${a.id}`, () => request("DELETE", `/admin/accounts/${a.id}`))
                            }
                          >
                            {t("settings.allinGw.delete")}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {testResults && accts.some((a) => testResults[a.id]) ? (
                    <div className="space-y-1 pt-1">
                      {accts
                        .filter((a) => testResults[a.id])
                        .map((a) => (
                          <div
                            key={`tr-${a.id}`}
                            className={
                              testResults[a.id]?.ok
                                ? "text-ui-sm text-emerald-500"
                                : "text-ui-sm text-destructive"
                            }
                          >
                            {a.label ?? a.id}: {testResults[a.id]?.text}
                          </div>
                        ))}
                    </div>
                  ) : null}
                  {accts.length === 0 && keys.length === 0 ? (
                    <div className="text-ui-sm text-foreground-subtle">
                      {t("settings.allinGw.noAccounts")}
                    </div>
                  ) : null}
                  {keys.length ? (
                    <div className="mt-1 text-ui-sm text-foreground-subtle">
                      {t("settings.allinGw.keysCount", { count: keys.length })}:{" "}
                      <span className="font-mono">{keys.join(", ")}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </SettingsGroupCard>

      <div className="text-ui-base font-medium text-foreground">
        {t("settings.allinGw.proxies")}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.allinGw.importProxies")}
          description={t("settings.allinGw.importProxiesDesc")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !proxyImportText.trim()}
              onClick={() =>
                void act("importProxies", async () => {
                  const res = await request("POST", "/admin/proxies", { lines: proxyImportText });
                  if (res.ok) {
                    setProxyImportText("");
                    const b = res.body as { added?: unknown[]; skipped?: string[] };
                    if (b?.skipped?.length) {
                      setActionNotice(t("settings.allinGw.proxiesSkipped", { count: b.skipped.length }));
                    }
                  } else {
                    setActionNotice(res.error ?? `HTTP ${res.status}`);
                  }
                })
              }
            >
              {busy === "importProxies" ? "…" : t("settings.allinGw.import")}
            </Button>
          }
          detail={
            <textarea
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-ui-sm text-foreground placeholder:text-foreground-faint"
              rows={3}
              placeholder="socks5://user:pass@host:1080&#10;http://host:8080"
              value={proxyImportText}
              onChange={(e) => setProxyImportText(e.target.value)}
            />
          }
        />
        <SettingsRow
          label={t("settings.allinGw.assignAll")}
          description={t("settings.allinGw.assignAllDesc")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || (state?.proxies.length ?? 0) === 0}
              onClick={() => void act("assign", () => request("POST", "/admin/proxies/assign", {}))}
            >
              {busy === "assign" ? "…" : t("settings.allinGw.assign")}
            </Button>
          }
        />
        {(state?.proxies ?? []).map((proxy) => (
          <div key={proxy.id} className="border-t border-border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-ui-sm text-foreground">{proxy.url}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`ptest:${proxy.id}`, async () => {
                      const res = await request("POST", `/admin/proxies/${proxy.id}/test`);
                      setTestResults((prev) => ({
                        ...prev,
                        [`proxy-${proxy.id}`]: res.ok
                          ? (res.body as { ok?: boolean; error?: string; ms?: number })?.ok === true
                            ? { ok: true, text: `${(res.body as { ms?: number })?.ms ?? "?"}ms` }
                            : { ok: false, text: (res.body as { error?: string })?.error ?? "failed" }
                          : { ok: false, text: res.error ?? `HTTP ${res.status}` },
                      }));
                    })
                  }
                >
                  {busy === `ptest:${proxy.id}` ? "…" : t("settings.allinGw.test")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`px:${proxy.id}`, () => request("DELETE", `/admin/proxies/${proxy.id}`))
                  }
                >
                  {t("settings.allinGw.delete")}
                </Button>
              </div>
            </div>
            {testResults[`proxy-${proxy.id}`] ? (
              <div
                className={
                  testResults[`proxy-${proxy.id}`]?.ok
                    ? "mt-1 text-ui-sm text-emerald-500"
                    : "mt-1 text-ui-sm text-destructive"
                }
              >
                {testResults[`proxy-${proxy.id}`]?.text}
              </div>
            ) : null}
          </div>
        ))}
        {(state?.proxies ?? []).length === 0 ? (
          <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
            {t("settings.allinGw.noProxies")}
          </div>
        ) : null}
      </SettingsGroupCard>

      <div className="text-ui-base font-medium text-foreground">
        {t("settings.allinGw.groups")}
      </div>
      <SettingsGroupCard>
        {Object.entries(state?.groups ?? {}).map(([gid, g]) => (
          <div key={gid} className="border-t border-border px-4 py-3 first:border-t-0">
            <div className="text-ui-base text-foreground">
              {gid}
              {g.display ? (
                <span className="ml-2 text-ui-sm text-foreground-subtle">{g.display}</span>
              ) : null}
            </div>
            <div className="mt-0.5 text-ui-sm text-foreground-subtle">
              {t("settings.allinGw.groupTargets")}: {(g.targets ?? []).join(" → ")}
            </div>
          </div>
        ))}
      </SettingsGroupCard>

      <div className="mt-2 text-ui-sm text-foreground-subtle">
        {t("settings.allinGw.modelsHint")}
      </div>
    </div>
  );
}
