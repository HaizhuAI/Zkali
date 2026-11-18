/**
 * zkali Allin 聚合网关 → Provider 自动注册。
 *
 * 网关（zkali-plugin scripts/zkali-allin-gw.mjs）是唯一状态所有者，
 * 它在 ~/.zcode/zkali-allin.state.json 写入 {port, authKey}。
 * Host bootstrap 在 providerRuntime.start() 后调用本模块，把网关幂等 seed 成
 * personal Provider「Allin 聚合网关」（openai-chat-completions），
 * 使桌面/CLI 的模型选择器默认可用。
 *
 * 幂等锚点（按优先级取第一条命中的 rule）：
 *   1. providerName === PROVIDER_NAME
 *   2. access.apiKey === 网关 authKey（仅本网关签发，最强指纹）
 *   3. api.baseUrl === 网关精确地址（不做任意 loopback 匹配——旧版号池
 *      seed 的 ^http://127\.0\.0\.1:\d+/v1 正则会误收用户其他本地 Provider
 *      并覆写其 baseUrl/key，属于真实事故的根因，禁止回归）
 *
 * 网关绑定 rule 被本 seed 全权托管：名称统一为 PROVIDER_NAME、成员名单收敛为
 * 当前网关目录（含 pid/model 组合与 fallback 分组）。其余 apiKey/baseUrl
 * 命中网关的 rule 仅刷新凭据，不改名，避免与用户自有 Provider 命名冲突。
 *
 * authKey 仅用于 Provider apiKey 字段（本机回环端点鉴权），不进日志。
 */
import { readFile, watch } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ModelId,
  type ProviderId,
} from "@zcode/provider";
import type { NodeProviderConfigRuntime } from "@zcode/provider-node";
import { resolveAgentUserInstructionsHomeDir } from "../paths.js";

const PROVIDER_NAME = "Allin 聚合网关";
const GW_CONFIG_FILE = "zkali-allin.json";
const GW_STATE_FILE = "zkali-allin.state.json";
const MODELS_FETCH_TIMEOUT_MS = 5_000;
const SEED_RETRY_INTERVAL_MS = 15_000;
const SEED_MAX_ATTEMPTS = 8;
const WATCH_DEBOUNCE_MS = 800;
/** 网关未就绪时的最小可用目录（fallback 分组 + 常用组合）。 */
const FALLBACK_MODEL_IDS: readonly { id: string; contextWindow: number; maxOutput: number }[] = [
  { id: "fallback", contextWindow: 200_000, maxOutput: 32_000 },
];

interface GwStateFile {
  pid?: number;
  port?: number;
  authKey?: string;
  version?: string;
  stoppedAt?: string;
}

interface GwConfigFile {
  enabled?: boolean;
  server?: { port?: number };
}

interface GwModelInfo {
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

type SeedConfigService = NodeProviderConfigRuntime["configService"];

interface SeedLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ZkaliAllinSeedResult {
  readonly seeded: boolean;
  readonly providerId?: string;
  readonly modelCount?: number;
  readonly reason?: string;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * 拉取网关模型目录（pid/model 组合 + fallback 分组）。
 * 网关 /v1/models 无需鉴权，但带上 authKey 与未来版本兼容。
 */
async function fetchGwModelIds(port: number, authKey: string): Promise<readonly GwModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${authKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return FALLBACK_MODEL_IDS;
    const body = (await res.json()) as {
      data?: Array<{ id?: string; context_window?: number; max_output_tokens?: number }>;
    };
    const models = (body.data ?? [])
      .filter((m): m is { id: string; context_window?: number; max_output_tokens?: number } =>
        typeof m?.id === "string" && m.id.length > 0,
      )
      .map((m) => ({
        id: m.id,
        ...(m.context_window ? { contextWindow: m.context_window } : {}),
        ...(m.max_output_tokens ? { maxOutput: m.max_output_tokens } : {}),
      }));
    return models.length > 0 ? models : FALLBACK_MODEL_IDS;
  } catch {
    return FALLBACK_MODEL_IDS;
  } finally {
    clearTimeout(timer);
  }
}

interface SeedRuleLike {
  providerId: string;
  providerName?: string | null;
  config: {
    access?: { type?: string; apiKey?: string } | undefined;
    api?: { baseUrl?: string } | undefined;
    personalModelIds?: readonly string[] | undefined;
  };
}

/** 网关绑定判定：名称、authKey 指纹、或网关精确地址命中其一即归本 seed 管理。 */
function isGwBoundRule(rule: SeedRuleLike, baseUrl: string, authKey: string): boolean {
  if (rule.providerName === PROVIDER_NAME) return true;
  const access = rule.config.access;
  if (access?.type === "api-key" && typeof access.apiKey === "string" && access.apiKey === authKey) {
    return true;
  }
  return rule.config.api?.baseUrl === baseUrl;
}

async function seedOnce(options: {
  configService: SeedConfigService;
  logger: SeedLogger;
  homeDir: string;
}): Promise<ZkaliAllinSeedResult> {
  const { configService, logger, homeDir } = options;
  const configDir = join(homeDir, ".zcode");

  const gwConfig = await readJsonFile<GwConfigFile>(join(configDir, GW_CONFIG_FILE));
  if (gwConfig?.enabled === false) {
    return { seeded: false, reason: "gw-disabled" };
  }
  const state = await readJsonFile<GwStateFile>(join(configDir, GW_STATE_FILE));
  if (!state || state.stoppedAt || typeof state.port !== "number" || !state.authKey) {
    return { seeded: false, reason: "gw-not-running" };
  }
  const gwPort = state.port;
  const authKey = state.authKey;
  const baseUrl = `http://127.0.0.1:${gwPort}/v1`;
  const models = await fetchGwModelIds(gwPort, authKey);
  const modelIds = models.map((m) => m.id as ModelId);
  const modelInfoById = new Map(models.map((m) => [m.id, m]));
  const desiredIds = new Set(modelIds);

  const snapshot = await configService.read();
  const rules = snapshot.personalProviders.rules() as readonly SeedRuleLike[];
  // 主 Provider：名称命中优先，其次 authKey/baseUrl 绑定。
  const named = rules.find((r) => r.providerName === PROVIDER_NAME);
  const gwBound = rules.filter((r) => isGwBoundRule(r, baseUrl, authKey));
  const primary = named ?? gwBound[0];

  if (!primary) {
    const creation = await configService.createPersonalProvider({
      providerName: PROVIDER_NAME,
      initialConfig: new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: authKey }),
        api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
        personalModelIds: modelIds,
        modelOrder: modelIds,
      }),
    });
    logger.info("Allin 网关 Provider 已注册", {
      providerId: creation.providerId,
      modelCount: modelIds.length,
    });
    return { seeded: true, providerId: creation.providerId, modelCount: modelIds.length };
  }

  // 主 Provider：统一名称 + 刷新凭据/地址（覆盖旧版误收并改名回来的场景）。
  await configService.savePersonalProviderOverlay(
    primary.providerId as ProviderId,
    new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: authKey }),
      api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
    }),
    undefined,
    { providerName: PROVIDER_NAME, enabled: true },
  );

  // 其余网关绑定 rule（同名/异名）：仅刷新凭据，不动名称与成员。
  for (const extra of gwBound) {
    if (extra.providerId === primary.providerId) continue;
    try {
      await configService.savePersonalProviderOverlay(
        extra.providerId as ProviderId,
        new ProviderConfig({
          access: new ApiKeyAccessConfig({ apiKey: authKey }),
          api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
        }),
      );
    } catch (error) {
      logger.warn("Allin 网关副绑定刷新失败", { providerId: extra.providerId, error: String(error) });
    }
  }

  // 成员名单收敛到当前网关目录：缺则补、失效/外来则删（Allin Provider 全托管）。
  const current = await configService.read();
  const currentConfig = current.personalProviders.get(primary.providerId as ProviderId);
  const currentIds = new Set(currentConfig?.personalModelIds ?? []);
  let added = 0;
  for (const id of modelIds) {
    if (currentIds.has(id)) continue;
    const info = modelInfoById.get(id);
    try {
      await configService.addPersonalModel(
        primary.providerId as ProviderId,
        id,
        new ModelConfig({
          enabled: true,
          properties: new ModelPropertiesConfig(
            info?.contextWindow ? { contextWindow: info.contextWindow, supportsToolCall: true } : { supportsToolCall: true },
          ),
        }),
      );
      added += 1;
    } catch (error) {
      logger.warn("Allin 网关模型补齐失败", { modelId: id, error: String(error) });
    }
  }
  let removed = 0;
  for (const id of currentIds) {
    if (desiredIds.has(id as ModelId)) continue;
    try {
      await configService.deletePersonalModel(primary.providerId as ProviderId, id as ModelId);
      removed += 1;
    } catch (error) {
      logger.warn("Allin 网关模型清理失败", { modelId: id, error: String(error) });
    }
  }
  logger.info("Allin 网关 Provider 已刷新", {
    providerId: primary.providerId,
    modelCount: modelIds.length,
    added,
    removed,
  });
  return { seeded: true, providerId: primary.providerId, modelCount: modelIds.length };
}

export async function seedZkaliAllinProvider(options: {
  configService: SeedConfigService;
  logger: SeedLogger;
  env?: NodeJS.ProcessEnv;
  /** 网关可能由 desktop main / CLI hook 晚于 providerRuntime 拉起，未运行时按间隔重试。 */
  maxAttempts?: number;
  retryIntervalMs?: number;
}): Promise<ZkaliAllinSeedResult> {
  const homeDir = resolveAgentUserInstructionsHomeDir(options.env ?? process.env);
  const maxAttempts = Math.max(1, options.maxAttempts ?? SEED_MAX_ATTEMPTS);
  const interval = Math.max(1_000, options.retryIntervalMs ?? SEED_RETRY_INTERVAL_MS);
  let last: ZkaliAllinSeedResult = { seeded: false, reason: "not-attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await seedOnce({ configService: options.configService, logger: options.logger, homeDir });
    // gw-disabled 是用户显式开关，不重试；其余失败可重试等待网关写 state。
    if (last.seeded || last.reason === "gw-disabled") return last;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  return last;
}

/**
 * 监听网关配置/状态文件：设置页切换 enabled 或网关随后拉起时重新 seed。
 * 返回 disposer；目录不存在时静默不挂 watch。
 */
export function watchZkaliAllinGw(options: {
  configService: SeedConfigService;
  logger: SeedLogger;
  env?: NodeJS.ProcessEnv;
}): () => void {
  const homeDir = resolveAgentUserInstructionsHomeDir(options.env ?? process.env);
  const configDir = join(homeDir, ".zcode");
  if (!existsSync(configDir)) return () => undefined;
  const ac = new AbortController();
  let pending: ReturnType<typeof setTimeout> | null = null;
  void (async () => {
    try {
      const watcher = watch(configDir, { signal: ac.signal });
      for await (const event of watcher) {
        const name = typeof event.filename === "string" ? event.filename : "";
        if (name !== GW_CONFIG_FILE && name !== GW_STATE_FILE) continue;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          void seedZkaliAllinProvider({
            configService: options.configService,
            logger: options.logger,
            maxAttempts: 2,
            retryIntervalMs: 5_000,
          }).catch((error: unknown) => {
            options.logger.warn("Allin 网关监听 seed 失败", { error: String(error) });
          });
        }, WATCH_DEBOUNCE_MS);
      }
    } catch {
      /* watch 中止或目录不可读：静默 */
    }
  })();
  return () => {
    if (pending) clearTimeout(pending);
    ac.abort();
  };
}
