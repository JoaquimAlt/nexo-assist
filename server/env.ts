/** Carrega o .env, se existir. As chaves ficam só no servidor. */
try {
  process.loadEnvFile();
} catch {
  // sem .env: valem as variáveis do ambiente
}

const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback);

/** Modelo no formato provedor/modelo. `off` desliga o modelo e deixa só as regras. */
const model = process.env.NEXO_MODEL?.trim() || 'ollama/qwen2.5:3b';
const provider = model.split('/')[0];

export const env = {
  port: num(process.env.PORT, 8787),
  dbFile: process.env.NEXO_DB_FILE ?? 'server/data/db.json',
  model,
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
