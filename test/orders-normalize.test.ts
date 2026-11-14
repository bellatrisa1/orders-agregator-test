import { describe, expect, it } from "vitest";
import { OrdersService } from "../src/services/orders.js";
import { OrdersRepository } from "../src/repositories/orders.js";
import { createDb } from "../src/db.js";

// Нормализация не обращается к пулу: подключение к БД не устанавливается.
const service = new OrdersService(new OrdersRepository(createDb("postgres://unused")));
const order = {
  id: "o",
  customerId: "c",
  amount: 100,
  status: "paid",
  createdAt: "2026-02-10T12:00:00Z",
  updatedAt: "2026-02-10T12:00:00Z",
};

describe("нормализация скидок", () => {
  it("старый формат и нулевая скидка сохраняют gross", () => {
    expect(service.normalize(order).amountPaidKop).toBe(10000);
    expect(service.normalize({ ...order, discountPercent: 0 }).amountPaidKop).toBe(10000);
  });
  it("amountPaid имеет приоритет, включая ноль", () => {
    expect(
      service.normalize({ ...order, discountPercent: 10, amountPaid: "85.29" }).amountPaidKop,
    ).toBe(8529);
    expect(service.normalize({ ...order, amountPaid: 0 }).amountPaidKop).toBe(0);
  });
  it("только процент: округляет net до копейки, половина вверх", () => {
    expect(service.normalize({ ...order, discountPercent: 16.5 }).amountPaidKop).toBe(8350);
    expect(service.normalize({ ...order, discountPercent: "16.5" }).amountPaidKop).toBe(8350);
    expect(
      service.normalize({ ...order, amount: 3312, discountPercent: "33", amountPaid: 2219.04 })
        .amountPaidKop,
    ).toBe(221904);
    expect(service.normalize({ ...order, amount: 0.29, discountPercent: 50 }).amountPaidKop).toBe(
      15,
    );
    expect(service.normalize({ ...order, discountPercent: 100 }).amountPaidKop).toBe(0);
    expect(service.normalize({ ...order, discountPercent: 1e-7 }).amountPaidKop).toBe(10000);
  });
  it("не скрывает невалидные поля даже при наличии второго поля", () => {
    for (const extra of [
      { amountPaid: null },
      { amountPaid: "" },
      { amountPaid: -1 },
      { amountPaid: 101 },
      { discountPercent: null },
      { discountPercent: "abc" },
      { discountPercent: "" },
      { discountPercent: " " },
      { discountPercent: 101 },
      { discountPercent: -1 },
      { discountPercent: NaN },
      { discountPercent: Infinity },
      { amountPaid: 90, discountPercent: -1 },
      { amountPaid: 1e20 },
    ])
      expect(() => service.normalize({ ...order, ...extra })).toThrow();
  });
});
