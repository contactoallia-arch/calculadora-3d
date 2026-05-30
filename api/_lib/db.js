import { createClient } from "@libsql/client";
export function getDB() {
  return createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
}
