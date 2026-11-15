// Network access control: only devices on the local network may connect.
//
// Every incoming TCP connection (page loads and WebSocket signaling alike) is
// checked against its source address and dropped unless it comes from:
//   - this computer (loopback)
//   - a private LAN range: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local)
//   - IPv6 link-local (fe80::/10) or unique-local (fc00::/7) addresses
// VPN / CGNAT addresses such as Tailscale (100.64/10, fd7a:115c:a1e0::/48)
// are refused unless WB_ALLOW_VPN=1 is set.

export const allowVpn = process.env.WB_ALLOW_VPN === '1';

export function isLocalNetworkAddress(address, { vpn = allowVpn } = {}) {
  if (!address) return false;
  const ip = address.toLowerCase().replace(/^::ffff:/, '').replace(/%.*$/, '');

  if (ip.includes(':')) {
    if (ip === '::1') return true;
    if (/^fd7a:115c:a1e0:/.test(ip)) return vpn; // Tailscale IPv6
    if (/^fe[89ab]/.test(ip)) return true; // link-local
    if (/^f[cd]/.test(ip)) return true; // unique-local
    return false;
  }

  const [a, b] = ip.split('.').map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return vpn; // CGNAT range used by Tailscale
  return false;
}

/** Drop every connection that doesn't come from the local network. */
export function restrictToLocalNetwork(server, log = console.log) {
  const warned = new Set();
  server.prependListener('connection', (socket) => {
    const addr = socket.remoteAddress;
    if (isLocalNetworkAddress(addr)) return;
    if (!warned.has(addr)) {
      warned.add(addr);
      log(`[access] refused connection from ${addr} (not on the local network)`);
    }
    socket.destroy();
  });
}
