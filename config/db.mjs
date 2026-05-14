import pkg from "pg";
import { logger } from "../logger.mjs";

const { Pool } = pkg;

let pool;

export function getDbPool() {
  if (!pool) {
    logger.info("DB Pool", { step: "Creating", message: "🚀 Creating PostgreSQL Pool" });

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },

      max: 1,
      min: 0,
      idleTimeoutMillis:       10000,
      connectionTimeoutMillis: 15000,
      allowExitOnIdle:         true,
    });

    pool.on("connect", () => {
      logger.info("DB Pool", { step: "Connected", message: "✅ PostgreSQL Connected" });
    });

    pool.on("error", (err) => {
      logger.error("DB Pool", { step: "Error" }, err);
    });
  }

  return pool;
}
