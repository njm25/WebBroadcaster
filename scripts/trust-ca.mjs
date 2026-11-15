// Installs (or with --remove, uninstalls) the WebBroadcaster local CA as a
// trusted root for the current user, so browsers on this computer show a
// normal secure padlock. Your OS asks you to confirm.
//
//   npm run trust          install
//   npm run untrust        remove
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { CA_CERT_PATH, ensureCerts } from '../server/certs.mjs';

const remove = process.argv.includes('--remove');
if (!remove) await ensureCerts(); // creates the CA if the server hasn't run yet
if (!fs.existsSync(CA_CERT_PATH)) {
  console.error('No local CA found in .certs/.');
  process.exit(1);
}
const ca = new X509Certificate(fs.readFileSync(CA_CERT_PATH));
const cn = /CN=([^\n,]+)/.exec(ca.subject)?.[1] ?? 'WebBroadcaster Local CA';
const serial = ca.serialNumber;

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === 0;
};

let ok = false;
switch (os.platform()) {
  case 'win32':
    // Current-user root store (no admin needed); Windows shows a confirmation dialog.
    ok = remove ? run('certutil', ['-user', '-delstore', 'Root', serial]) : run('certutil', ['-user', '-addstore', 'Root', CA_CERT_PATH]);
    break;
  case 'darwin': {
    const keychain = `${os.homedir()}/Library/Keychains/login.keychain-db`;
    ok = remove
      ? run('security', ['delete-certificate', '-c', cn, keychain])
      : run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, CA_CERT_PATH]);
    break;
  }
  default:
    console.log(
      remove
        ? `Remove "${cn}" from your system/browser trust store.`
        : `Linux: copy ${CA_CERT_PATH} to /usr/local/share/ca-certificates/webbroadcaster-ca.crt and run "sudo update-ca-certificates".\n` +
            'Chrome/Firefox may use their own store: Settings → Privacy & security → Certificates → Authorities → Import.',
    );
    process.exit(0);
}

console.log(
  ok
    ? remove
      ? `Removed "${cn}".`
      : `Trusted "${cn}". Fully quit and reopen your browser, then reload the studio.`
    : 'The command did not complete (cancelled or failed).',
);
process.exit(ok ? 0 : 1);
