import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createDb } from "../src/db.js";

it("миграция сохраняет суммы старых заказов и ограничивает новую колонку", async () => {
  const db = createDb(
    process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/orders_test",
  );
  try {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA discount_migration_test");
      await client.query("SET LOCAL search_path TO discount_migration_test");
      await client.query(
        await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8"),
      );
      await client.query(`INSERT INTO orders VALUES ('legacy', 'c', 115, 'paid', now(), now())`);
      await client.query(
        await readFile(new URL("../migrations/002_amount_paid.sql", import.meta.url), "utf8"),
      );
      expect((await client.query("SELECT amount_kop, amount_paid_kop FROM orders")).rows).toEqual([
        { amount_kop: "115", amount_paid_kop: "115" },
      ]);
      await expect(client.query("UPDATE orders SET amount_paid_kop = 116")).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  } finally {
    await db.end();
  }
});
