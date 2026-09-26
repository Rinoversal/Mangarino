/**
 * Addresses for finding and talking to Mangarino Hub on the PC. Pure: no Expo imports, so the
 * logic is unit-tested (__tests__/pcNet.test.ts).
 */

export const HUB_PORT = 6264;

export function parseIPv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** Home-network addresses only (10/8, 172.16/12, 192.168/16): the app never talks plain HTTP to the internet. */
export function isPrivateIPv4(ip: string): boolean {
  const p = parseIPv4(ip);
  if (!p) return false;
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Tailscale's addresses (100.64.0.0/10). With Tailscale on the PC and the device, signed in to
 * the same account, the hub is reachable at such an address from anywhere, encrypted.
 */
export function isTailscaleIPv4(ip: string): boolean {
  const p = parseIPv4(ip);
  return !!p && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

/** Addresses the app will talk to the hub on: the home network or Tailscale, never the open internet. */
export const isHubAddress = (ip: string) => isPrivateIPv4(ip) || isTailscaleIPv4(ip);

const lastOctet = (ip: string) => Number(ip.slice(ip.lastIndexOf('.') + 1));

/**
 * Every other address on this device's /24 network, nearest to the device's own address first
 * (home routers hand out addresses in order, so the PC is usually close by).
 */
export function subnetHosts(ownIp: string): string[] {
  const p = parseIPv4(ownIp);
  if (!p || !isPrivateIPv4(ownIp)) return [];
  const [a, b, c, d] = p;
  const out: string[] = [];
  for (let i = 1; i <= 254; i++) if (i !== d) out.push(`${a}.${b}.${c}.${i}`);
  return out.sort((x, y) => Math.abs(lastOctet(x) - d) - Math.abs(lastOctet(y) - d) || lastOctet(x) - lastOctet(y));
}

/** `preferred` addresses (the last known PC) first, then the rest, without duplicates. */
export function probeOrder(hosts: string[], preferred: (string | null | undefined)[]): string[] {
  const first = preferred.filter((h): h is string => !!h && isHubAddress(h));
  return [...new Set([...first, ...hosts])];
}

export interface HubAddress {
  host: string;
  port: number;
}

/** "192.168.1.20", "192.168.1.20:6264" or "http://192.168.1.20:6264/" typed by the user. */
export function parseManualAddress(text: string, defaultPort = HUB_PORT): HubAddress | null {
  const m = /^(?:https?:\/\/)?([\d.]+)(?::(\d{1,5}))?\/?$/i.exec(text.trim());
  if (!m || !isHubAddress(m[1])) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}

export interface PairLink extends HubAddress {
  code: string;
  serverId: string;
  name: string;
  /** The hub's Tailscale address, when it has one: used away from home. */
  remote?: string;
}

function queryParams(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    } catch {
      // malformed escape: skip
    }
  }
  return out;
}

/**
 * The QR code on the hub's page: mangarino://pc?h=<ip>&p=<port>&c=<code>&s=<serverId>&n=<name>,
 * plus t=<Tailscale address> when the PC runs Tailscale.
 */
export function parsePairLink(text: string, defaultPort = HUB_PORT): PairLink | null {
  // mangarino://pc?..., or testarino://pc?... from the test edition's hub
  const m = /^[a-z][a-z0-9+.-]*:\/\/pc\/?\?(.*)$/i.exec(text.trim());
  if (!m) return null;
  const q = queryParams(m[1]);
  const port = Number(q.p || defaultPort);
  if (!q.h || !isHubAddress(q.h) || !/^\d{6}$/.test(q.c ?? '') || !(port >= 1 && port <= 65535)) return null;
  const remote = q.t && isTailscaleIPv4(q.t) ? q.t : undefined;
  return { host: q.h, port, code: q.c, serverId: q.s ?? '', name: q.n ?? 'PC', ...(remote ? { remote } : {}) };
}

export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}
