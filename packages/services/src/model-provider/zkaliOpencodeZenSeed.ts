/**
 * zkali OpenCodeZen 免费号池 → Provider 自动注册。
 *
 * 号池网关（zkali-plugin scripts/zkali-opencodezen-pool.mjs）是唯一状态所有者，
 * 它在 ~/.zcode/zkali-opencodezen-pool.state.json 写入 {port, adminKey}。
 * Host bootstrap 在 providerRuntime.start() 后调用本模块，把网关幂等 seed 成
 * personal Provider「OpenCodeZen 免费号池」（openai-chat-completions），
 * 使桌面/CLI 的模型选择器默认可用。
 *
 * 幂等锚点（按优先级取第一条命中的 rule）：
 *   1. providerName === PROVIDER_NAME
 *   2. access.apiKey === 号池 adminKey（zkali-pool-* 仅本网关签发，最强指纹）
 *   3. api.baseUrl === 号池精确地址（不做任意 loopback 匹配——旧版的
 *      ^http://127\.0\.0\.1:\d+/v1 正则会误收用户其他本地 Provider 并覆写其
 *      baseUrl/key，属于真实事故的根因，禁止回归）
 *
 * 池绑定 rule 被本 seed 全权托管：名称统一为 PROVIDER_NAME、成员名单收敛为
 * 当前免费档目录（付费模型网关会 402 拒付，不进选择器）。其余 apiKey/baseUrl
 * 命中号池的 rule 仅刷新凭据，不改名，避免与用户自有 Provider 命名冲突。
 *
 * adminKey 仅用于 Provider apiKey 字段（本机回环端点鉴权），不进日志。
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

const PROVIDER_NAME = "OpenCodeZen 免费号池";
const POOL_CONFIG_FILE = "zkali-opencodezen-pool.json";
const POOL_STATE_FILE = "zkali-opencodezen-pool.state.json";
const MODELS_FETCH_TIMEOUT_MS = 5_000;
const SEED_RETRY_INTERVAL_MS = 15_000;
const SEED_MAX_ATTEMPTS = 8;
const WATCH_DEBOUNCE_MS = 800;
/** 与网关内置回退目录保持一致（全部为免费档模型）。 */
const FALLBACK_MODEL_IDS: readonly { id: string; contextWindow: number; maxOutput: number }[] = [
  { id: "big-pickle", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "beam-free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "flint-40b-free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "mimo-v2.6-flash-free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "nemotron-3.5-super-vl-free", contextWindow: 262_144, maxOutput: 32_000 },
  { id: "nemotron-3.5-lightning-free", contextWindow: 262_144, maxOutput: 32_000 },
  { id: "deepseek-v4.1-flash-free", contextWindow: 160_000, maxOutput: 32_000 },
  { id: "glm-5.3-flash-free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "pulse-alpha-free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "crouton-alpha-free", contextWindow: 200_000, maxOutput: 32_000 },
];

interface PoolStateFile {
  pid?: number;
  port?: number;
  adminKey?: string;
  version?: string;
  stoppedAt?: string;
}

interface PoolConfigFile {
  enabled?: boolean;
  port?: number;
}

interface PoolModelInfo {
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

type SeedConfigService = NodeProviderConfigRuntime["configService"];

interface SeedLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ZkaliOpencodeZenSeedResult {
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
 * 拉取池模型目录并只保留免费档（zkali_free === true）。
 * 付费模型经网关会返回 402（未配 zenApiKey），注册进选择器只会制造坏项。
 */
async function fetchPoolModelIds(port: number, adminKey: string): Promise<readonly PoolModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${adminKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return FALLBACK_MODEL_IDS;
    const body = (await res.json()) as {
      data?: Array<{ id?: string; context_window?: number; max_output_tokens?: number; zkali_free?: boolean }>;
    };
    const models = (body.data ?? [])
      .filter(
        (m): m is { id: string; context_window?: number; max_output_tokens?: number; zkali_free?: boolean } =>
          typeof m?.id === "string" && m.id.length > 0 && m.zkali_free === true,
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

/** 池绑定判定：名称、adminKey 指纹、或网关精确地址命中其一即归本 seed 管理。 */
function isPoolBoundRule(rule: SeedRuleLike, baseUrl: string, adminKey: string): boolean {
  if (rule.providerName === PROVIDER_NAME) return true;
  const access = rule.config.access;
  if (access?.type === "api-key" && typeof access.apiKey === "string" && access.apiKey === adminKey) {
    return true;
  }
  return rule.config.api?.baseUrl === baseUrl;
}

async function seedOnce(options: {
  configService: SeedConfigService;
  logger: SeedLogger;
  homeDir: string;
}): Promise<ZkaliOpencodeZenSeedResult> {
  const { configService, logger, homeDir } = options;
  const configDir = join(homeDir, ".zcode");

  const poolConfig = await readJsonFile<PoolConfigFile>(join(configDir, POOL_CONFIG_FILE));
  if (poolConfig?.enabled === false) {
    return { seeded: false, reason: "pool-disabled" };
  }
  const state = await readJsonFile<PoolStateFile>(join(configDir, POOL_STATE_FILE));
  if (!state || state.stoppedAt || typeof state.port !== "number" || !state.adminKey) {
    return { seeded: false, reason: "pool-not-running" };
  }
  const poolPort = state.port;
  const adminKey = state.adminKey;
  const baseUrl = `http://127.0.0.1:${poolPort}/v1`;
  const models = await fetchPoolModelIds(poolPort, adminKey);
  const modelIds = models.map((m) => m.id as ModelId);
  const modelInfoById = new Map(models.map((m) => [m.id, m]));
  const desiredIds = new Set(modelIds);

  const snapshot = await configService.read();
  const rules = snapshot.personalProviders.rules() as readonly SeedRuleLike[];
  // 主 Provider：名称命中优先，其次 adminKey/baseUrl 池绑定。
  const named = rules.find((r) => r.providerName === PROVIDER_NAME);
  const poolBound = rules.filter((r) => isPoolBoundRule(r, baseUrl, adminKey));
  const primary = named ?? poolBound[0];

  if (!primary) {
    const creation = await configService.createPersonalProvider({
      providerName: PROVIDER_NAME,
      initialConfig: new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: adminKey }),
        api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
        personalModelIds: modelIds,
        modelOrder: modelIds,
      }),
    });
    logger.info("OpenCodeZen 号池 Provider 已注册", {
      providerId: creation.providerId,
      modelCount: modelIds.length,
    });
    return { seeded: true, providerId: creation.providerId, modelCount: modelIds.length };
  }

  // 主 Provider：统一名称 + 刷新凭据/地址（覆盖旧版误收并改名回来的场景）。
  await configService.savePersonalProviderOverlay(
    primary.providerId as ProviderId,
    new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: adminKey }),
      api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
    }),
    undefined,
    { providerName: PROVIDER_NAME, enabled: true },
  );

  // 其余池绑定 rule（同名/异名）：仅刷新凭据，不动名称与成员。
  for (const extra of poolBound) {
    if (extra.providerId === primary.providerId) continue;
    try {
      await configService.savePersonalProviderOverlay(
        extra.providerId as ProviderId,
        new ProviderConfig({
          access: new ApiKeyAccessConfig({ apiKey: adminKey }),
          api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
        }),
      );
    } catch (error) {
      logger.warn("OpenCodeZen 号池副绑定刷新失败", { providerId: extra.providerId, error: String(error) });
    }
  }

  // 成员名单收敛到当前免费目录：缺则补、失效/外来则删（池 Provider 全托管）。
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
      logger.warn("OpenCodeZen 号池模型补齐失败", { modelId: id, error: String(error) });
    }
  }
  let removed = 0;
  for (const id of currentIds) {
    if (desiredIds.has(id as ModelId)) continue;
    try {
      await configService.deletePersonalModel(primary.providerId as ProviderId, id as ModelId);
      removed += 1;
    } catch (error) {
      logger.warn("OpenCodeZen 号池模型清理失败", { modelId: id, error: String(error) });
    }
  }
  logger.info("OpenCodeZen 号池 Provider 已刷新", {
    providerId: primary.providerId,
    modelCount: modelIds.length,
    added,
    removed,
  });
  return { seeded: true, providerId: primary.providerId, modelCount: modelIds.length };
}

export async function seedZkaliOpencodeZenProvider(options: {
  configService: SeedConfigService;
  logger: SeedLogger;
  env?: NodeJS.ProcessEnv;
  /** 号池可能由 desktop main / CLI hook 晚于 providerRuntime 拉起，未运行时按间隔重试。 */
  maxAttempts?: number;
  retryIntervalMs?: number;
}): Promise<ZkaliOpencodeZenSeedResult> {
  const homeDir = resolveAgentUserInstructionsHomeDir(options.env ?? process.env);
  const maxAttempts = Math.max(1, options.maxAttempts ?? SEED_MAX_ATTEMPTS);
  const interval = Math.max(1_000, options.retryIntervalMs ?? SEED_RETRY_INTERVAL_MS);
  let last: ZkaliOpencodeZenSeedResult = { seeded: false, reason: "not-attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await seedOnce({ configService: options.configService, logger: options.logger, homeDir });
    // pool-disabled 是用户显式开关，不重试；其余失败可重试等待网关写 state。
    if (last.seeded || last.reason === "pool-disabled") return last;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  return last;
}

/**
 * 监听号池配置/状态文件：设置页切换 enabled 或网关随后拉起时重新 seed。
 * 返回 disposer；目录不存在时静默不挂 watch。
 */
export function watchZkaliOpencodeZenPool(options: {
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
        if (name !== POOL_CONFIG_FILE && name !== POOL_STATE_FILE) continue;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          void seedZkaliOpencodeZenProvider({
            configService: options.configService,
            logger: options.logger,
            maxAttempts: 2,
            retryIntervalMs: 5_000,
          }).catch((error: unknown) => {
            options.logger.warn("OpenCodeZen 号池监听 seed 失败", { error: String(error) });
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
