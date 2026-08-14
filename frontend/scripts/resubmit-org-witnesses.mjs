var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
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
var KERIA_URL = 'http://awa.matou.nz:3901';
var KERIA_BOOT_URL = 'http://awa.matou.nz:3903';
var ORG_AID = 'EK5e49MmIGxMs4NEcQ9pb7hwJ0h4vbY_x3rbOyyCKKm8';
var WITNESS_OOBIS = [
    "http://awa.matou.nz:5643/oobi/".concat(ORG_AID), // wil
    "http://awa.matou.nz:5645/oobi/".concat(ORG_AID), // wit
    "http://awa.matou.nz:5646/oobi/".concat(ORG_AID),
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
function passcodeFromSecureStore() {
    var storePath = path.join(os.homedir(), '.config', 'Matou', 'matou-data', 'secure-store.json');
    var store;
    try {
        store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    }
    catch (_a) {
        return null;
    }
    var value = store['matou_passcode'];
    if (!value)
        return null;
    if (value.length === 21) {
        console.log('Passcode loaded from secure store (plaintext fallback).');
        return value;
    }
    var buf = Buffer.from(value, 'base64');
    var prefix = buf.subarray(0, 3).toString('latin1');
    if (prefix !== 'v10' && prefix !== 'v11') {
        // Not an OSCrypt ciphertext; maybe plaintext that isn't 21 chars — reject.
        return null;
    }
    var passwords = [];
    if (prefix === 'v10') {
        passwords.push('peanuts');
    }
    else {
        // v11: fetch the OSCrypt password from the keyring. Electron registers it
        // under the Chromium libsecret schema with the app name as attribute.
        for (var _i = 0, _b = ['matou', 'Matou', 'chromium', 'chrome']; _i < _b.length; _i++) {
            var app = _b[_i];
            try {
                var out = execFileSync('secret-tool', ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', app], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
                if (out)
                    passwords.push(out);
            }
            catch (_c) {
                /* try next */
            }
        }
        if (passwords.length === 0) {
            console.warn('secure store is v11-encrypted but the keyring password could not be fetched via secret-tool.');
            return null;
        }
    }
    for (var _d = 0, passwords_1 = passwords; _d < passwords_1.length; _d++) {
        var pw = passwords_1[_d];
        try {
            var key = crypto.pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1');
            var iv = Buffer.alloc(16, ' ');
            var decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            var plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf-8');
            if (plain.length === 21) {
                console.log("Passcode loaded from secure store (".concat(prefix, ")."));
                return plain;
            }
        }
        catch (_e) {
            /* wrong password — try next */
        }
    }
    return null;
}
function promptHidden(question) {
    return new Promise(function (resolve) {
        var rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        var anyRl = rl;
        process.stdout.write(question);
        anyRl._writeToOutput = function () { }; // mute echo
        rl.question('', function (answer) {
            anyRl._writeToOutput = function (s) { return anyRl.output.write(s); };
            process.stdout.write('\n');
            rl.close();
            resolve(answer.trim());
        });
    });
}
function checkWitnesses(label) {
    return __awaiter(this, void 0, void 0, function () {
        var ok, _i, WITNESS_OOBIS_1, url, res, body, _a, err_1;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    ok = 0;
                    _i = 0, WITNESS_OOBIS_1 = WITNESS_OOBIS;
                    _b.label = 1;
                case 1:
                    if (!(_i < WITNESS_OOBIS_1.length)) return [3 /*break*/, 9];
                    url = WITNESS_OOBIS_1[_i];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch(url, { signal: AbortSignal.timeout(10000) })];
                case 3:
                    res = _b.sent();
                    if (!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.text()];
                case 4:
                    _a = _b.sent();
                    return [3 /*break*/, 6];
                case 5:
                    _a = '';
                    _b.label = 6;
                case 6:
                    body = _a;
                    console.log("  [".concat(label, "] ").concat(url, " -> ").concat(res.status).concat(res.ok ? " (".concat(body.length, " bytes)") : ''));
                    if (res.ok && body.length > 0)
                        ok++;
                    return [3 /*break*/, 8];
                case 7:
                    err_1 = _b.sent();
                    console.log("  [".concat(label, "] ").concat(url, " -> error: ").concat(err_1.message));
                    return [3 /*break*/, 8];
                case 8:
                    _i++;
                    return [3 /*break*/, 1];
                case 9: return [2 /*return*/, ok];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var bran, _a, client, aids, org, _i, _b, a, info, state, res, _c, _d, _e, _f, op, deadline, current, opRes, ok;
        var _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    _a = process.env.MATOU_PASSCODE ||
                        passcodeFromSecureStore();
                    if (_a) return [3 /*break*/, 2];
                    return [4 /*yield*/, promptHidden('Steward passcode (21 chars, hidden): ')];
                case 1:
                    _a = (_j.sent());
                    _j.label = 2;
                case 2:
                    bran = _a;
                    if (bran.length !== 21) {
                        console.error("Passcode must be 21 characters, got ".concat(bran.length, ". Aborting."));
                        process.exit(1);
                    }
                    console.log('\n--- Witness state BEFORE ---');
                    return [4 /*yield*/, checkWitnesses('before')];
                case 3:
                    _j.sent();
                    return [4 /*yield*/, ready()];
                case 4:
                    _j.sent();
                    client = new SignifyClient(KERIA_URL, bran, Tier.low, KERIA_BOOT_URL);
                    console.log('\nConnecting to KERIA…');
                    return [4 /*yield*/, client.connect()];
                case 5:
                    _j.sent();
                    console.log("Connected. Agent: ".concat((_g = client.agent) === null || _g === void 0 ? void 0 : _g.pre, "  Controller: ").concat((_h = client.controller) === null || _h === void 0 ? void 0 : _h.pre));
                    return [4 /*yield*/, client.identifiers().list()];
                case 6:
                    aids = _j.sent();
                    org = aids.aids.find(function (a) { return a.prefix === ORG_AID; });
                    if (!org) {
                        console.error("Org AID ".concat(ORG_AID, " not found among this account's identifiers:"));
                        for (_i = 0, _b = aids.aids; _i < _b.length; _i++) {
                            a = _b[_i];
                            console.error("  ".concat(a.name, " ").concat(a.prefix));
                        }
                        process.exit(1);
                    }
                    console.log("Org identifier: name=\"".concat(org.name, "\" prefix=").concat(org.prefix));
                    return [4 /*yield*/, client.identifiers().get(org.name)];
                case 7:
                    info = _j.sent();
                    state = info.state;
                    console.log("Current key state: sn=".concat(state === null || state === void 0 ? void 0 : state.s, " witnesses=").concat(JSON.stringify(state === null || state === void 0 ? void 0 : state.b), " toad=").concat(state === null || state === void 0 ? void 0 : state.bt));
                    console.log("\nPOST /identifiers/".concat(org.name, "/submit \u2026"));
                    return [4 /*yield*/, client.fetch("/identifiers/".concat(encodeURIComponent(org.name), "/submit"), 'POST', { submit: true })];
                case 8:
                    res = _j.sent();
                    if (!!res.ok) return [3 /*break*/, 10];
                    _d = (_c = console).error;
                    _f = (_e = "submit failed: ".concat(res.status, " ")).concat;
                    return [4 /*yield*/, res.text()];
                case 9:
                    _d.apply(_c, [_f.apply(_e, [_j.sent()])]);
                    process.exit(1);
                    _j.label = 10;
                case 10: return [4 /*yield*/, res.json()];
                case 11:
                    op = (_j.sent());
                    console.log("Operation started: ".concat(op.name, " (done=").concat(op.done, ")"));
                    deadline = Date.now() + 10 * 60 * 1000;
                    current = op;
                    _j.label = 12;
                case 12:
                    if (!(!current.done && Date.now() < deadline)) return [3 /*break*/, 16];
                    return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 5000); })];
                case 13:
                    _j.sent();
                    return [4 /*yield*/, client.fetch("/operations/".concat(encodeURIComponent(current.name)), 'GET', null)];
                case 14:
                    opRes = _j.sent();
                    if (!opRes.ok) {
                        console.log("  poll -> ".concat(opRes.status));
                        return [3 /*break*/, 12];
                    }
                    return [4 /*yield*/, opRes.json()];
                case 15:
                    current = (_j.sent());
                    process.stdout.write("  waiting\u2026 done=".concat(current.done, " (").concat(new Date().toISOString(), ")\n"));
                    return [3 /*break*/, 12];
                case 16:
                    if (!current.done) {
                        console.warn('\nOperation NOT done after 10 minutes. Checking witnesses anyway —');
                    }
                    else {
                        console.log('\nOperation completed.');
                    }
                    console.log('\n--- Witness state AFTER ---');
                    return [4 /*yield*/, checkWitnesses('after')];
                case 17:
                    ok = _j.sent();
                    if (ok >= 2) {
                        console.log("\nSUCCESS: ".concat(ok, "/3 witnesses now serve the org KEL (toad=2 satisfiable)."));
                        console.log('Next: re-approve wjkw1 from the dashboard.');
                    }
                    else {
                        console.log("\nWitnesses serving org KEL: ".concat(ok, "/3 \u2014 not enough yet. Re-run this script or inspect KERIA logs."));
                    }
                    process.exit(0);
                    return [2 /*return*/];
            }
        });
    });
}
main().catch(function (err) {
    console.error('FAILED:', err);
    process.exit(1);
});
