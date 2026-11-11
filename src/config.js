import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  defaultTimezone: process.env.DEFAULT_TZ ?? "Asia/Kolkata",
  nowOverride: process.env.NOW_OVERRIDE,
  dbPath: process.env.DB_PATH ?? "./data/minimi.sqlite"
};

export function assertConfig() {
  const missing = [
    !config.openaiApiKey && "OPENAI_API_KEY",
    !config.tavilyApiKey && "TAVILY_API_KEY"
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}
