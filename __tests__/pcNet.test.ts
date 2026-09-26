import {
  HUB_PORT,
  formatBytes,
  isPrivateIPv4,
  isTailscaleIPv4,
  parseManualAddress,
  parsePairLink,
  probeOrder,
  subnetHosts,
} from '../src/pc/net';

describe('private addresses', () => {
  it('accepts home networks only', () => {
    for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20', '172.16.8.10']) {
      expect(isPrivateIPv4(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '169.254.1.1', '256.1.1.1', 'nope', '127.0.0.1']) {
      expect(isPrivateIPv4(ip)).toBe(false);
    }
  });
});

describe('subnetHosts', () => {
  it('lists the other 253 addresses, nearest first', () => {
    const hosts = subnetHosts('192.168.1.20');
    expect(hosts).toHaveLength(253);
    expect(hosts).not.toContain('192.168.1.20');
    expect(hosts).not.toContain('192.168.1.0');
    expect(hosts).not.toContain('192.168.1.255');
    expect(hosts.slice(0, 4)).toEqual(['192.168.1.19', '192.168.1.21', '192.168.1.18', '192.168.1.22']);
  });

  it('refuses public or broken addresses', () => {
    expect(subnetHosts('8.8.8.8')).toEqual([]);
    expect(subnetHosts('0.0.0.0')).toEqual([]);
  });

  it('puts the last known PC first', () => {
    const order = probeOrder(subnetHosts('192.168.1.20'), ['192.168.1.200', null]);
    expect(order[0]).toBe('192.168.1.200');
    expect(new Set(order).size).toBe(order.length);
  });
});

describe('typed addresses', () => {
  it('parses what people type', () => {
    expect(parseManualAddress('192.168.1.20')).toEqual({ host: '192.168.1.20', port: HUB_PORT });
    expect(parseManualAddress(' 192.168.1.20:7000 ')).toEqual({ host: '192.168.1.20', port: 7000 });
    expect(parseManualAddress('http://10.0.0.2:6264/')).toEqual({ host: '10.0.0.2', port: 6264 });
    expect(parseManualAddress('example.com')).toBeNull();
    expect(parseManualAddress('8.8.8.8')).toBeNull();
    expect(parseManualAddress('192.168.1.20:99999')).toBeNull();
  });
});

describe('QR pairing links', () => {
  it('reads the hub page QR code', () => {
    expect(parsePairLink('mangarino://pc?h=192.168.1.20&p=6264&c=123456&s=abc&n=HOME%20PC')).toEqual({
      host: '192.168.1.20', port: 6264, code: '123456', serverId: 'abc', name: 'HOME PC',
    });
  });

  it('rejects anything else', () => {
    expect(parsePairLink('https://example.com')).toBeNull();
    expect(parsePairLink('mangarino://pc?h=8.8.8.8&c=123456')).toBeNull();
    expect(parsePairLink('mangarino://pc?h=192.168.1.20&c=12345')).toBeNull();
    expect(parsePairLink('mangarino://pc?h=192.168.1.20&p=0&c=123456')).toBeNull();
  });

  it('works for the test edition too, with its own hub port', () => {
    // Testarino Hub listens on 6265 and leaves the port out of its QR code.
    expect(parsePairLink('testarino://pc?h=192.168.1.20&c=123456', 6265)).toMatchObject({ host: '192.168.1.20', port: 6265 });
    expect(parsePairLink('testarino://pc?h=192.168.1.20&p=7000&c=123456', 6265)?.port).toBe(7000);
    expect(parseManualAddress('192.168.1.20', 6265)).toEqual({ host: '192.168.1.20', port: 6265 });
    expect(parsePairLink('https://pc.example.com/?h=192.168.1.20&c=123456')).toBeNull();
  });
});

it('formats sizes', () => {
  expect(formatBytes(0)).toBe('0 MB');
  expect(formatBytes(469_000_000)).toBe('469 MB');
  expect(formatBytes(1_400_000_000)).toBe('1.4 GB');
});

describe('Tailscale', () => {
  it('knows its address range', () => {
    for (const ip of ['100.64.0.1', '100.101.102.103', '100.127.255.254']) expect(isTailscaleIPv4(ip)).toBe(true);
    for (const ip of ['100.63.255.255', '100.128.0.1', '192.168.1.20', '8.8.8.8']) expect(isTailscaleIPv4(ip)).toBe(false);
  });

  it('can be typed or come from the QR code', () => {
    expect(parseManualAddress('100.101.102.103')).toEqual({ host: '100.101.102.103', port: HUB_PORT });
    const link = parsePairLink('mangarino://pc?h=192.168.1.20&p=6264&c=123456&s=abc&n=PC&t=100.101.102.103');
    expect(link?.remote).toBe('100.101.102.103');
    expect(parsePairLink('mangarino://pc?h=192.168.1.20&c=123456&t=8.8.8.8')?.remote).toBeUndefined();
    expect(parsePairLink('mangarino://pc?h=100.101.102.103&c=123456')?.host).toBe('100.101.102.103');
  });

  it('is never swept', () => {
    expect(subnetHosts('100.101.102.103')).toEqual([]);
  });
});
