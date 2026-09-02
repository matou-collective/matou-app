# Privacy Policy (Matou App)

**Effective date:** 2026-08-29
**Contact:** `sysadmin@matou.nz`

This Privacy Policy explains how the Matou App (the "App") collects, uses,
stores and protects information. Matou is a platform for Indigenous
communities to govern themselves, coordinate projects and contributions,
share notices and chat, built on self-sovereign identity (KERI) and
peer-to-peer synchronisation (any-sync). It is designed around **data
sovereignty**: each community runs its own instance, and you control what
you share.

This text is kept in step with the policy shown inside the App. If anything
here conflicts with applicable law, applicable law controls.

## Who is responsible

The App is published by Matou (`sysadmin@matou.nz`). The community you
join (your "organisation") operates the instance that stores your community
data and its administrators decide who is admitted. Where this policy says
"we", it means Matou as publisher; where it says "your community", it means
that organisation.

## What information is collected

### Information you provide

- **Registration and profile**: display name, email address, bio,
  location, community/iwi affiliation, why you want to join, areas of
  interest, optional social links and an optional profile picture. Your
  community can configure which of these fields it asks for.
- **Content you create**: chat messages, notices, proposals, projects,
  milestones, contributions, comments, reactions, RSVPs and votes.
- **Support and reports**: what you send when you contact us or report a
  problem or another member.

### Information the App creates on your device

- **Cryptographic identity**: a KERI identifier (AID) and signing keys are
  generated on your device. The AID is public within your community and is
  how your actions are verified.
- **Recovery phrase (mnemonic)**: generated on-device and stored only in the
  device's secure storage (Android `EncryptedSharedPreferences`, backed by
  the hardware keystore). It is **never transmitted** to us or your
  community. We do not ask for it and cannot recover it for you.
- **Local data cache**: a copy of your community's synchronised data, so
  the App works offline.

### Information collected automatically

- **Network metadata**: your device connects to your community's identity
  agent (KERIA), witnesses, sync nodes and configuration server; those
  services see your IP address and connection times as part of normal
  operation.
- **Diagnostics**: logs stay on your device unless you choose to attach
  them to a report.
- We use **no advertising identifiers, analytics SDKs or crash reporters**.

### Permissions

The App uses the `INTERNET` permission only. It does not request access to
your camera, contacts, location or files except when you pick a profile
picture through the system picker.

## How information is used

- To provide the App: create and verify your identity, admit you to a
  community, synchronise community data between members' devices, and
  deliver chat, notices, projects and governance features.
- To let your community govern itself: registration approval, roles and
  permissions, voting and sign-off records.
- To communicate with you: registration and approval emails, invitations
  and booking confirmations sent by your community's instance.
- For safety and integrity: moderation, abuse prevention, security.

## Where information lives and who can see it

- **Community data** (profiles you share, messages, projects…) is
  synchronised through your community's any-sync nodes and stored on the
  devices of members with permission to read it. It is encrypted in transit
  and encrypted at rest in the sync network; read access is governed by
  cryptographic access-control lists.
- **Private profile data** is stored in a space only you can read.
- **Identity events** (your AID's key events) are held by your community's
  KERIA agent and witnesses. They contain public keys and signatures, not
  personal details.
- **Email**: transactional emails are sent through the email relay
  configured by your community.

Profile information you choose to share is visible to other members of
your community. Administrators can see registration details in order to
approve you.

## Sharing

We do not sell personal information. Information is shared only:

- with the members and administrators of the community you joined, as
  described above;
- with service providers your community uses to run its instance (hosting,
  email relay);
- when required by law, or to protect the rights and safety of members.

## Retention

Community data is retained by your community for as long as it operates the
instance and according to its own governance. Because the data is
synchronised peer-to-peer, copies may remain on other members' devices
after you leave. Identity key events are append-only and cannot be
deleted, but contain no personal details.

If you uninstall the App or clear its data, your recovery phrase is gone
with it; without a backup you cannot recover that identity.

## Your rights

Depending on where you live you may have rights to access, correct, delete
or export your personal information and to object to certain processing.
Contact `sysadmin@matou.nz` or your community's administrators. You can
edit your shared profile in the App at any time.

## Security

Keys never leave your device; data is encrypted in transit and in the sync
network; access is enforced cryptographically. No system is perfectly
secure — protect your device and your recovery phrase.

## Children

The App is not intended for people under 18. We do not knowingly collect
information from children; if you believe a child has registered, contact
`sysadmin@matou.nz`.

## Content moderation

Communities are administrator-moderated. Administrators may remove content,
restrict participation or remove members to enforce their community's
rules and these policies. See the Child Safety Standards for reporting.

## International transfers

Your community chooses where its infrastructure runs; your data may be
processed in a country other than your own.

## Changes

We may update this policy. The effective date above changes when we do;
significant changes are announced through the community.
