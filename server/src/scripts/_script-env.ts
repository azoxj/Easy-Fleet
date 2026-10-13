/**
 * Imported FIRST by one-off scripts (migrate, bootstrap, seeds): lifts the per-statement timeout the web
 * process uses, so a long migration is never cut short. ES modules evaluate in import order, so this runs
 * before the database client reads its configuration.
 */
process.env.DB_STATEMENT_TIMEOUT_MS ??= "0";
process.env.DB_IDLE_IN_TX_TIMEOUT_MS ??= "0";
process.env.DB_CONNECTION_TIMEOUT_MS ??= "30000";
