// Local-network guards shared by the signaling and WebRTC layers.

/** Private / link-local / loopback addresses and mDNS (.local) names. */
export function isLocalAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (a.endsWith('.local')) return true; // Chrome's mDNS-obfuscated host candidates
  if (a.includes(':')) {
    if (a === '::1') return true;
    if (/^fd7a:115c:a1e0:/.test(a)) return false; // Tailscale ULA: a VPN, not the LAN
    return /^fe[89ab]/.test(a) || /^f[cd]/.test(a); // link-local, unique-local
  }
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [x, y] = p;
  return (
    x === 10 ||
    x === 127 ||
    (x === 192 && y === 168) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 169 && y === 254)
  );
}

/** Hostnames that mean "this page was served from a machine on my network". */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || !h.includes('.') || isLocalAddress(h);
}

/**
 * ICE candidate allowed? Only host candidates on a local address: no
 * STUN-reflexive or TURN-relayed candidates, and no public/global addresses,
 * so media can only ever flow inside the local network.
 */
export function isLocalCandidate(candidate: string): boolean {
  if (!candidate) return true; // end-of-candidates marker
  const parts = candidate.replace(/^a=/, '').split(/\s+/);
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
  const address = parts[4];
  const typ = parts[parts.indexOf('typ') + 1];
  return !!address && typ === 'host' && isLocalAddress(address);
}

/** Remove non-local candidates embedded in an SDP blob. */
export function sanitizeSdp(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  return sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || isLocalCandidate(line))
    .join('\r\n');
}
