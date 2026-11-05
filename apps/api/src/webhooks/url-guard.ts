import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { promises as dns } from "node:dns";

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

/** Resolves a host name to every address it points to. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address);

// Ranges a webhook must never reach: loopback, private networks, link-local (which includes cloud metadata at
// 169.254.169.254), carrier-grade NAT, documentation, multicast and reserved space, for IPv4 and IPv6.
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv6 is the other way round: only global unicast (2000::/3) can be public, which already excludes loopback,
// unspecified, link-local, unique-local, multicast, site-local, IPv4-mapped, IPv4-compatible and NAT64 addresses. Inside
// 2000::/3 these ranges are still not public: Teredo and 6to4 (both embed an IPv4 address), and documentation prefixes.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
for (const [net, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** True only for a well-formed public unicast address. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  return GLOBAL_V6.check(address, "ipv6") && !BLOCKED.check(address, "ipv6");
}

const MAX_URL_LENGTH = 500;

/**
 * Checks a webhook URL before it is stored: https only, no credentials, the standard port, a fully qualified host
 * name or a public address, and every address the name resolves to must be public.
 */
export async function assertWebhookUrl(raw: string, resolver: Resolver = systemResolver): Promise<void> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new WebhookUrlError("the URL must be 1 to 500 characters");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("the URL is not valid");
  }
  if (url.protocol !== "https:") throw new WebhookUrlError("the URL must use https");
  if (url.username !== "" || url.password !== "") throw new WebhookUrlError("the URL must not contain credentials");
  if (url.port !== "") throw new WebhookUrlError("the URL must use the standard https port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new WebhookUrlError("the URL points to a private or reserved address");
    return;
  }
  if (!host.includes(".")) throw new WebhookUrlError("the host must be a fully qualified host name");
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new WebhookUrlError("the host name could not be resolved");
  }
  if (addresses.length === 0) throw new WebhookUrlError("the host name could not be resolved");
  if (!addresses.every(isPublicAddress)) throw new WebhookUrlError("the host name resolves to a private or reserved address");
}

/**
 * A DNS lookup for the HTTP client that refuses private answers at connect time, so a name that resolved to a public
 * address when the endpoint was registered cannot later be pointed at an internal address (DNS rebinding).
 */
export function guardedLookup(resolver: Resolver = systemResolver): typeof dnsLookup {
  const lookup = (hostname: string, options: unknown, callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void): void => {
    resolver(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (first === undefined || !addresses.every(isPublicAddress)) {
          callback(new WebhookUrlError("the host name resolves to a private or reserved address"));
          return;
        }
        const wantAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
        if (wantAll) callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
        else callback(null, first, isIP(first));
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error("lookup failed")),
    );
  };
  return lookup as unknown as typeof dnsLookup;
}
