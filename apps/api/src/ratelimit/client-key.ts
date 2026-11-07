import { isIPv4, isIPv6 } from "node:net";

/** The eight groups of an IPv6 address, each four hex digits, or null if it is not one. */
function groups(address: string): string[] | null {
  let a = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const p = (v4[1] as string).split(".").map(Number) as [number, number, number, number];
    a = `${a.slice(0, -(v4[1] as string).length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head = "", tail, ...more] = a.split("::");
  if (more.length > 0) return null;
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? h.length !== 8 : missing < 0) return null;
  return [...h, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...t].map((g) => g.padStart(4, "0"));
}

/**
 * What a caller is counted as: its IPv4 address, or the /64 of its IPv6 address (a person or network usually holds a whole /64,
 * so counting single addresses would let them rotate through billions). An address that cannot be read is one shared key, so
 * such callers are limited together instead of not at all.
 */
export function clientKey(ip: string | undefined): string {
  if (ip === undefined || ip === "") return "unknown";
  const address = (ip.split("%")[0] as string).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped && isIPv4(mapped[1] as string)) return mapped[1] as string;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return "unknown";
  const g = groups(address);
  return g === null ? "unknown" : `v6:${g.slice(0, 4).join(":")}`;
}
