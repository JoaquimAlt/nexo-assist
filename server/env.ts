/** Carrega o .env, se existir. As chaves ficam só no servidor. */
try {
  process.loadEnvFile();
} catch {
  // sem .env: valem as variáveis do ambiente
}

const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback);

/** Modelo no formato provedor/modelo. `off` desliga o modelo e deixa só as regras. */
/** Um ou mais modelos separados por vírgula: se o primeiro falhar (ex.: sobrecarga), tenta o seguinte. */
const models = (process.env.NEXO_MODEL?.trim() || 'google/gemini-3.8-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const model = models[0];
const provider = model.split('/')[0];

/** Redis da Upstash: a integração da Vercel cria KV_REST_API_*; a Upstash direta, UPSTASH_REDIS_REST_*. */
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const env = {
  redis: redisUrl && redisToken ? { url: redisUrl, token: redisToken } : undefined,
  onVercel: !!process.env.VERCEL,
  /**
   * Modelo local é lento em CPU: só é chamado quando as regras não entendem com segurança.
   * Na nuvem, toda mensagem de texto passa pelo modelo.
   */
  modelOnlyWhenRulesUnsure: provider === 'ollama',
  port: num(process.env.PORT, 8787),
  // Na Vercel sem Redis, só /tmp é gravável (e ele some): serve para testar, não para usar.
  dbFile: process.env.NEXO_DB_FILE ?? (process.env.VERCEL ? '/tmp/nexo-db.json' : 'server/data/db.json'),
  model,
  models,
  provider,
  /** Endereço do Ollama (API compatível com OpenAI). */
  ollamaUrl: (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
  /** Por que o modelo não pode ser usado; vazio quando pode. */
  modelUnavailable:
    model === 'off'
      ? 'Modelo desligado (NEXO_MODEL=off)'
      : provider === 'google' && !(process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY)
        ? 'Modelo não configurado (sem GOOGLE_API_KEY)'
        : '',
  /** Modelo local em CPU pode levar alguns segundos. */
  llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, provider === 'ollama' ? 45_000 : 8000),
  /** Teto de chamadas ao modelo por dia, para conter custo e abuso. */
  llmDailyLimit: num(process.env.LLM_DAILY_LIMIT, 500),
  /** Chance de falha do sistema de chamados simulado (0–1). */
  legacyFailureRate: num(process.env.LEGACY_FAILURE_RATE, 0.08),
};
