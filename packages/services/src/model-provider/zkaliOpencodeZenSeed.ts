/**
 * zkali OpenCodeZen 免费号池 → Provider 自动注册。
 *
 * 号池网关（zkali-plugin scripts/zkali-opencodezen-pool.mjs）是唯一状态所有者，
 * 它在 ~/.zcode/zkali-opencodezen-pool.state.json 写入 {port, adminKey}。
 * Host bootstrap 在 providerRuntime.start() 后调用本模块，把网关幂等 seed 成
 * personal Provider「OpenCodeZen 免费号池」（openai-chat-completions），
 * 使桌面/CLI 的模型选择器默认可用。种子幂等键：providerName 或 api.baseUrl 完全相等。
 *
 * adminKey 仅用于 Provider apiKey 字段（本机回环端点鉴权），不进日志。
 */
import { readFile } from "node:fs/promises";
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
/** 与网关内置回退目录保持一致。 */
const FALLBACK_MODEL_IDS: readonly { id: string; contextWindow: number }[] = [
  { id: "big-pickle", contextWindow: 200_000 },
  { id: "gpt-5-nano", contextWindow: 400_000 },
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

async function fetchPoolModelIds(
  port: number,
  adminKey: string,
): Promise<readonly { id: string; contextWindow?: number }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${adminKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return FALLBACK_MODEL_IDS;
    const body = (await res.json()) as { data?: Array<{ id?: string; context_window?: number }> };
    const models = (body.data ?? [])
      .filter((m): m is { id: string; context_window?: number } => typeof m?.id === "string" && m.id.length > 0)
      .map((m) => ({ id: m.id, ...(m.context_window ? { contextWindow: m.context_window } : {}) }));
    return models.length > 0 ? models : FALLBACK_MODEL_IDS;
  } catch {
    return FALLBACK_MODEL_IDS;
  } finally {
    clearTimeout(timer);
  }
}

/** 判断 rule 是否为本种子管理的 Provider（名称或网关 baseUrl 前缀匹配）。 */
function isSeedProvider(
  providerName: string | null | undefined,
  apiBaseUrl: string | null | undefined,
): boolean {
  if (providerName === PROVIDER_NAME) return true;
  // 用户可能改过名；网关地址是更稳定的身份锚点（号池固定回环 + /v1）。
  return typeof apiBaseUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+\/v1\/?$/.test(apiBaseUrl);
}

export async function seedZkaliOpencodeZenProvider(options: {
  configService: NodeProviderConfigRuntime["configService"];
  logger: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
  env?: NodeJS.ProcessEnv;
}): Promise<ZkaliOpencodeZenSeedResult> {
  const { configService, logger } = options;
  const homeDir = resolveAgentUserInstructionsHomeDir(options.env ?? process.env);
  const configDir = join(homeDir, ".zcode");

  const poolConfig = await readJsonFile<PoolConfigFile>(join(configDir, POOL_CONFIG_FILE));
  if (poolConfig?.enabled === false) {
    return { seeded: false, reason: "pool-disabled" };
  }
  const state = await readJsonFile<PoolStateFile>(join(configDir, POOL_STATE_FILE));
  if (!state || state.stoppedAt || typeof state.port !== "number" || !state.adminKey) {
    return { seeded: false, reason: "pool-not-running" };
  }
  const baseUrl = `http://127.0.0.1:${state.port}/v1`;
  const models = await fetchPoolModelIds(state.port, state.adminKey);
  const modelIds = models.map((m) => m.id as ModelId);
  const contextWindowById = new Map(models.map((m) => [m.id, m.contextWindow]));

  const snapshot = await configService.read();
  const existing = snapshot.personalProviders
    .rules()
    .find((rule) => isSeedProvider(rule.providerName, rule.config.api?.baseUrl));

  if (!existing) {
    const creation = await configService.createPersonalProvider({
      providerName: PROVIDER_NAME,
      initialConfig: new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: state.adminKey }),
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

  // 已存在：仅刷新 api/access（端口/adminKey 可能轮换），成员名单增量补齐。
  await configService.savePersonalProviderOverlay(
    existing.providerId,
    new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: state.adminKey }),
      api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
    }),
    undefined,
    { enabled: true },
  );
  const current = await configService.read();
  const currentConfig = current.personalProviders.get(existing.providerId);
  const currentIds = new Set(currentConfig?.personalModelIds ?? []);
  for (const id of modelIds) {
    if (currentIds.has(id)) continue;
    const contextWindow = contextWindowById.get(id);
    try {
      await configService.addPersonalModel(
        existing.providerId as ProviderId,
        id,
        new ModelConfig({
          enabled: true,
          properties: new ModelPropertiesConfig(
            contextWindow ? { contextWindow } : {},
          ),
        }),
      );
    } catch (error) {
      logger.warn("OpenCodeZen 号池模型补齐失败", { modelId: id, error: String(error) });
    }
  }
  logger.info("OpenCodeZen 号池 Provider 已刷新", {
    providerId: existing.providerId,
    modelCount: modelIds.length,
  });
  return { seeded: true, providerId: existing.providerId, modelCount: modelIds.length };
}
