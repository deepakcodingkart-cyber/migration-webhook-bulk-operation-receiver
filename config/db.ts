import { PrismaClient } from "@prisma/client";
import { logger } from "../logger.ts";

// Singleton — reused across Lambda invocations.
let prisma: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    console.log("[db] creating Prisma client (DATABASE_URL:", process.env.DATABASE_URL ? "set" : "MISSING", ")");
    logger.info("Prisma Client", { step: "Creating", message: "🚀 Creating Prisma Client" });
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  } else {
    console.log("[db] reusing existing Prisma client");
  }

  return prisma;
}
