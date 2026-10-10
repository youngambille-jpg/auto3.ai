/** Exact decimal <-> integer-unit conversion, avoiding float rounding. */

export function decimalToRaw(amount: number | string, decimals: number): string {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") {
    throw new Error(`Not a decimal amount: ${s}`);
  }
  const [whole = "0", frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined === "" ? "0" : combined).toString();
}

export function rawToDecimal(raw: string | bigint, decimals: number): string {
  const v = BigInt(raw).toString();
  const neg = v.startsWith("-");
  const digits = (neg ? v.slice(1) : v).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Split a total into `n` roughly equal parts, in exact units. */
export function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const each = total / n;
  return Array.from({ length: n }, () => each);
}
