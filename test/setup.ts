import { execSync } from "node:child_process";
import { config } from "dotenv";

config();

const testDatabaseUrl = process.env.DATABASE_URL_TEST;

if (!testDatabaseUrl) {
  throw new Error("DATABASE_URL_TEST is required to run tests");
}

let databaseName: string;
try {
  databaseName = decodeURIComponent(
    new URL(testDatabaseUrl).pathname.replace(/^\//, ""),
  );
} catch {
  throw new Error("DATABASE_URL_TEST must be a valid PostgreSQL URL");
}

if (databaseName !== "casecellshop_test") {
  throw new Error(
    `Refusing to run tests against database "${databaseName}". Expected casecellshop_test.`,
  );
}

process.env.DATABASE_URL = testDatabaseUrl;

execSync("pnpm exec prisma migrate deploy", {
  stdio: "inherit",
  env: process.env,
});
