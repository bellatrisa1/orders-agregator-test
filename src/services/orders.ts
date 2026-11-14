import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { Order, OrdersRepository } from "../repositories/orders.js";
import { discountedKop, parseRub, toKop } from "../utils/money.js";
import { parseUtc } from "../utils/time.js";

/** Заказ в формате внешнего API (поля, которые нам нужны; остальные игнорируем). */
const ExternalOrder = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.union([z.number(), z.string()]),
  discountPercent: z
    .union([
      z.number(),
      z
        .string()
        .trim()
        .regex(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)
        .transform(Number),
    ])
    .pipe(z.number().finite().min(0).max(100))
    .optional(),
  amountPaid: z.union([z.number(), z.string()]).optional(),
  status: z.enum(["pending", "paid", "refunded"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApplyResult = "created" | "updated" | "stale";

export class OrdersService {
  constructor(private readonly orders: OrdersRepository) {}

  normalize(raw: unknown): Order {
    const parsed = ExternalOrder.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        `invalid order: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
    const o = parsed.data;
    try {
      const amountKop = toKop(parseRub(o.amount));
      const amountPaidKop =
        o.amountPaid !== undefined
          ? toKop(parseRub(o.amountPaid))
          : discountedKop(amountKop, o.discountPercent ?? 0);
      if (amountPaidKop > amountKop) throw new Error("amountPaid exceeds amount");
      return {
        id: o.id,
        customerId: o.customerId,
        amountKop,
        amountPaidKop,
        status: o.status,
        createdAt: parseUtc(o.createdAt),
        updatedAt: parseUtc(o.updatedAt),
      };
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  }

  /**
   * Применяет версию заказа (из синка или вебхука).
   * Вебхуки приходят с повторами и не по порядку, поэтому версию сохраняем,
   * только если она новее уже сохранённой (по updatedAt).
   */
  async apply(raw: unknown): Promise<ApplyResult> {
    const incoming = this.normalize(raw);
    const current = await this.orders.get(incoming.id);
    if (current && current.updatedAt.getTime() >= incoming.updatedAt.getTime()) return "stale";
    await this.orders.save(incoming);
    return current ? "updated" : "created";
  }
}
