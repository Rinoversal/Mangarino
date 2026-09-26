/** Finding Mangarino Hub on the home network without typing anything. */
import * as Network from 'expo-network';

import { BRAND_HUB_PORT } from '../brand';

import { hello } from './api';
import { isPrivateIPv4, probeOrder, subnetHosts } from './net';

export interface FoundHub {
  host: string;
  port: number;
  name: string;
  serverId: string;
  /** Pairing by pressing Allow on the PC; older hubs need the 6-digit code instead. */
  canApprove: boolean;
}

export interface WifiInfo {
  ip: string | null;
  onWifi: boolean;
}

export async function wifiInfo(): Promise<WifiInfo> {
  const [state, ip] = await Promise.all([
    Network.getNetworkStateAsync().catch(() => null),
    Network.getIpAddressAsync().catch(() => '0.0.0.0'),
  ]);
  const onWifi = state?.type === Network.NetworkStateType.WIFI || state?.type === Network.NetworkStateType.ETHERNET;
  return { ip: isPrivateIPv4(ip) ? ip : null, onWifi };
}

/**
 * Ask every address on this device's network whether it runs the hub: 32 at a time, each
 * given `timeoutMs`. About 6 seconds for a whole network in the worst case. `preferred`
 * addresses (the last known PC) go first; with `stopAt` set, the sweep ends as soon as that
 * PC answers.
 */
export async function findHubs(opts: {
  ownIp: string;
  preferred?: (string | null | undefined)[];
  stopAt?: string;
  port?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** Each hub as soon as it answers, so it can be shown before the sweep ends. */
  onFound?: (hub: FoundHub) => void;
  isCancelled?: () => boolean;
}): Promise<FoundHub[]> {
  const port = opts.port ?? BRAND_HUB_PORT;
  const hosts = probeOrder(subnetHosts(opts.ownIp), opts.preferred ?? []);
  const found: FoundHub[] = [];
  let next = 0;
  let done = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < hosts.length) {
      if (opts.isCancelled?.()) {
        stop = true;
        return;
      }
      const host = hosts[next++];
      const h = await hello(host, port, opts.timeoutMs ?? 700);
      done++;
      opts.onProgress?.(done, hosts.length);
      if (h && !found.some((f) => f.serverId === h.serverId)) {
        const hub: FoundHub = { host, port, name: h.name, serverId: h.serverId, canApprove: !!h.features?.includes('approve') };
        found.push(hub);
        opts.onFound?.(hub);
        if (opts.stopAt && h.serverId === opts.stopAt) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return found;
}
