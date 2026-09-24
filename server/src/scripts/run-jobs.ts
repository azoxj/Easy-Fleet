import { pool } from "../db/client.js";
import { runAllJobs } from "../services/jobs.js";

const result = await runAllJobs();
console.log("[jobs]", JSON.stringify(result));
await pool.end();
