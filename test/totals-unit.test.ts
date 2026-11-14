import { describe, expect, it, vi } from "vitest";
import type { OrdersRepository, Order } from "../src/repositories/orders.js";
import type { CustomersService } from "../src/services/customers.js";
import { TotalsService } from "../src/services/totals.js";

function totals(times: string[], amountKop = 29) {
  const rows: Order[] = times.map((time, i) => ({
    id: String(i),
    customerId: "example",
    amountKop,
    amountPaidKop: amountKop,
    status: "paid",
    createdAt: new Date(time),
    updatedAt: new Date(time),
  }));
  const repo = { paidCreatedBetween: vi.fn(async () => rows) };
  const service = new TotalsService(
    repo as unknown as OrdersRepository,
    { timezone: async () => "Europe/Berlin" } as unknown as CustomersService,
  );
  return { service, repo, rows };
}

describe("локальные дни и целые суммы", () => {
  it("DST, границы 27–31 марта и независимость от даты запроса", async () => {
    const { service, repo } = totals([
      "2026-03-26T22:59:59.999Z", // вне диапазона
      "2026-03-26T23:00:00Z", // начало 27-го
      "2026-03-28T22:30:00Z", // 28-е до DST
      "2026-03-29T00:59:59Z", // перед сменой смещения
      "2026-03-29T01:00:00Z", // после смены смещения
      "2026-03-29T22:30:00Z", // уже 30-е
      "2026-03-31T21:59:59.999Z", // конец 31-го
      "2026-03-31T22:00:00Z", // вне диапазона
    ]);
    vi.useFakeTimers();
    try {
      const responses = [];
      for (const now of ["2026-01-01", "2026-07-01"]) {
        vi.setSystemTime(new Date(now));
        responses.push(await service.daily("example", "2026-03-27", "2026-03-31"));
      }
      expect(responses[0]).toEqual(responses[1]);
      expect(responses[0]).toEqual(
        [29, 29, 58, 29, 29].map((kop, i) => ({
          date: `2026-03-${27 + i}`,
          total: kop / 100,
          gross: kop / 100,
          net: kop / 100,
          discount: 0,
        })),
      );
      expect(repo.paidCreatedBetween).toHaveBeenCalledWith(
        "example",
        new Date("2026-03-26T00:00:00Z"),
        new Date("2026-04-02T00:00:00Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("суммирует скидки в копейках и возвращает нулевой день", async () => {
    const { service, rows } = totals(["2026-03-27T12:00:00Z", "2026-03-27T13:00:00Z"]);
    rows[0].amountPaidKop = 15;
    rows[1].amountPaidKop = 0;
    expect(await service.daily("example", "2026-03-27", "2026-03-28")).toEqual([
      { date: "2026-03-27", total: 0.58, gross: 0.58, net: 0.15, discount: 0.43 },
      { date: "2026-03-28", total: 0, gross: 0, net: 0, discount: 0 },
    ]);
  });
  it("отклоняет небезопасную дневную сумму", async () => {
    const { service } = totals(
      ["2026-03-27T12:00:00Z", "2026-03-27T13:00:00Z"],
      Number.MAX_SAFE_INTEGER,
    );
    await expect(service.daily("example", "2026-03-27", "2026-03-27")).rejects.toThrow();
  });
});
