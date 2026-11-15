// Local HTTPS certificate management.
//
// iOS Safari (and every browser) only exposes getUserMedia in a secure context,
// so phones on the LAN must load the app over HTTPS. We create a local
// certificate authority once (.certs/ca.pem) and use it to sign a server
// certificate whose SAN covers localhost and every LAN IPv4 address of this
// machine; the server cert is re-issued automatically when the network
// changes. Trust ca.pem on each device (`npm run trust` on this computer,
// /webbroadcaster-ca.crt on phones) to get a normal secure padlock.
//
// To use a different certificate, set HTTPS_KEY and HTTPS_CERT to PEM files.

import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { allowVpn } from './access.mjs';

const CERT_DIR = path.resolve(process.cwd(), '.certs');

const VIRTUAL_IFACE = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-|virbr|Loopback/i;
const VPN_IFACE = /tailscale|zerotier|wireguard|wg\d|utun|tun\d|tap\d|vpn|nordlynx|hamachi/i;

/**
 * Non-internal IPv4 addresses of this machine, best first, classified so the
 * UI can steer phones to the real Wi-Fi/Ethernet address:
 *   lan     - private LAN address (192.168/16, 10/8, 172.16/12) on a physical adapter
 *   vpn     - Tailscale/ZeroTier/etc. (100.64/10 CGNAT range or a VPN adapter)
 *   virtual - Hyper-V/WSL/Docker/VM adapters (not reachable from phones)
 */
export function networkAddresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (ip.startsWith('169.254.')) continue; // link-local: no network
      const [a, b] = ip.split('.').map(Number);
      let kind = 'lan';
      if (VPN_IFACE.test(iface) || (a === 100 && b >= 64 && b <= 127)) kind = 'vpn';
      else if (VIRTUAL_IFACE.test(iface)) kind = 'virtual';
      const label =
        kind === 'vpn'
          ? `${/tailscale/i.test(iface) || a === 100 ? 'Tailscale' : iface} VPN (only devices on the VPN)`
          : kind === 'virtual'
            ? `${iface} (virtual adapter)`
            : `${iface} (local network)`;
      out.push({ ip, iface, kind, label });
    }
  }
  const rank = { lan: 0, vpn: 1, virtual: 2 };
  return out.sort((x, y) => rank[x.kind] - rank[y.kind]);
}

/** Addresses other devices should be told to use (VPN only when allowed). */
export function joinableAddresses() {
  return networkAddresses().filter((a) => a.kind === 'lan' || (a.kind === 'vpn' && allowVpn));
}

/** IPv4 addresses, best first (LAN before VPN before virtual). */
export function lanAddresses() {
  return networkAddresses().map((a) => a.ip);
}

/** URL path where devices can download the local CA certificate to trust it. */
export const CA_URL_PATH = '/webbroadcaster-ca.crt';
export const CA_CERT_PATH = path.join(CERT_DIR, 'ca.pem');
const CA_KEY_PATH = path.join(CERT_DIR, 'ca-key.pem');

/**
 * Local certificate authority, created once per computer and kept across
 * network changes. Installing ca.pem as a trusted root on a device makes
 * every server certificate below trusted (green padlock, no warnings).
 * ca-key.pem must stay private: it can issue certificates your devices trust.
 */
async function ensureCA() {
  try {
    const cert = fs.readFileSync(CA_CERT_PATH, 'utf8');
    const key = fs.readFileSync(CA_KEY_PATH, 'utf8');
    if (Date.now() < new Date(new X509Certificate(cert).validTo).getTime() - 30 * 864e5) return { key, cert };
  } catch {
    /* create below */
  }
  const pems = await selfsigned.generate(
    [
      { name: 'commonName', value: `WebBroadcaster Local CA (${os.hostname()})` },
      { name: 'organizationName', value: 'WebBroadcaster (local development)' },
    ],
    {
      algorithm: 'sha256',
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 10 * 365 * 864e5),
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      ],
    },
  );
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CA_KEY_PATH, pems.private, { mode: 0o600 });
  fs.writeFileSync(CA_CERT_PATH, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

export function readCaCert() {
  try {
    return fs.readFileSync(CA_CERT_PATH);
  } catch {
    return null;
  }
}

/** Serve the CA certificate so phones can install it (dev middleware + prod server). */
export function serveCaCert(res) {
  const pem = readCaCert();
  if (!pem) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('No local CA (a custom certificate is in use).');
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/x-x509-ca-cert',
    'content-disposition': 'attachment; filename="webbroadcaster-ca.crt"',
    'cache-control': 'no-cache',
  });
  res.end(pem);
}

export async function ensureCerts() {
  if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
    return {
      key: fs.readFileSync(process.env.HTTPS_KEY, 'utf8'),
      cert: fs.readFileSync(process.env.HTTPS_CERT, 'utf8'),
      custom: true,
    };
  }

  const ca = await ensureCA();
  const caFingerprint = new X509Certificate(ca.cert).fingerprint256;
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const metaPath = path.join(CERT_DIR, 'meta.json');
  const ips = lanAddresses();
  const host = os.hostname();

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const coversAll = ips.every((ip) => meta.ips.includes(ip));
    const fresh = Date.now() < meta.expires - 7 * 864e5;
    if (coversAll && fresh && meta.host === host && meta.caFingerprint === caFingerprint) {
      return {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert: fs.readFileSync(certPath, 'utf8'),
        custom: false,
      };
    }
  } catch {
    /* no cached cert yet */
  }

  // Server certificate signed by the local CA. 365 days keeps it within
  // Apple's limits for certificates issued by user-installed roots.
  const notAfterDate = new Date(Date.now() + 365 * 864e5);
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: host },
    { type: 2, value: `${host}.local` },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'WebBroadcaster Local Studio' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notAfterDate,
    ca: { key: ca.key, cert: ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  const chain = `${pems.cert.trim()}\n${ca.cert.trim()}\n`;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, chain);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ ips, host, expires: notAfterDate.getTime(), caFingerprint }, null, 2),
  );
  return { key: pems.private, cert: chain, custom: false };
}

export function printUrls(port, log = console.log) {
  log('');
  log('  WebBroadcaster is running');
  log(`    Studio (this computer):  https://localhost:${port}/studio`);
  for (const a of joinableAddresses()) {
    log(`    Phones / other devices:  https://${a.ip}:${port}/source   (${a.label})`);
  }
  log('  HTTPS uses a local certificate authority. To remove "Not secure" warnings:');
  log('    this computer:  npm run trust   (then restart the browser)');
  log(`    phones:         open https://<address>:${port}${CA_URL_PATH} (see "Connect a device")`);
  log(
    allowVpn
      ? '  Access: local network + VPN (WB_ALLOW_VPN=1).'
      : '  Access: local network only. Connections from the internet or a VPN (e.g. Tailscale) are refused.',
  );
  log('');
}
