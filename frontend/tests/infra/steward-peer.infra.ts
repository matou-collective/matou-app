/**
 * Infrastructure POC: KERIA-only multisig org with 1-of-N signing
 *
 * Mirrors the official signify-ts integration test:
 * https://github.com/WebOfTrust/signify-ts/blob/main/test-integration/multisig-join.test.ts
 *
 * Two-round protocol to add a new member to a 1-of-1 group, ending as 1-of-2:
 *   Round 1: admin rotates master hab, then group-rotates with
 *            states=[admin], rstates=[admin, member]. Member receives EXN
 *            and just marks it (does NOT join yet). Member rotates their
 *            personal hab so their old next-key becomes their new current key.
 *   Round 2: admin rotates master hab again, queries member's *new* key state,
 *            then group-rotates with states=[admin, member], rstates=[admin,
 *            member]. Member receives the round-2 EXN, signs the embedded
 *            rotation with their newly-rotated keys, and calls groups().join().
 *
 * Phases:
 *   1.  Boot two SignifyClients (admin + member) against the same KERIA
 *   2.  Resolve schema OOBI on both
 *   3.  Create witnessed personal AIDs on both
 *   4.  Exchange OOBIs (admin ↔ member)
 *   5.  Admin creates 1-of-1 group AID (algo=group, isith=1, nsith=1, mhab=admin,
 *       witnessed with GROUP_WITNESS_AIDS)
 *   6.  Admin creates registry on group AID
 *   7.  Admin issues credential #1 from group AID to member (IPEX grant)
 *   8a. Admin: ROUND 1 group rotation (commit member in next-keys)
 *   8b. Member: marks round-1 notification, then rotates personal hab
 *   8c. Admin: ROUND 2 group rotation (promote member to signing keys)
 *   9.  Member receives round-2 notification, signs ROT2, joins
 *   10. Member issues credential #2 from the now-shared group AID
 *
 * Run: cd keri && npm install && npx tsx test-multisig.ts
 */

import {
    SignifyClient,
    ready,
    Tier,
    Siger,
    Serder,
    b,
    d,
    messagize,
    CredentialData,
} from 'signify-ts';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

// -- Infrastructure endpoints -------------------------------------------------

const KERIA_URL = 'http://localhost:5911';
const KERIA_BOOT_URL = 'http://localhost:5913';
const KERIA_CESR_URL = 'http://localhost:5912';
const SCHEMA_SERVER_URL = process.env.SCHEMA_SERVER_URL || 'http://localhost:7723';
// SCHEMA_OOBI_URL is what KERIA fetches from inside the docker network — must
// resolve from within the KERIA container, not from the host.
const SCHEMA_OOBI_URL = process.env.SCHEMA_OOBI_URL || 'http://schema-server:7723';

// Demo witness AIDs (matches keri/keria-config.json iurls)
const WITNESS_AIDS = [
    'BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM', // witness1 (5643)
    'BM35JN8XeJSEfpxopjn5jr7tAHCE5749f0OobhMLCorE', // witness2 (5645)
    'BF2rZTW79z4IXocYRQnjjsOuvFUQv-ptCf8Yltd7PfsM', // witness3 (5647)
];

// Disjoint witness set for the group AID so its inception event SAID differs
// from a personal AID's (otherwise with k=[admin], same wits/toad/sith,
// KERIA returns "Already incepted pre=<admin>").
const GROUP_WITNESSES = [
    { aid: 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha', port: 5642 },
    { aid: 'BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX', port: 5644 },
    { aid: 'BIj15u5V11bkbtAxMA7gcNJZcax-7TgaBMLsQnMHpYHP', port: 5646 },
];
const GROUP_WITNESS_AIDS = GROUP_WITNESSES.map((w) => w.aid);

// Membership schema SAID (matches matou-infrastructure/schemas/matou-membership-schema.json)
const MEMBERSHIP_SCHEMA_SAID = 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI';

// -- Tunables ----------------------------------------------------------------

const OP_TIMEOUT_MS = 60_000;
const ROT_POLL_INTERVAL_MS = 3_000;
const ROT_POLL_ATTEMPTS = 20;
const NOTIF_POLL_INTERVAL_MS = 2_000;
const NOTIF_POLL_ATTEMPTS = 30;

// -- Result tracking ---------------------------------------------------------

interface PhaseResult {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    note?: string;
    error?: string;
}
const results: PhaseResult[] = [];
function pass(name: string, note?: string) {
    results.push({ name, status: 'pass', note });
    log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
}
function fail(name: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'fail', error: msg });
    log(`FAIL  ${name} — ${msg}`);
}
function skip(name: string, why: string) {
    results.push({ name, status: 'skip', note: why });
    log(`SKIP  ${name} — ${why}`);
}

// -- Helpers -----------------------------------------------------------------

function log(msg: string) {
    const ts = new Date().toISOString().split('T')[1].slice(0, 8);
    console.log(`[${ts}] ${msg}`);
}

async function bootClient(label: string): Promise<SignifyClient> {
    const bran = randomUUID().replace(/-/g, '').substring(0, 21);
    log(`${label}: passcode ${bran.slice(0, 6)}...`);
    const client = new SignifyClient(KERIA_URL, bran, Tier.low, KERIA_BOOT_URL);
    try {
        await client.boot();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) throw err;
    }
    await client.connect();
    log(`${label}: agent=${client.agent?.pre}`);
    return client;
}

async function resolveWitnesses(_client: SignifyClient, label: string) {
    // KERIA pre-loads witnesses via iurls in keria-config.json, so no manual
    // resolution is needed when targeting our local infrastructure.
    log(`  ${label}: skipping witness OOBI resolution (preloaded via keria iurls)`);
}

async function resolveSchema(client: SignifyClient, label: string) {
    const schemaOobi = `${SCHEMA_OOBI_URL}/oobi/${MEMBERSHIP_SCHEMA_SAID}`;
    log(`  ${label}: resolving schema OOBI ${schemaOobi}`);
    const op = await client.oobis().resolve(schemaOobi);
    await client.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    log(`  ${label}: schema OOBI resolved`);
}

async function createPersonalAID(
    client: SignifyClient,
    name: string,
): Promise<{ name: string; prefix: string; state: Record<string, unknown> }> {
    const result = await client.identifiers().create(name, {
        wits: WITNESS_AIDS,
        toad: 2,
    });
    const op = await result.op();
    await client.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });

    // Add agent end role so OOBIs can be served
    const agentId = client.agent?.pre;
    if (agentId) {
        const erResult = await client.identifiers().addEndRole(name, 'agent', agentId);
        const erOp = await erResult.op();
        await client.operations().wait(erOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    }

    const aid = await client.identifiers().get(name);
    log(`  created AID "${name}" -> ${aid.prefix}`);
    return { name, prefix: aid.prefix, state: aid.state };
}

async function getAgentOOBI(client: SignifyClient, aidName: string): Promise<string> {
    const r = await client.oobis().get(aidName, 'agent');
    const oobi: string = r.oobis?.[0] || (r as Record<string, unknown>).oobi as string;
    if (!oobi) throw new Error(`No OOBI for ${aidName}`);
    // Keep the docker-internal hostname (http://keria:3902/...) — both signify
    // clients talk to the same KERIA container, and KERIA fetches OOBIs from
    // *inside* the container, where `keria:3902` resolves correctly.
    return oobi;
}

async function resolveContactOOBI(
    client: SignifyClient,
    oobi: string,
    alias: string,
): Promise<void> {
    const op = await client.oobis().resolve(oobi, alias);
    await client.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
}

async function pollOp(
    client: SignifyClient,
    opName: string,
    label: string,
): Promise<boolean> {
    for (let i = 0; i < ROT_POLL_ATTEMPTS; i++) {
        try {
            const status = await client.operations().get(opName);
            if (status?.done) {
                log(`  ${label}: op done after ${i + 1} polls`);
                return true;
            }
        } catch (err) {
            log(`  ${label}: poll ${i + 1} error: ${err}`);
        }
        await new Promise((r) => setTimeout(r, ROT_POLL_INTERVAL_MS));
    }
    log(`  ${label}: op NOT done after ${ROT_POLL_ATTEMPTS} polls (${(ROT_POLL_ATTEMPTS * ROT_POLL_INTERVAL_MS) / 1000}s)`);
    return false;
}

// -- Phase 5: create group AID ----------------------------------------------

async function createGroupAID(
    client: SignifyClient,
    groupName: string,
    master: { name: string; prefix: string; state: Record<string, unknown> },
): Promise<{ prefix: string; state: Record<string, unknown> }> {
    const masterAid = await client.identifiers().get(master.name);
    // Witnesses are required for member-add: the joining member's KERIA agent
    // needs to pull the group AID's prior KEL (s=0/s=1/s=2) to validate the
    // s=3 rotation embedded in /multisig/rot. Use a disjoint witness set from
    // personal AIDs so the icp SAID differs (otherwise k=[admin] with same
    // wits/toad collides with admin's own icp).
    const result = await client.identifiers().create(groupName, {
        algo: 'group' as never,
        isith: '1',
        nsith: '1',
        toad: 2,
        wits: GROUP_WITNESS_AIDS,
        mhab: masterAid,
        states: [masterAid.state],
        rstates: [masterAid.state],
    } as never);

    const op = await result.op();
    log(`  group create op: name=${op?.name}, done=${op?.done}`);
    if (!op?.done) {
        // signify-ts may not auto-wait for group; poll
        await pollOp(client, op.name, 'group-create');
    } else {
        await client.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    }

    const group = await client.identifiers().get(groupName);
    log(`  group AID: ${group.prefix}, algo=${group.group ? 'group' : 'salty'}, k=${JSON.stringify(group.state?.k)}, s=${group.state?.s}`);

    // Agent end role
    const agentId = client.agent?.pre;
    if (agentId) {
        try {
            const erResult = await client.identifiers().addEndRole(group.prefix, 'agent', agentId);
            const erOp = await erResult.op();
            await client.operations().wait(erOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
        } catch (err) {
            log(`  group end role warn: ${err}`);
        }
    }

    return { prefix: group.prefix, state: group.state };
}

// -- Phase 6/7: registry + issuance ------------------------------------------

async function createGroupRegistry(
    client: SignifyClient,
    groupName: string,
    registryName: string,
): Promise<string> {
    const result = await client.registries().create({
        name: groupName,
        registryName,
    });
    const op = await result.op();
    log(`  registry op: name=${op?.name}, done=${op?.done}`);
    if (!op?.done) {
        await pollOp(client, op.name, 'registry');
    } else {
        await client.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    }
    const list = await client.registries().list(groupName);
    const reg = list.find((r: { name: string }) => r.name === registryName);
    if (!reg) throw new Error(`registry ${registryName} not found after create`);
    log(`  registry created: ${reg.regk}`);
    return reg.regk;
}

async function issueMembershipCredential(
    client: SignifyClient,
    issuerAidName: string,
    registryRegk: string,
    recipientAid: string,
    role: string,
    options: { ipexGrant?: boolean } = {},
): Promise<string> {
    const issuer = await client.identifiers().get(issuerAidName);
    const data: CredentialData = {
        ri: registryRegk,
        s: MEMBERSHIP_SCHEMA_SAID,
        a: {
            i: recipientAid,
            communityName: 'MATOU',
            role,
            joinedAt: new Date().toISOString(),
        },
    };
    const credResult = await client.credentials().issue(issuer.prefix, data as never);
    const credOp = credResult.op;
    log(`  issue op: name=${credOp?.name}, done=${credOp?.done}`);
    if (!credOp?.done) {
        await pollOp(client, credOp.name, 'cred-issue');
    } else {
        await client.operations().wait(credOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    }
    const said = credResult.acdc?.said || (credResult.acdc as { sad?: { d?: string } })?.sad?.d || 'unknown';
    log(`  credential SAID: ${said}`);

    // IPEX grant (optional). Skipping it avoids pushing TEL events to the
    // recipient before they have the issuer's full KEL — which puts their
    // KERIA into a MissingAnchorError escrow loop and starves the HTTP
    // server. We test issuance independently of delivery.
    if (options.ipexGrant === true) {
        const [grant, gsigs, end] = await client.ipex().grant({
            senderName: issuer.prefix,
            recipient: recipientAid,
            message: '',
            acdc: credResult.acdc,
            iss: credResult.iss,
            anc: credResult.anc,
            datetime: new Date().toISOString(),
        });
        await client.ipex().submitGrant(issuer.prefix, grant, gsigs, end, [recipientAid]);
        log(`  IPEX grant submitted to ${recipientAid.slice(0, 12)}...`);
    } else {
        log(`  IPEX grant skipped (issuance verified, delivery deferred)`);
    }
    return said;
}

// -- Phase 8: add member to group (two-round protocol) -----------------------

async function preRotateMaster(
    client: SignifyClient,
    masterAidName: string,
    label: string,
): Promise<Record<string, unknown>> {
    log(`  ${label}: pre-rotating master hab "${masterAidName}"...`);
    const rotResult = await client.identifiers().rotate(masterAidName);
    const rotOp = await rotResult.op();
    await client.operations().wait(rotOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    const master = await client.identifiers().get(masterAidName);
    const ksOp = await client.keyStates().query(master.prefix, master.state?.s, undefined);
    const ks = (await client.operations().wait(ksOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) })).response as Record<string, unknown>;
    log(`  ${label}: master now s=${ks?.s}, k[0]=${(ks?.k as string[])?.[0]?.slice(0, 12)}`);
    return ks;
}

async function queryMemberStateAt(
    client: SignifyClient,
    memberPrefix: string,
    expectedSn: string,
    label: string,
): Promise<Record<string, unknown>> {
    log(`  ${label}: querying member state at s=${expectedSn}...`);
    const ksOp = await client.keyStates().query(memberPrefix, expectedSn, undefined);
    const ks = (await client.operations().wait(ksOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) })).response as Record<string, unknown>;
    log(`  ${label}: member state s=${ks?.s}, k[0]=${(ks?.k as string[])?.[0]?.slice(0, 12)}`);
    return ks;
}

async function sendMultisigRotExn(
    client: SignifyClient,
    masterAidName: string,
    groupName: string,
    groupPrefix: string,
    rotResult: { serder: Serder; sigs: string[] },
    smids: string[],
    rmids: string[],
    recipients: string[],
    label: string,
): Promise<void> {
    const masterFresh = await client.identifiers().get(masterAidName);
    log(`  ${label}: sending /multisig/rot EXN (master fresh s=${masterFresh.state?.s}) to ${recipients.length} recipient(s)...`);
    const sigers = rotResult.sigs.map((sig: string) => new Siger({ qb64: sig }));
    const ims = d(messagize(rotResult.serder, sigers));
    const atc = ims.substring(rotResult.serder.size);
    const rembeds = { rot: [rotResult.serder, atc] };
    await client.exchanges().send(
        masterAidName,
        groupName,
        masterFresh,
        '/multisig/rot',
        { gid: groupPrefix, smids, rmids },
        rembeds,
        recipients,
    );
    log(`  ${label}: /multisig/rot EXN sent`);
}

// Member-side helper: after admin's master hab rotates, member must explicitly
// query admin's new key state. Without this, when the /multisig/rot EXN arrives
// (signed at admin's new sn), member's agent rejects it with
// "Unable to find sender ... in kevers". Matches the signify-ts integration
// test pattern where each client queries the others' new states after rotations.
async function memberQueryAdminAt(
    memberClient: SignifyClient,
    adminPrefix: string,
    expectedSn: string,
    label: string,
): Promise<void> {
    log(`  ${label}: member querying admin state at s=${expectedSn}...`);
    const ksOp = await memberClient.keyStates().query(adminPrefix, expectedSn, undefined);
    const ks = (await memberClient.operations().wait(ksOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) })).response as Record<string, unknown>;
    log(`  ${label}: member sees admin at s=${ks?.s}, k[0]=${(ks?.k as string[])?.[0]?.slice(0, 12)}`);
}

// Round 1: commit member's current keys as part of the group's next-key digest.
// states stays [admin] (admin still the sole signer); rstates adds member.
async function addMemberRound1(
    client: SignifyClient,
    memberClient: SignifyClient,
    groupName: string,
    newMemberAidPrefix: string,
    masterAidName: string,
): Promise<{ rotSaid: string }> {
    const group0 = await client.identifiers().get(groupName);
    log(`  ROUND1: group seq before=${group0.state?.s}, k=${JSON.stringify(group0.state?.k)}`);

    const masterState = await preRotateMaster(client, masterAidName, 'ROUND1');
    // Member must learn admin's new key state before admin sends the EXN —
    // otherwise the EXN signature (referencing admin at the new sn) is
    // unverifiable on member's side.
    const masterPrefix = masterState.i as string;
    const masterSn = masterState.s as string;
    await memberQueryAdminAt(memberClient, masterPrefix, masterSn, 'ROUND1');

    const memberState = await queryMemberStateAt(client, newMemberAidPrefix, '0', 'ROUND1');

    log('  ROUND1: rotating group: states=[admin], rstates=[admin, member]');
    const rotResult = await client.identifiers().rotate(groupName, {
        states: [masterState],
        rstates: [masterState, memberState],
    } as never);
    const rotOp = await rotResult.op();
    const ked = rotResult.serder.ked || (rotResult.serder as { sad?: Record<string, unknown> }).sad;
    log(`  ROUND1 event: s=${ked?.s}, kt=${ked?.kt}, k=${JSON.stringify(ked?.k)}, nt=${ked?.nt}, sigs=${rotResult.sigs?.length}`);
    if (!rotOp?.done) await pollOp(client, rotOp.name, 'ROUND1');

    const smids = [masterState.i as string];
    const rmids = [masterState.i as string, memberState.i as string];
    await sendMultisigRotExn(
        client,
        masterAidName,
        groupName,
        group0.prefix,
        rotResult,
        smids,
        rmids,
        [newMemberAidPrefix],
        'ROUND1',
    );
    const rotSaid = (ked?.d as string) || rotResult.serder.pre;
    return { rotSaid };
}

// Round 2: promote member to signing keys. Member must have rotated their
// personal hab in between, so their old next-key (committed in round 1) is
// now their current signing key — satisfying the prior next-key commitment.
async function addMemberRound2(
    client: SignifyClient,
    memberClient: SignifyClient,
    groupName: string,
    newMemberAidPrefix: string,
    masterAidName: string,
): Promise<{ rotSaid: string }> {
    const group = await client.identifiers().get(groupName);
    log(`  ROUND2: group seq before=${group.state?.s}, k=${JSON.stringify(group.state?.k)}`);

    const masterState = await preRotateMaster(client, masterAidName, 'ROUND2');
    // Member must learn admin's new key state again — admin rotated.
    const masterPrefix = masterState.i as string;
    const masterSn = masterState.s as string;
    await memberQueryAdminAt(memberClient, masterPrefix, masterSn, 'ROUND2');
    // Member should have rotated their personal hab to s=1 by now.
    const memberState = await queryMemberStateAt(client, newMemberAidPrefix, '1', 'ROUND2');

    log('  ROUND2: rotating group: states=[admin, member], rstates=[admin, member]');
    const rotResult = await client.identifiers().rotate(groupName, {
        states: [masterState, memberState],
        rstates: [masterState, memberState],
    } as never);
    const rotOp = await rotResult.op();
    const ked = rotResult.serder.ked || (rotResult.serder as { sad?: Record<string, unknown> }).sad;
    log(`  ROUND2 event: s=${ked?.s}, kt=${ked?.kt}, k=${JSON.stringify(ked?.k)}, nt=${ked?.nt}, sigs=${rotResult.sigs?.length}`);
    if (!rotOp?.done) await pollOp(client, rotOp.name, 'ROUND2');

    const smids = [masterState.i as string, memberState.i as string];
    const rmids = [masterState.i as string, memberState.i as string];
    await sendMultisigRotExn(
        client,
        masterAidName,
        groupName,
        group.prefix,
        rotResult,
        smids,
        rmids,
        [newMemberAidPrefix],
        'ROUND2',
    );
    const rotSaid = (ked?.d as string) || rotResult.serder.pre;
    return { rotSaid };
}

// Member-side helpers ---------------------------------------------------------

async function memberRotatePersonalHab(
    client: SignifyClient,
    personalAidName: string,
): Promise<void> {
    log(`  member: rotating own personal hab "${personalAidName}"...`);
    const rotResult = await client.identifiers().rotate(personalAidName);
    const rotOp = await rotResult.op();
    await client.operations().wait(rotOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    const aid = await client.identifiers().get(personalAidName);
    log(`  member: personal hab now s=${aid.state?.s}, k[0]=${(aid.state?.k as string[])?.[0]?.slice(0, 12)}`);
}

async function markNotification(
    client: SignifyClient,
    notifSaid: string,
): Promise<void> {
    try {
        const notes = await client.notifications().list();
        const items = (notes.notes || []) as Array<{ i?: string; a?: { d?: string } }>;
        const match = items.find((n) => n.a?.d === notifSaid);
        if (match?.i) {
            await client.notifications().mark(match.i);
            log(`  member: marked notification ${notifSaid.slice(0, 12)} as read`);
        }
    } catch (err) {
        log(`  member: mark notification warn: ${err}`);
    }
}

// -- Phase 9: member joins ----------------------------------------------------

// Returns the SAID of an unseen /multisig/rot notification (excluding ones in
// `seenSaids`). This is how we tell round-1 from round-2 notifications.
async function waitForMultisigRot(
    client: SignifyClient,
    label: string,
    seenSaids: Set<string> = new Set(),
): Promise<string | null> {
    for (let i = 0; i < NOTIF_POLL_ATTEMPTS; i++) {
        try {
            const notes = await client.notifications().list();
            const items = (notes.notes || []) as Array<{ a?: { r?: string; d?: string }; r?: boolean }>;
            for (const n of items) {
                if (n.a?.r === '/multisig/rot' && n.a?.d && !seenSaids.has(n.a.d)) {
                    log(`  ${label}: found new /multisig/rot notification (poll ${i + 1}), said=${n.a.d.slice(0, 12)}...`);
                    return n.a.d;
                }
            }
        } catch (err) {
            log(`  ${label}: notification poll ${i + 1} error: ${err}`);
        }
        await new Promise((r) => setTimeout(r, NOTIF_POLL_INTERVAL_MS));
    }
    return null;
}

async function memberResolveGroupOOBI(
    memberClient: SignifyClient,
    adminClient: SignifyClient,
    groupName: string,
): Promise<void> {
    // Admin gets the group AID's agent OOBI, strips the /agent/{agentPre}
    // suffix to expose the bare KEL OOBI. Member resolves that — KERIA pulls
    // and stores the group's full prior KEL on member's agent side.
    // Matches the signify-ts integration test's `oobiMultisig` flow.
    const oobiResp = await adminClient.oobis().get(groupName, 'agent');
    const fullOobi: string | undefined = oobiResp.oobis?.[0];
    if (!fullOobi) throw new Error('admin returned no group OOBI');
    const groupOobi = fullOobi.split('/agent/')[0];
    log(`  member: resolving group OOBI ${groupOobi}`);
    const op = await memberClient.oobis().resolve(groupOobi, groupName);
    await memberClient.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    log(`  member: group OOBI resolved`);
}

async function memberJoinGroup(
    client: SignifyClient,
    groupName: string,
    notifSaid: string,
    personalAidName: string,
): Promise<string> {
    let exn: Record<string, unknown> | undefined;
    try {
        const grpResp = await client.groups().getRequest(notifSaid);
        if (grpResp && grpResp.length > 0 && grpResp[0].exn?.e?.rot) {
            exn = grpResp[0].exn;
            log('  member: found exn via groups().getRequest()');
        }
    } catch (err) {
        log(`  member: groups().getRequest() error: ${err}`);
    }
    if (!exn) {
        try {
            const exchResp = await client.exchanges().get(notifSaid);
            if (exchResp?.exn) {
                exn = exchResp.exn;
                log('  member: found exn via exchanges().get()');
            }
        } catch (err) {
            log(`  member: exchanges().get() error: ${err}`);
        }
    }
    if (!exn) throw new Error('no rotation request found for notification');

    const attrs = exn.a as Record<string, unknown>;
    const gid = attrs?.gid as string;
    const smids = attrs?.smids as string[];
    const rmids = attrs?.rmids as string[];
    const rotEvent = (exn.e as Record<string, unknown>)?.rot;
    if (!rotEvent || !gid) throw new Error('missing rotation event or gid');

    // Sign the rotation with the correct GROUP-LEVEL index. The signature
    // qb64 encodes its index; the verifier matches sig.index → rot.k[index].
    // Member's key sits at smids.indexOf(memberPersonalPrefix) in the group's
    // k array, NOT at their local hab's position 0. Passing the default sign()
    // produces an index-0 sig which KERIA rejects as "No verified signatures"
    // (because k[0] is admin's key, not member's).
    const serder = rotEvent instanceof Serder ? rotEvent : new Serder(rotEvent as never);
    const personal = await client.identifiers().get(personalAidName);
    const keeper = await client.manager!.get(personal);
    const memberIdx = smids.indexOf(personal.prefix);
    if (memberIdx < 0) throw new Error(`member ${personal.prefix} not in smids ${JSON.stringify(smids)}`);
    log(`  member: signing rotation at group index=${memberIdx}`);
    // keeper.sign() is async in signify-ts 0.3.x.
    const sigs = await keeper.sign(b(serder.raw), true, [memberIdx], [memberIdx]);

    log(`  member: calling groups().join(name=${groupName}, gid=${gid.slice(0, 12)}..., smids=${smids.length}, rmids=${rmids.length})`);
    const joinOp = await client.groups().join(groupName, serder, sigs, gid, smids, rmids);
    log(`  member join op: name=${joinOp?.name}, done=${joinOp?.done}`);
    if (!joinOp?.done) {
        await pollOp(client, joinOp.name, 'member-join');
    } else {
        await client.operations().wait(joinOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
    }

    // End role on the group AID for member's agent
    const agentId = client.agent?.pre;
    if (agentId) {
        try {
            const erResult = await client.identifiers().addEndRole(gid, 'agent', agentId);
            const erOp = await erResult.op();
            await client.operations().wait(erOp, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
        } catch (err) {
            log(`  member end-role warn: ${err}`);
        }
    }

    return gid;
}


// ============================================================================
// SPIKE: steward adopts an existing registry with registries().createFromEvents
// ============================================================================

const MODE = process.env.MODE || 'held'; // held: member holds cred#1 (prod-like) | fresh: registry unknown to member agent
const COMPOSE = 'docker compose -f keria-0.4/docker-compose.yml';

function nowIso() { return new Date().toISOString(); }
function kl(since: string, label: string, re?: RegExp) {
    let out = '';
    try {
        out = execSync(`${COMPOSE} logs keria --no-log-prefix --since ${since} 2>&1`, { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch (e) { out = String(e); }
    const tb = out.match(/Traceback[\s\S]*?\n[A-Za-z_.]*(Error|Exception|Duplicitous)[^\n]*/g) || [];
    log(`  [keria-log:${label}] ${tb.length} traceback(s)`);
    for (const t of tb.slice(-2)) console.log(t.split('\n').slice(-9).map((l) => '      | ' + l).join('\n'));
    const lines = out.split('\n').filter((l) => (re ?? /ERROR|WARNING|Duplicit|Missing|escrow|500|404|KeyError|Failure/i).test(l) && !/Traceback/.test(l));
    for (const l of lines.slice(-12)) console.log('      > ' + l.slice(0, 260));
    return lines;
}

async function errOf(fn: () => Promise<unknown>): Promise<string | null> {
    try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

interface CesrMsg { raw: string; atc: string; sad: Record<string, any> }
function splitCesr(text: string): CesrMsg[] {
    const msgs: CesrMsg[] = [];
    const marker = '{"v":"';
    let pos = text.indexOf(marker);
    while (pos >= 0) {
        const ver = text.substr(pos + 6, 17);
        const size = parseInt(ver.substr(10, 6), 16);
        const raw = text.substr(pos, size);
        let next = text.indexOf(marker, pos + size);
        const atc = text.slice(pos + size, next < 0 ? undefined : next);
        msgs.push({ raw, atc, sad: JSON.parse(raw) });
        pos = next;
    }
    return msgs;
}
// first indexed-sig group (-A##) of an attachment, optionally wrapped in -V##
function firstSigs(atc: string): string[] {
    let a = atc;
    if (a.startsWith('-V')) a = a.slice(4);
    if (!a.startsWith('-A')) throw new Error(`unexpected atc start ${a.slice(0, 8)}`);
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const n = b64.indexOf(a[2]) * 64 + b64.indexOf(a[3]);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(a.substr(4 + i * 88, 88));
    return out;
}

async function pushMsgs(msgs: CesrMsg[], dest: string, label: string): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    for (const m of msgs) {
        const r = await fetch(`${KERIA_CESR_URL}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/cesr+json', 'CESR-ATTACHMENT': m.atc.replace(/[\r\n]+/g, ''), 'CESR-DESTINATION': dest },
            body: m.raw,
        });
        const key = `${m.sad.t ?? 'acdc'}:${r.status}`;
        stats[key] = (stats[key] || 0) + 1;
        if (!r.ok) log(`    push[${label}] ${m.sad.t ?? 'ACDC'} s=${m.sad.s ?? '-'} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    log(`  push[${label}] -> ${JSON.stringify(stats)}`);
    return stats;
}

async function groupSn(c: SignifyClient, group: string): Promise<string> {
    const g = await c.identifiers().get(group);
    return String(g.state?.s);
}
async function kelSummary(c: SignifyClient, pre: string): Promise<string> {
    const evs = (await c.keyEvents().get(pre)) as Array<{ ked: any }>;
    return evs.map((e) => `${e.ked.t}${e.ked.s}:${e.ked.d.slice(0, 5)}`).join(' ');
}
async function waitOp(c: SignifyClient, op: any, ms = 30_000): Promise<{ done: boolean; err?: string; op: any }> {
    const end = Date.now() + ms;
    let last = op;
    while (Date.now() < end) {
        last = await c.operations().get(op.name);
        if (last.done) return { done: true, op: last, err: last.error ? JSON.stringify(last.error) : undefined };
        await new Promise((r) => setTimeout(r, 1500));
    }
    return { done: false, op: last };
}

async function memberAdmit(client: SignifyClient, memberName: string, memberPrefix: string, groupPrefix: string, cred: string) {
    for (let i = 0; i < 40; i++) {
        const notes = (await client.notifications().list()).notes as Array<any>;
        const g = notes.find((n) => n.a?.r === '/exn/ipex/grant');
        if (g) {
            const [admit, sigs, end] = await client.ipex().admit({ senderName: memberName, message: '', grantSaid: g.a.d, recipient: groupPrefix, datetime: nowIso() });
            const op = await client.ipex().submitAdmit(memberName, admit, sigs, end, [groupPrefix]);
            await client.operations().wait(op, { signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
            await client.notifications().mark(g.i);
            break;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    for (let i = 0; i < 30; i++) {
        const l = (await client.credentials().list()) as Array<any>;
        if (l.some((c) => c.sad.d === cred)) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('member never held cred1');
}


import { Saider, versify, Protocols, Serials, Ilks } from 'signify-ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const G = 'matou-org';

function logstats(since: string, label: string) {
    let out = '';
    try { out = execSync(`${COMPOSE} logs keria --no-log-prefix --since ${since} 2>&1`, { maxBuffer: 1 << 28 }).toString(); } catch (e) { out = String(e); }
    const c = (re: RegExp) => (out.match(re) || []).length;
    log(`  [logstats:${label}] MissingAnchor=${c(/MissingAnchorError: ANC/g)} waitFullyReceipted=${c(/Waiting for fully signed witness receipts/g)} receiptsComplete=${c(/Witness receipts complete/g)} LocalEvent=${c(/Local event regk/g)} outOfOrder=${c(/Out-of-order|out of order|OutOfOrder/gi)} partialSig=${c(/PartiallySigned|partial/gi)} traceback=${c(/Traceback/g)}`);
    const interesting = out.split('\n').filter((l) => /Witness receipts complete|Waiting for TEL|confirmed|non-extraction error: (?!Unverified)|Likely Duplicit|Kevery.*escrow|Out-of-order/i.test(l)).slice(-5);
    for (const l of interesting) console.log('      > ' + l.slice(0, 220));
}

function apiTracebacks(since: string, label: string) {
    const out = execSync(`${COMPOSE} logs keria --no-log-prefix --since ${since} 2>&1`, { maxBuffer: 1 << 28 }).toString();
    const tb = (out.match(/Traceback[\s\S]*?\n[A-Za-z_.]*(Error|Exception|Duplicitous)[^\n]*/g) || []).filter((t) => /falcon|credentialing\.py|aiding\.py/.test(t) && !/processEscrow/.test(t));
    log(`  [api-tracebacks:${label}] ${tb.length}`);
    for (const t of tb.slice(-1)) console.log(t.split('\n').slice(-8).map((l) => '      | ' + l).join('\n'));
}

function witKel(pre: string): CesrMsg[] {
    const out = execSync(`${COMPOSE} exec -T witness-demo curl -s localhost:5642/oobi/${pre}`, { maxBuffer: 1 << 26 }).toString();
    return splitCesr(out).filter((x) => ['icp', 'rot', 'ixn'].includes(x.sad.t));
}

function partsOf(text: string, said: string) {
    const ms = splitCesr(text);
    const acdc = ms.find((m) => !m.sad.t && m.sad.d === said)!;
    const iss = ms.find((m) => m.sad.t === 'iss' && m.sad.i === said);
    const rev = ms.find((m) => m.sad.t === 'rev' && m.sad.i === said);
    const anc = (seal: string) => ms.find((m) => m.sad.t === 'ixn' && (m.sad.a || []).some((x: any) => x.i === said && x.s === seal));
    return { ms, acdc, iss, rev, ancIss: anc('0'), ancRev: anc('1') };
}

async function waitForNote(c: SignifyClient, route: string, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const res = await c.notifications().list();
        const n = (res.notes ?? []).find((x: any) => x.a?.r === route && !x.r);
        if (n) return n;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
}

async function main() {
    log('=== SPIKE ROUND 2 ===');
    await ready();
    const admin = await bootClient('admin');
    const member = await bootClient('member');
    await resolveSchema(admin, 'admin'); await resolveSchema(member, 'member');
    const adminP = await createPersonalAID(admin, 'admin-personal');
    const memberP = await createPersonalAID(member, 'member-personal');
    await resolveContactOOBI(admin, await getAgentOOBI(member, memberP.name), 'member-contact');
    await resolveContactOOBI(member, await getAgentOOBI(admin, adminP.name), 'admin-contact');
    const grp = await createGroupAID(admin, G, adminP);
    await memberResolveGroupOOBI(member, admin, G);
    const regk = await createGroupRegistry(admin, G, 'matou-credentials');
    const cred1 = await issueMembershipCredential(admin, G, regk, memberP.prefix, 'Member', { ipexGrant: true });
    await memberAdmit(member, memberP.name, memberP.prefix, grp.prefix, cred1);

    // Z1 (issued) and Z2 (issued then revoked) BEFORE promotion / adoption
    const Z1 = await issueMembershipCredential(admin, G, regk, adminP.prefix, 'Member', { ipexGrant: false });
    const Z2 = await issueMembershipCredential(admin, G, regk, adminP.prefix, 'Contributor', { ipexGrant: false });
    const zr = await admin.credentials().revoke(G, Z2);
    await waitOp(admin, zr.op, 45_000);
    log(`  Z1=${Z1.slice(0, 8)} Z2=${Z2.slice(0, 8)} (revoked, state et=${(await admin.credentials().state(regk, Z2)).et})`);

    await addMemberRound1(admin, member, G, memberP.prefix, adminP.name);
    const n1 = await waitForMultisigRot(member, 'm-r1'); if (!n1) throw new Error('no r1');
    await markNotification(member, n1);
    await memberResolveGroupOOBI(member, admin, G);
    await memberRotatePersonalHab(member, memberP.name);
    await addMemberRound2(admin, member, G, memberP.prefix, adminP.name);
    const n2 = await waitForMultisigRot(member, 'm-r2', new Set([n1])); if (!n2) throw new Error('no r2');
    await memberJoinGroup(member, G, n2, memberP.name);
    log(`SETUP DONE group=${grp.prefix} regk=${regk}`);

    // adopt on member using cred1 export
    const c1 = partsOf(await member.credentials().get(cred1, true) as string, cred1);
    const vcp = splitCesr(await member.credentials().get(cred1, true) as string).find((m) => m.sad.t === 'vcp' && m.sad.i === regk)!;
    const anc0 = splitCesr(await member.credentials().get(cred1, true) as string).find((m) => m.sad.t === 'ixn' && (m.sad.a || []).some((x: any) => x.i === regk))!;
    const gh0 = await member.identifiers().get(G);
    const ad = await member.registries().createFromEvents(gh0, G, 'adopted', vcp.sad, anc0.sad, firstSigs(anc0.atc));
    log(`ADOPT http=${ad.status}`);
    for (let i = 0; i < 10; i++) { if (((await member.registries().list(G)) as any[]).some((r) => r.regk === regk)) break; await sleep(2000); }
    log(`  member registries: ${JSON.stringify((await member.registries().list(G)) as any[]).slice(0, 120)}`);

    const ownSigs = async (c: SignifyClient, raw: string): Promise<string[]> => {
        const gh = await c.identifiers().get(G);
        return (await c.manager!.get(gh).sign(b(raw))) as unknown as string[];
    };
    const sigOf = (m: CesrMsg) => firstSigs(m.atc);
    const sortIdx = (sigs: string[]) => [...sigs].sort((x, y) => 'ABCDEFGH'.indexOf(x[1]) - 'ABCDEFGH'.indexOf(y[1]));
    const replayIssue = async (c: SignifyClient, acdc: any, iss: any, anc: CesrMsg, sigs: string[]) => {
        const gh = await c.identifiers().get(G); const k = c.manager!.get(gh);
        const r = await c.fetch(`/identifiers/${G}/credentials`, 'POST', { acdc, iss, ixn: anc.sad, sigs, [k.algo]: k.params() })
            .then(async (x: Response) => `HTTP ${x.status}`).catch((e: Error) => String(e.message).slice(0, 220));
        return r;
    };
    const replayRev = async (c: SignifyClient, said: string, rev: any, anc: CesrMsg, sigs: string[]) => {
        const gh = await c.identifiers().get(G); const k = c.manager!.get(gh);
        return await c.fetch(`/identifiers/${G}/credentials/${said}`, 'DELETE', { rev, ixn: anc.sad, sigs, [k.algo]: k.params() })
            .then(async (x: Response) => `HTTP ${x.status}`).catch((e: Error) => String(e.message).slice(0, 220));
    };
    const stateEt = async (c: SignifyClient, said: string) => {
        try { const s = await c.credentials().state(regk, said); return s.et as string; } catch (e) { return 'ERR:' + String(e instanceof Error ? e.message : e).slice(0, 60); }
    };
    const has = async (c: SignifyClient, said: string) => (await errOf(() => c.credentials().get(said))) === null;
    const waitHas = async (c: SignifyClient, said: string, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await has(c, said)) return true; await sleep(1500); } return false; };
    const push = async (dst: SignifyClient, dstAid: string) => { await pushMsgs(witKel(grp.prefix), dstAid, 'witKEL'); await sleep(1500); };

    // ============ (c) backfill ============
    log('\n===== (c) BACKFILL from ACDC + witness KEL =====');
    await push(member, memberP.prefix);
    const acdcOnly = async (said: string) => (await admin.credentials().get(said)).sad; // "gateway directory"
    const wk = witKel(grp.prefix);
    const vs = versify(Protocols.KERI, undefined, Serials.JSON, 0);
    // c1: live credential Z1
    {
        const t0 = nowIso();
        const acdc = await acdcOnly(Z1);
        const [, iss] = Saider.saidify({ v: vs, t: Ilks.iss, d: '', i: acdc.d, s: '0', ri: acdc.ri, dt: acdc.a.dt });
        const anc = wk.find((m) => m.sad.t === 'ixn' && (m.sad.a || []).some((x: any) => x.d === iss.d));
        log(`c1 reconstructed iss.d=${iss.d.slice(0, 10)} matches witness seal: ${!!anc} (ixn s=${anc?.sad.s})`);
        if (anc) {
            const r = await replayIssue(member, acdc, iss, anc, sigOf(anc));
            await waitHas(member, Z1, 15_000);
            const et = await stateEt(member, Z1);
            log(`c1 replay ${r}; member has=${await has(member, Z1)} et=${et}`);
            logstats(t0, 'c1');
            (et === 'iss' ? pass : fail)('c1 backfill live cred from ACDC + witness KEL', `${r} et=${et}`);
        } else fail('c1 backfill', 'seal not found');
    }
    // c2: revoked credential Z2
    {
        const t0 = nowIso();
        const acdc = await acdcOnly(Z2);
        const [, iss] = Saider.saidify({ v: vs, t: Ilks.iss, d: '', i: acdc.d, s: '0', ri: acdc.ri, dt: acdc.a.dt });
        const ancI = wk.find((m) => m.sad.t === 'ixn' && (m.sad.a || []).some((x: any) => x.d === iss.d))!;
        const revSeal = wk.map((m) => (m.sad.a || []).find((x: any) => x.i === Z2 && x.s === '1')).find(Boolean);
        const ancR = wk.find((m) => m.sad.t === 'ixn' && (m.sad.a || []).some((x: any) => x.i === Z2 && x.s === '1'))!;
        log(`c2 iss seal found=${!!ancI}; rev seal (public, in witness KEL) d=${revSeal?.d?.slice(0, 10)}; rev atc has dt-like first-seen? ${/1AAG20/.test(ancR.atc)}`);
        // (i) replay iss
        const r1 = await replayIssue(member, acdc, iss, ancI, sigOf(ancI));
        await waitHas(member, Z2, 15_000);
        log(`c2 iss replay ${r1}; member et=${await stateEt(member, Z2)}`);
        // (ii) recover rev dt by brute force over ms window after iss dt
        const issMs = Date.parse(acdc.a.dt.replace('000+00:00', 'Z').replace(/(\.\d{3})000\+00:00$/, '$1Z'));
        const t1 = Date.now();
        let found: string | null = null; let tries = 0;
        const startMs = Date.parse(acdc.a.dt.slice(0, 23) + 'Z');
        for (let ms = startMs; ms < startMs + 600_000 && !found; ms++) {
            tries++;
            const dt = new Date(ms).toISOString().replace('Z', '000+00:00');
            const [, cand] = Saider.saidify({ v: vs, t: Ilks.rev, d: '', i: Z2, s: '1', ri: acdc.ri, p: iss.d, dt });
            if (cand.d === revSeal.d) found = dt;
        }
        log(`c2 rev dt brute force: found=${found} after ${tries} tries in ${Date.now() - t1}ms (window 10 min from iss dt = 600000 candidates)`);
        (found ? pass : fail)('c2 revoked cred: rev dt recoverable by brute force from public seal', `${found} ${tries} tries ${Date.now() - t1}ms`);
        if (found) {
            const [, rev] = Saider.saidify({ v: vs, t: Ilks.rev, d: '', i: Z2, s: '1', ri: acdc.ri, p: iss.d, dt: found });
            const r2 = await replayRev(member, Z2, rev, ancR, sigOf(ancR));
            await sleep(6000);
            const et = await stateEt(member, Z2);
            log(`c2 rev replay ${r2}; member et=${et}`);
            logstats(t0, 'c2');
            (et === 'rev' ? pass : fail)('c2 backfill revoked cred (iss + rev) into member', `${r2} et=${et}`);
        }
    }

    // ============ (a) keys[0] replay with own signature ============
    log('\n===== (a) admin (keys[0]) replays member-issued creds =====');
    const memberIssue = async (recipient: string, role: string) => {
        await push(member, memberP.prefix);
        const issuer = await member.identifiers().get(G);
        const data = { ri: regk, s: MEMBERSHIP_SCHEMA_SAID, a: { i: recipient, communityName: 'MATOU', role, joinedAt: nowIso() } };
        const cr = await member.credentials().issue(issuer.prefix, data as never);
        const w = await waitOp(member, cr.op, 60_000);
        if (!w.done) throw new Error('member issue op not done');
        return cr.acdc.sad.d as string;
    };
    const adminIssue = async (recipient: string, role: string) => { await push(admin, adminP.prefix); return issueMembershipCredential(admin, G, regk, recipient, role, { ipexGrant: false }); };
    const expAdmin = async (mem: SignifyClient, said: string) => partsOf(await mem.credentials().get(said, true) as string, said);

    // ============ GATE: native /multisig/iss delivery + Multiplexor auto-parse ============
    log('\n===== GATE: native /multisig/iss exn on keys[0] =====');
    {
        const since = nowIso();
        const issueFrom = memberIssue; // member (index 1) issues from the shared group AID; returns credential SAID
        const X = await issueFrom(adminP.prefix, 'Contributor');
        const p = await expAdmin(member, X);
        const mp = await member.identifiers().get(memberP.name);
        await member.exchanges().send(
            memberP.name, G, mp, '/multisig/iss', { gid: grp.prefix },
            { acdc: [new Serder(p.acdc!.sad), ''], iss: [new Serder(p.iss!.sad), ''], anc: [new Serder(p.ancIss!.sad), p.ancIss!.atc] },
            [adminP.prefix],
        );
        // 1. admin (keys[0]) gets a notification
        const note = await waitForNote(admin, '/multisig/iss', 30_000);
        note ? pass('gate: /multisig/iss notifies keys[0]') : fail('gate: /multisig/iss notifies keys[0]', 'no note');
        // 2. what did auto-parse do?
        await sleep(8000);
        const st = await admin.credentials().state(regk, X).catch((e: Error) => ({ err: e.message }));
        log(`  gate: admin state(X) after exn only = ${JSON.stringify(st)}`);
        const flood = kl(since, 'gate', /MissingAnchorError|Waiting for fully signed/).length;
        log(`  gate: escrow noise lines = ${flood}`);
        // 3. explicit replay with admin's own sig still converges
        await push(admin, adminP.prefix);
        const sigs = sortIdx([...sigOf(p.ancIss!), ...(await ownSigs(admin, p.ancIss!.raw))]);
        const r = await replayIssue(admin, p.acdc!.sad, p.iss!.sad, p.ancIss!, sigs);
        await waitHas(admin, X, 30_000);
        const st2 = await admin.credentials().state(regk, X).catch((e: Error) => ({ err: e.message } as any));
        log(`  gate: replay ${r}; state = ${JSON.stringify(st2)}`);
        st2.et === 'iss' ? pass('gate: replay after exn converges on keys[0]') : fail('gate: replay after exn converges on keys[0]', JSON.stringify(st2));
        await sleep(6000);
        const flood2 = kl(new Date(Date.now() - 6000).toISOString(), 'gate-after', /MissingAnchorError|Waiting for fully signed/).length;
        flood2 === 0 ? pass('gate: no lingering escrow after replay') : fail('gate: no lingering escrow after replay', `${flood2} lines`);
    }

    // a1: sigs = member's + admin own
    let X = '';
    {
        X = await memberIssue(adminP.prefix, 'Contributor');
        const p = await expAdmin(member, X);
        await push(admin, adminP.prefix);
        const t0 = nowIso();
        const own = await ownSigs(admin, p.ancIss!.raw);
        const sigs = sortIdx([...sigOf(p.ancIss!), ...own]);
        log(`a1 sigs indexes: ${sigs.map((s) => s.slice(0, 2))} (member sig ${sigOf(p.ancIss!).map((s) => s.slice(0, 2))}, own ${own.map((s) => s.slice(0, 2))})`);
        const r = await replayIssue(admin, p.acdc!.sad, p.iss!.sad, p.ancIss!, sigs);
        const ok = await waitHas(admin, X, 30_000);
        const et = await stateEt(admin, X);
        log(`a1 replay ${r}; admin has=${ok} et=${et}`);
        logstats(t0, 'a1');
        (ok && et === 'iss' ? pass : fail)('a1 keys[0] replays member-issued cred with member sig + own sig', `${r} has=${ok} et=${et}`);
        // revoke
        if (ok) {
            await push(admin, adminP.prefix);
            const rr = await errOf(async () => { const r = await admin.credentials().revoke(G, X); const w = await waitOp(admin, r.op, 45_000); if (!w.done || w.err) throw new Error(`op done=${w.done} ${w.err}`); });
            const et2 = await stateEt(admin, X);
            log(`a1 admin revoke err=${rr} et=${et2}`);
            (et2 === 'rev' ? pass : fail)('a1 admin then revokes X', `et=${et2} err=${rr}`);
        }
    }
    // a2: admin-only sig on an already-accepted ixn (member sig already stored via KEL push)
    {
        const X2 = await memberIssue(adminP.prefix, 'Contributor');
        const p = await expAdmin(member, X2);
        await push(admin, adminP.prefix); // admin's KEL now has ixn with member sig
        const t0 = nowIso();
        const own = await ownSigs(admin, p.ancIss!.raw);
        const r = await replayIssue(admin, p.acdc!.sad, p.iss!.sad, p.ancIss!, own);
        const ok = await waitHas(admin, X2, 30_000);
        const et = await stateEt(admin, X2);
        log(`a2 (own sig only, ixn already accepted) replay ${r}; has=${ok} et=${et}`);
        logstats(t0, 'a2');
        (ok && et === 'iss' ? pass : fail)('a2 own-sig-only on already-accepted ixn', `${r} has=${ok} et=${et}`);
    }
    // a3: admin-only sig, ixn NOT yet in admin's KEL (next event)
    {
        const X3 = await memberIssue(adminP.prefix, 'Contributor');
        const p = await expAdmin(member, X3);
        const t0 = nowIso();
        const before = await groupSn(admin, G);
        const own = await ownSigs(admin, p.ancIss!.raw);
        const r = await replayIssue(admin, p.acdc!.sad, p.iss!.sad, p.ancIss!, own);
        const ok = await waitHas(admin, X3, 30_000);
        const et = await stateEt(admin, X3);
        log(`a3 (own sig only, ixn new to admin) replay ${r}; admin sn ${before} -> ${await groupSn(admin, G)}; has=${ok} et=${et}`);
        log(`   admin KEL: ${await kelSummary(admin, grp.prefix)}`);
        logstats(t0, 'a3');
        (ok && et === 'iss' ? pass : fail)('a3 own-sig-only, ixn new to admin KEL', `${r} has=${ok} et=${et}`);
    }
    await push(member, memberP.prefix); await push(admin, adminP.prefix);

    // ============ (b) rev replay ============
    log('\n===== (b) rev replay =====');
    // b1: A = admin (keys[0]) revokes Y (admin-issued, replayed to member); B = member replays rev
    {
        const Y = await adminIssue(adminP.prefix, 'Member');
        await push(member, memberP.prefix);
        const p = await expAdmin(admin, Y);
        const sIss = sortIdx([...sigOf(p.ancIss!), ...(await ownSigs(member, p.ancIss!.raw))]);
        const r0 = await replayIssue(member, p.acdc!.sad, p.iss!.sad, p.ancIss!, sIss);
        const okm = await waitHas(member, Y, 30_000);
        log(`b1 setup: member replayed Y iss ${r0} has=${okm} et=${await stateEt(member, Y)}`);
        const t0 = nowIso();
        await push(admin, adminP.prefix);
        const rv = await admin.credentials().revoke(G, Y);
        await waitOp(admin, rv.op, 45_000);
        log(`b1 admin revoked Y et=${await stateEt(admin, Y)}`);
        await push(member, memberP.prefix);
        const p2 = await expAdmin(admin, Y);
        const sRev = sortIdx([...sigOf(p2.ancRev!), ...(await ownSigs(member, p2.ancRev!.raw))]);
        const r = await replayRev(member, Y, p2.rev!.sad, p2.ancRev!, sRev);
        await sleep(8000);
        const et = await stateEt(member, Y);
        log(`b1 member rev replay ${r}; member et=${et}`);
        logstats(t0, 'b1');
        (et === 'rev' ? pass : fail)('b1 A=keys[0] revokes, B=index1 replays rev with own sig', `${r} et=${et}`);
    }
    // b2: A = member (index1) revokes Y2 (admin-issued, both hold); B = admin (keys[0]) replays rev
    {
        const Y2 = await adminIssue(adminP.prefix, 'Member');
        await push(member, memberP.prefix);
        const p = await expAdmin(admin, Y2);
        const sIss = sortIdx([...sigOf(p.ancIss!), ...(await ownSigs(member, p.ancIss!.raw))]);
        await replayIssue(member, p.acdc!.sad, p.iss!.sad, p.ancIss!, sIss);
        await waitHas(member, Y2, 30_000);
        const t0 = nowIso();
        await push(member, memberP.prefix);
        const rv = await member.credentials().revoke(G, Y2);
        await waitOp(member, rv.op, 45_000);
        log(`b2 member revoked Y2 et=${await stateEt(member, Y2)}`);
        await push(admin, adminP.prefix);
        const p2 = await expAdmin(member, Y2);
        const sRev = sortIdx([...sigOf(p2.ancRev!), ...(await ownSigs(admin, p2.ancRev!.raw))]);
        log(`b2 sig idx: ${sRev.map((s) => s.slice(0, 2))}`);
        const r = await replayRev(admin, Y2, p2.rev!.sad, p2.ancRev!, sRev);
        await sleep(10000);
        const et = await stateEt(admin, Y2);
        log(`b2 admin rev replay ${r}; admin et=${et}`);
        logstats(t0, 'b2');
        (et === 'rev' ? pass : fail)('b2 A=index1 revokes, B=keys[0] replays rev with own sig', `${r} et=${et}`);
    }

    // ============ (d) credential TO adopted steward ============
    log('\n===== (d) credential to the adopted steward (issuee = member personal AID) =====');
    {
        await push(member, memberP.prefix);
        const W = await adminIssue(memberP.prefix, 'Trusted Member'.slice(0, 6) === 'Truste' ? 'Member' : 'Member');
        await push(member, memberP.prefix);
        const p = await expAdmin(admin, W);
        const t0 = nowIso();
        const sIss = sortIdx([...sigOf(p.ancIss!), ...(await ownSigs(member, p.ancIss!.raw))]);
        const r = await replayIssue(member, p.acdc!.sad, p.iss!.sad, p.ancIss!, sIss);
        const ok = await waitHas(member, W, 30_000);
        const lst = (await member.credentials().list()) as any[];
        const flt = (await member.credentials().list({ filter: { '-a-i': memberP.prefix } } as never)) as any[];
        log(`d replay ${r}; has=${ok} et=${await stateEt(member, W)}; list() has W=${lst.some((c) => c.sad.d === W)} (n=${lst.length}); list(filter issuee=member) has W=${flt.some((c) => c.sad.d === W)} (n=${flt.length})`);
        logstats(t0, 'd');
        (flt.some((c) => c.sad.d === W) ? pass : fail)('d replayed W shows in member credentials().list() (issuee filter)', `${r}`);
        // present onward: IPEX grant to a third-party verifier V
        try {
            const V = await bootClient('verifier');
            await resolveSchema(V, 'V');
            const vP = await createPersonalAID(V, 'v-personal');
            await resolveContactOOBI(member, await getAgentOOBI(V, vP.name), 'v-contact');
            await resolveContactOOBI(V, await getAgentOOBI(member, memberP.name), 'member-contact');
            await memberResolveGroupOOBI(V, admin, G);
            const pm = await expAdmin(member, W);
            const [grant, gsigs, end] = await member.ipex().grant({ senderName: memberP.name, recipient: vP.prefix, message: '', acdc: new Serder(pm.acdc!.sad), iss: new Serder(pm.iss!.sad), anc: new Serder(pm.ancIss!.sad), datetime: nowIso() });
            await member.ipex().submitGrant(memberP.name, grant, gsigs, end, [vP.prefix]);
            let landed = false;
            for (let i = 0; i < 25 && !landed; i++) {
                const n = (await V.notifications().list()).notes as any[];
                const g = n.find((x) => x.a?.r === '/exn/ipex/grant' && !x.r);
                if (g) {
                    const [admit, asg, aend] = await V.ipex().admit({ senderName: vP.name, message: '', grantSaid: g.a.d, recipient: memberP.prefix, datetime: nowIso() });
                    await V.ipex().submitAdmit(vP.name, admit, asg, aend, [memberP.prefix]);
                    await V.notifications().mark(g.i);
                }
                landed = ((await V.credentials().list()) as any[]).some((c) => c.sad.d === W);
                if (!landed) await sleep(2500);
            }
            log(`d present onward: verifier holds W = ${landed}`);
            (landed ? pass : fail)('d member can grant replayed W onward (verifier admits)', String(landed));
        } catch (e) { fail('d member can grant replayed W onward', e); }
    }

    // ============ (e) ordering ============
    log('\n===== (e) ordering =====');
    // e1 rev before iss into agent that has neither
    {
        const U = await adminIssue(adminP.prefix, 'Member');
        await push(admin, adminP.prefix);
        const rv = await admin.credentials().revoke(G, U);
        await waitOp(admin, rv.op, 45_000);
        await push(member, memberP.prefix);
        const p = await expAdmin(admin, U);
        const t0 = nowIso();
        const sRev = sortIdx([...sigOf(p.ancRev!), ...(await ownSigs(member, p.ancRev!.raw))]);
        const r1 = await replayRev(member, U, p.rev!.sad, p.ancRev!, sRev);
        log(`e1 rev-before-iss: ${r1}`);
        const sIss = sortIdx([...sigOf(p.ancIss!), ...(await ownSigs(member, p.ancIss!.raw))]);
        const r2 = await replayIssue(member, p.acdc!.sad, p.iss!.sad, p.ancIss!, sIss);
        await waitHas(member, U, 20_000);
        const r3 = await replayRev(member, U, p.rev!.sad, p.ancRev!, sRev);
        await sleep(8000);
        const et = await stateEt(member, U);
        log(`e1 then iss ${r2}, then rev again ${r3}; member et=${et}`);
        logstats(t0, 'e1');
        (et === 'rev' ? pass : fail)('e1 rev-before-iss is rejected cleanly, then iss+rev recovers', `first=${r1} et=${et}`);
    }
    // e2 anchoring ixn not yet in member's KEL, two creds replayed newest-first
    {
        await push(member, memberP.prefix);
        const Q1 = await adminIssue(adminP.prefix, 'Member');
        const Q2 = await adminIssue(adminP.prefix, 'Member');
        const p1 = await expAdmin(admin, Q1); const p2 = await expAdmin(admin, Q2);
        const t0 = nowIso();
        const s2 = sortIdx([...sigOf(p2.ancIss!), ...(await ownSigs(member, p2.ancIss!.raw))]);
        const s1 = sortIdx([...sigOf(p1.ancIss!), ...(await ownSigs(member, p1.ancIss!.raw))]);
        log(`e2 member sn=${await groupSn(member, G)}; Q1 anc s=${p1.ancIss!.sad.s}, Q2 anc s=${p2.ancIss!.sad.s}`);
        const r2 = await replayIssue(member, p2.acdc!.sad, p2.iss!.sad, p2.ancIss!, s2);
        const r1 = await replayIssue(member, p1.acdc!.sad, p1.iss!.sad, p1.ancIss!, s1);
        await sleep(15_000);
        log(`e2 replay Q2(sn n+2) ${r2}, Q1(sn n+1) ${r1}; after 15s w/o KEL push: member sn=${await groupSn(member, G)} hasQ1=${await has(member, Q1)} hasQ2=${await has(member, Q2)}`);
        apiTracebacks(t0, 'e2');
        await push(member, memberP.prefix);
        const okA = await waitHas(member, Q1, 10_000); const okB0 = await waitHas(member, Q2, 10_000);
        log(`e2 after KEL push (no re-POST): hasQ1=${okA} hasQ2=${okB0}`);
        const r2b = await replayIssue(member, p2.acdc!.sad, p2.iss!.sad, p2.ancIss!, s2);
        const okB = await waitHas(member, Q2, 30_000);
        log(`e2 re-POST of Q2 once KEL reached: ${r2b} has=${okB} et=${await stateEt(member, Q2)}`);
        log(`e2 after KEL push: member sn=${await groupSn(member, G)} hasQ1=${okA} et=${await stateEt(member, Q1)} hasQ2=${okB} et=${await stateEt(member, Q2)}`);
        logstats(t0, 'e2');
        // KERIA 0.4.0 does NOT self-recover an ahead-of-KEL replay; the caller must re-POST (design relies on this).
        (!okB0 ? pass : fail)('e2 replay whose ixn is ahead of the KEL is NOT self-recovered by a KEL push (re-POST required)', `hasQ1=${okA} hasQ2=${okB0}`);
        (okB ? pass : fail)('e2 same replay succeeds when re-POSTed after KEL push', `${r2b}`);
        // is member still healthy afterwards?
        const okIssue = await errOf(() => memberIssue(adminP.prefix, 'Member'));
        log(`e2 post-check: member can still issue? err=${okIssue}`);
        (okIssue === null ? pass : fail)('e2 member agent not wedged afterwards (can issue)', String(okIssue));
    }
    await sleep(8000);
    logstats(new Date(Date.now() - 6000).toISOString(), 'FINAL quiet 6s window');
    printSummary();
}

function printSummary() {
    console.log('\n=========== ROUND 2 SUMMARY ===========');
    for (const r of results) console.log(`${r.status.toUpperCase().padEnd(5)} ${r.name.padEnd(76)} ${(r.note || r.error || '').slice(0, 130)}`);
    process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}
main().catch((e) => { console.error('Fatal', e); printSummary(); });
