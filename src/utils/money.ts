/** Деньги внутри сервиса — целые безопасные копейки. */
export function parseRub(raw: unknown): number {
  if (typeof raw === "string" && !/^\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*$/i.test(raw)) {
    throw new Error("invalid amount");
  }
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("invalid amount");
  toKop(value);
  return value;
}

export function safeKop(kop: number): number {
  if (!Number.isSafeInteger(kop) || kop < 0) throw new Error("unsafe amount in kopecks");
  return kop;
}

/** Десятичное представление числа → копейки; доли копейки отбрасываются. */
export function toKop(rub: number): number {
  if (!Number.isFinite(rub) || rub < 0) throw new Error("invalid amount");
  const [mantissa, exponent = "0"] = rub.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + 2;
  const kop = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  if (kop > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unsafe amount in kopecks");
  return safeKop(Number(kop));
}

/** Процент применяется к целым копейкам; результат округляется до ближайшей копейки, половина вверх. */
export function discountedKop(gross: number, percent: number): number {
  safeKop(gross);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new Error("invalid discountPercent");
  const [mantissa, exponent = "0"] = percent.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction) * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
  const denominator = 100n * 10n ** BigInt(Math.max(0, scale));
  return safeKop(
    Number((BigInt(gross) * (denominator - numerator) + denominator / 2n) / denominator),
  );
}

export function fromKop(kop: number): number {
  return safeKop(kop) / 100;
}
