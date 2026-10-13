// Prints the resolved AWS-relevant configuration as JSON (no secret values are ever printed).
const { config } = await import("../../src/config.js");
console.log(
  "CFG " +
    JSON.stringify({
      trustProxy: config.TRUST_PROXY,
      logFormat: config.LOG_FORMAT,
      logRequests: config.LOG_REQUESTS,
      storage: config.STORAGE_PROVIDER,
      bucket: config.S3_BUCKET ?? null,
      pool: [config.DB_POOL_MAX, config.DB_CONNECTION_TIMEOUT_MS, config.DB_STATEMENT_TIMEOUT_MS, config.DB_IDLE_IN_TX_TIMEOUT_MS],
      hasDatabaseUrl: !!config.DATABASE_URL,
      hasSmtpPassword: !!config.SMTP_PASSWORD,
      hasKey: !!config.EMAIL_SETTINGS_KEY,
      hasBwSecret: !!config.BRIGHT_WASHING_API_SECRET,
      dbUrlLength: config.DATABASE_URL.length,
    }),
);
