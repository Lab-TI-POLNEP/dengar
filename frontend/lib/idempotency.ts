/**
 * RFC4122 v4 UUID generator for client-side idempotency keys.
 * Compatible with secure contexts (crypto.randomUUID),
 * non-secure HTTP LAN environments (crypto.getRandomValues),
 * and fallback environments.
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC4122 version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC4122 variant
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  return `${s4()}${s4()}-${s4()}-4${s4().substring(1)}-8${s4().substring(1)}-${s4()}${s4()}${s4()}`;
}
