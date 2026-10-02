import { PrismaClient } from "@prisma/client";

// A single PrismaClient per process. Next.js dev reloads modules on every edit,
// and without the global cache each reload would open a new connection pool and
// eventually exhaust the database's connection limit.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
