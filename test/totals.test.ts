import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
      { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 },
    ]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800 },
    ]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});

it("скидки из sync и вебхуков, нулевая оплата, повторы и старые версии", async () => {
  const order = apiOrder({ amount: 2500, discountPercent: 16.5, amountPaid: 2087.5 });
  ctx.api.pages.set(null, { items: [order], nextCursor: null });
  expect((await ctx.app.inject({ method: "POST", url: "/sync" })).statusCode).toBe(200);
  await postWebhook(ctx.app, apiOrder({ amount: 0.29, amountPaid: 0 }));
  expect((await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json()).toEqual([
    { date: "2026-02-10", total: 2500.29, gross: 2500.29, discount: 412.79, net: 2087.5 },
  ]);
  const update = { ...order, amountPaid: 2000, updatedAt: "2026-02-11T00:00:00Z" };
  expect((await postWebhook(ctx.app, update)).json()).toEqual({ result: "updated" });
  expect((await postWebhook(ctx.app, update)).json()).toEqual({ result: "stale" });
  expect((await postWebhook(ctx.app, order)).json()).toEqual({ result: "stale" });
  expect((await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json()).toEqual([
    { date: "2026-02-10", total: 2500.29, gross: 2500.29, discount: 500.29, net: 2000 },
  ]);
});

it("HTTP-статистика учитывает DST в зоне клиента и границы диапазона", async () => {
  ctx.api.customers.set("dst_customer", "Europe/Berlin");
  for (const createdAt of [
    "2026-03-26T22:59:59Z",
    "2026-03-26T23:00:00Z",
    "2026-03-29T22:30:00Z",
    "2026-03-31T21:59:59Z",
    "2026-03-31T22:00:00Z",
  ]) {
    expect(
      (
        await postWebhook(
          ctx.app,
          apiOrder({
            customerId: "dst_customer",
            createdAt,
            amount: 1.15,
            discountPercent: 20,
          }),
        )
      ).statusCode,
    ).toBe(200);
  }
  const response = await dailyTotals(ctx.app, "dst_customer", "2026-03-27", "2026-03-31");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(
    [27, 28, 29, 30, 31].map((day) => ({
      date: `2026-03-${day}`,
      total: [27, 30, 31].includes(day) ? 1.15 : 0,
      gross: [27, 30, 31].includes(day) ? 1.15 : 0,
      net: [27, 30, 31].includes(day) ? 0.92 : 0,
      discount: [27, 30, 31].includes(day) ? 0.23 : 0,
    })),
  );
});
