// Loads the config module with the current environment and prints the resolved values.
const { config } = await import("../../src/config.js");
console.log(`CONFIG_OK ${config.appOrigins.join(",")} ${config.STORAGE_DIR} ${config.publicAppUrl}`);
