import { isIP } from "node:net";

const IPV4_FORBIDDEN: [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local (the cloud metadata service lives here)
];
// Hosts spelled as one decimal/hex number or dotted hex/octal parts are alternative spellings of an IP address.
const ODD_IP_SPELLING = /^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/i;

const v4ToInt = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);

/**
 * Hosts a server-side client must never be pointed at from an administrator-editable setting: loopback,
 * unspecified and link-local addresses (the AWS instance metadata service 169.254.169.254, fd00:ec2::254),
 * "localhost" and odd spellings of IP addresses. Private ranges stay allowed on purpose (a company mail relay
 * inside the VPC is legitimate).
 */
export function isForbiddenOutboundHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const n = v4ToInt(h);
    return IPV4_FORBIDDEN.some(([a, b]) => n >= a && n <= b);
  }
  if (kind === 6) {
    if (h === "::" || h === "::1" || h.startsWith("fe80:") || h.startsWith("fd00:ec2:")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped ? isForbiddenOutboundHost(mapped[1]!) : false;
  }
  return ODD_IP_SPELLING.test(h);
}
