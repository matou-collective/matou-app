/**
 * One-off repair: resubmit the org AID's KEL to its adopted witnesses.
 *
 * Background: the org AID (EK5e49…) rotated in witnesses on 2026-06-10 but the
 * witnesses never received its KEL (pre-patch KERIA catchup bug), so every
 * credential issuance since hangs waiting for receipts. KERIA's
 * POST /identifiers/{name}/submit re-sends the KEL to the witnesses and
 * collects receipts (the deployed matou-keria-patched image has the fixed
 * catchup path this relies on).
 *
 * Usage:  npx tsx scripts/resubmit-org-witnesses.ts
 * Prompts for the steward passcode (hidden, used only in-memory).
 */
import { SignifyClient, Tier, ready } from 'signify-ts';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const KERIA_URL = 'http://awa.matou.nz:3901';
const KERIA_BOOT_URL = 'http://awa.matou.nz:3903';
const ORG_AID = 'EK5e49MmIGxMs4NEcQ9pb7hwJ0h4vbY_x3rbOyyCKKm8';
const WITNESS_OOBIS = [
  `http://awa.matou.nz:5643/oobi/${ORG_AID}`, // wil
  `http://awa.matou.nz:5645/oobi/${ORG_AID}`, // wit
  `http://awa.matou.nz:5646/oobi/${ORG_AID}`, // wub
];

/**
 * Read the passcode from the Matou app's secure store
 * (~/.config/Matou/matou-data/secure-store.json, key "matou_passcode").
 * Values are Electron safeStorage ciphertexts (Chromium OSCrypt):
 *   - "v10" prefix: AES-128-CBC, key derived from the literal password "peanuts"
 *     (basic_text backend, used when no keyring is available)
 *   - "v11" prefix: same scheme but the password lives in the OS keyring
 *     (fetched via secret-tool)
 *   - no prefix: stored as plaintext (keyring was unavailable at save time)
 * The decrypted passcode is returned in-memory only and never printed.
 */
function passcodeFromSecureStore(): string | null {
  const storePath = path.join(os.homedir(), '.config', 'Matou', 'matou-data', 'secure-store.json');
  let store: Record<string, string>;
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return null;
  }
  const value = store['matou_passcode'];
  if (!value) return null;

  if (value.length === 21) {
    console.log('Passcode loaded from secure store (plaintext fallback).');
    return value;
  }

  const buf = Buffer.from(value, 'base64');
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Not an OSCrypt ciphertext; maybe plaintext that isn't 21 chars — reject.
    return null;
  }

  const passwords: string[] = [];
  if (prefix === 'v10') {
    passwords.push('peanuts');
  } else {
    // v11: the OSCrypt password lives in the OS keyring under a Chromium
    // libsecret schema. The application attribute varies by app/version, so
    // enumerate every entry with those schemas and try each secret.
    for (const schema of ['chrome_libsecret_os_crypt_password_v2', 'chrome_libsecret_os_crypt_password_v1']) {
      try {
        const out = execFileSync('secret-tool', ['search', '--all', '--unlock', 'xdg:schema', schema], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        for (const line of out.split('\n')) {
          const m = line.match(/^secret = (.+)$/);
          if (m && m[1]) passwords.push(m[1]);
        }
      } catch {
        /* schema not present — try next */
      }
    }
    if (passwords.length === 0) {
      console.warn('secure store is v11-encrypted but no Chromium OSCrypt entries were found in the keyring.');
      return null;
    }
    console.log(`Trying ${passwords.length} keyring candidate(s)…`);
  }

  for (const pw of passwords) {
    try {
      const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1');
      const iv = Buffer.alloc(16, ' ');
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      const plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf-8');
      if (plain.length === 21) {
        console.log(`Passcode loaded from secure store (${prefix}).`);
        return plain;
      }
    } catch {
      /* wrong password — try next */
    }
  }
  return null;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
    process.stdout.write(question);
    anyRl._writeToOutput = () => {}; // mute echo
    rl.question('', (answer) => {
      anyRl._writeToOutput = (s: string) => anyRl.output.write(s);
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function checkWitnesses(label: string): Promise<number> {
  let ok = 0;
  for (const url of WITNESS_OOBIS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const body = res.ok ? await res.text() : '';
      console.log(`  [${label}] ${url} -> ${res.status}${res.ok ? ` (${body.length} bytes)` : ''}`);
      if (res.ok && body.length > 0) ok++;
    } catch (err) {
      console.log(`  [${label}] ${url} -> error: ${(err as Error).message}`);
    }
  }
  return ok;
}

async function main() {
  const bran =
    process.env.MATOU_PASSCODE ||
    passcodeFromSecureStore() ||
    (await promptHidden('Steward passcode (21 chars, hidden): '));
  if (bran.length !== 21) {
    console.error(`Passcode must be 21 characters, got ${bran.length}. Aborting.`);
    process.exit(1);
  }

  console.log('\n--- Witness state BEFORE ---');
  await checkWitnesses('before');

  await ready();
  const client = new SignifyClient(KERIA_URL, bran, Tier.low, KERIA_BOOT_URL);
  console.log('\nConnecting to KERIA…');
  await client.connect();
  console.log(`Connected. Agent: ${client.agent?.pre}  Controller: ${client.controller?.pre}`);

  const aids = await client.identifiers().list();
  const org = aids.aids.find((a: { name: string; prefix: string }) => a.prefix === ORG_AID);
  if (!org) {
    console.error(`Org AID ${ORG_AID} not found among this account's identifiers:`);
    for (const a of aids.aids) console.error(`  ${a.name} ${a.prefix}`);
    process.exit(1);
  }
  console.log(`Org identifier: name="${org.name}" prefix=${org.prefix}`);

  const info = await client.identifiers().get(org.name);
  const state = (info as { state?: { s?: string; b?: string[]; bt?: string } }).state;
  console.log(`Current key state: sn=${state?.s} witnesses=${JSON.stringify(state?.b)} toad=${state?.bt}`);

  console.log(`\nPOST /identifiers/${org.name}/submit …`);
  const res = await client.fetch(`/identifiers/${encodeURIComponent(org.name)}/submit`, 'POST', { submit: true });
  if (!res.ok) {
    console.error(`submit failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const op = (await res.json()) as { name: string; done: boolean };
  console.log(`Operation started: ${op.name} (done=${op.done})`);

  const deadline = Date.now() + 10 * 60 * 1000;
  let current = op;
  while (!current.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const opRes = await client.fetch(`/operations/${encodeURIComponent(current.name)}`, 'GET', null);
    if (!opRes.ok) {
      console.log(`  poll -> ${opRes.status}`);
      continue;
    }
    current = (await opRes.json()) as { name: string; done: boolean };
    process.stdout.write(`  waiting… done=${current.done} (${new Date().toISOString()})\n`);
  }

  if (!current.done) {
    console.warn('\nOperation NOT done after 10 minutes. Checking witnesses anyway —');
  } else {
    console.log('\nOperation completed.');
  }

  console.log('\n--- Witness state AFTER ---');
  const ok = await checkWitnesses('after');
  if (ok >= 2) {
    console.log(`\nSUCCESS: ${ok}/3 witnesses now serve the org KEL (toad=2 satisfiable).`);
    console.log('Next: re-approve wjkw1 from the dashboard.');
  } else {
    console.log(`\nWitnesses serving org KEL: ${ok}/3 — not enough yet. Re-run this script or inspect KERIA logs.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
