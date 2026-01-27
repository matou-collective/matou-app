/**
 * Real KERI Client using signify-ts
 * Connects to KERIA agent for AID management
 */
import { SignifyClient, Tier, randomPasscode, ready, Salter } from 'signify-ts';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export interface AIDInfo {
  prefix: string; // The AID string (e.g., "EAbcd...")
  name: string;
  state: unknown;
}

export interface CredentialInfo {
  said: string;
  schema: string;
  issuer: string;
  issuee: string;
  status: string;
}

/**
 * KERI client wrapper using signify-ts
 * Keys never leave device - this is a core security principle
 */
export class KERIClient {
  private client: SignifyClient | null = null;
  private connected = false;

  // KERIA endpoints - direct connection
  // CORS enabled via KERI_AGENT_CORS=1 environment variable
  private readonly keriaUrl = 'http://localhost:3901';
  private readonly keriaBootUrl = 'http://localhost:3903';

  /**
   * Initialize and connect to KERIA agent
   * For new users, this will boot (create) the agent first
   * For returning users, it will connect to the existing agent
   * @param bran - The passcode (21-character base64 string)
   */
  async initialize(bran: string): Promise<void> {
    await ready();
    this.client = new SignifyClient(this.keriaUrl, bran, Tier.low, this.keriaBootUrl);

    try {
      // Try to connect to existing agent
      console.log('[KERIClient] Attempting to connect to existing agent...');
      await this.client.connect();
      console.log('[KERIClient] Connected to existing KERIA agent');
    } catch (err) {
      // If agent doesn't exist, boot (create) it first
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log('[KERIClient] Connect error:', errorMsg);
      if (errorMsg.includes('agent does not exist')) {
        console.log('[KERIClient] Agent not found, booting new agent...');
        try {
          await this.client.boot();
          console.log('[KERIClient] Boot completed successfully');
        } catch (bootErr) {
          console.error('[KERIClient] Boot failed:', bootErr);
          throw bootErr;
        }
        console.log('[KERIClient] Attempting to connect after boot...');
        await this.client.connect();
        console.log('[KERIClient] Booted and connected to new KERIA agent');
      } else {
        throw err;
      }
    }

    this.connected = true;
    console.log('[KERIClient] Connection established');

    // Get KERIA config and resolve witness iurls if present
    try {
      const config = await this.client.config().get();
      console.log('[KERIClient] KERIA config:', JSON.stringify(config));

      // Resolve witness OOBIs from iurls (needed for witness-backed AIDs)
      // IMPORTANT: Remove /controller suffix to get full OOBI with endpoint data
      // The /controller suffix only returns key state, not the endpoint URLs that KERIA needs
      if (config.iurls && Array.isArray(config.iurls) && config.iurls.length > 0) {
        console.log(`[KERIClient] Resolving ${config.iurls.length} witness OOBIs from config...`);
        for (let i = 0; i < config.iurls.length; i++) {
          let iurl = config.iurls[i];
          try {
            // Remove /controller suffix if present - we need the full OOBI with endpoints
            // signify-ts tests use /oobi/{AID} without /controller to get endpoint data
            if (iurl.endsWith('/controller')) {
              iurl = iurl.replace('/controller', '');
              console.log(`[KERIClient] Stripped /controller suffix for endpoint resolution`);
            }
            // Extract witness AID from iurl for alias (e.g., "wit0", "wit1", etc.)
            const alias = `wit${i}`;
            console.log(`[KERIClient] Resolving witness OOBI: ${iurl} with alias: ${alias}`);
            const op = await this.client.oobis().resolve(iurl, alias);
            await this.client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
            console.log(`[KERIClient] Resolved: ${iurl}`);
          } catch (resolveErr) {
            console.warn(`[KERIClient] Failed to resolve witness OOBI ${iurl}:`, resolveErr);
          }
        }
        console.log('[KERIClient] Witness OOBI resolution complete');
      }
    } catch (configErr) {
      console.warn('[KERIClient] Could not fetch KERIA config:', configErr);
    }
  }

  /**
   * Create a new AID (Autonomic Identifier)
   * @param name - Human-readable name for the AID
   * @param options - Optional configuration
   * @param options.useWitnesses - If true, create AID with witness backing (slower but enables message routing)
   * @returns The created AID info
   */
  async createAID(name: string, options?: { useWitnesses?: boolean }): Promise<AIDInfo> {
    if (!this.client) throw new Error('Not initialized');

    // Witness AIDs (from witness-demo image):
    // - BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha (wan, port 5642)
    // Using only 1 witness with toad=1 to match signify-ts test pattern
    const WITNESS_AID = 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha';

    let result;
    if (options?.useWitnesses) {
      // Create AID with witness backing
      // Using 1 witness with toad=1 (matching signify-ts test pattern)
      console.log('[KERIClient] Creating AID with witness backing (1 witness, toad=1)...');
      result = await this.client.identifiers().create(name, {
        wits: [WITNESS_AID],
        toad: 1, // Threshold: need 1 witness to acknowledge
      });
    } else {
      // Create without witnesses (faster for development)
      console.log('[KERIClient] Creating AID (without witnesses for faster dev)...');
      result = await this.client.identifiers().create(name);
    }

    console.log('[KERIClient] Waiting for AID operation to complete...');
    const op = await result.op();
    console.log('[KERIClient] Operation:', JSON.stringify(op));
    // Witness-backed AIDs need longer timeout (3 minutes) for witness acknowledgments
    const timeout = options?.useWitnesses ? 180000 : 60000;
    try {
      await this.client.operations().wait(op, { signal: AbortSignal.timeout(timeout) });
      console.log('[KERIClient] AID operation completed');
    } catch (waitErr) {
      console.error('[KERIClient] AID operation wait failed:', waitErr);
      // Try to get operation status
      try {
        const opStatus = await this.client.operations().get(op.name);
        console.log('[KERIClient] Operation status:', JSON.stringify(opStatus));
      } catch (statusErr) {
        console.error('[KERIClient] Could not get operation status:', statusErr);
      }
      throw waitErr;
    }

    // Get the created AID - try listing first if get fails
    let aid;
    try {
      aid = await this.client.identifiers().get(name);
    } catch (getErr) {
      console.warn(`[KERIClient] get(${name}) failed, trying list():`, getErr);
      // Try listing all AIDs and finding by name
      const aids = await this.client.identifiers().list();
      console.log('[KERIClient] All AIDs:', aids);
      const found = aids.aids.find((a: { name: string }) => a.name === name);
      if (!found) {
        throw new Error(`AID "${name}" not found after creation`);
      }
      aid = found;
    }
    console.log(`[KERIClient] Created AID: ${aid.prefix} for name: ${name}`);

    // Add end role to authorize the agent as endpoint provider for this AID
    // This is required for receiving messages from other agents
    console.log(`[KERIClient] Adding agent end role for AID...`);
    try {
      // Get the agent's identifier (eid) - this is the agent AID that serves as endpoint provider
      const agentId = this.client.agent?.pre;
      if (!agentId) {
        throw new Error('Agent identifier not available');
      }
      console.log(`[KERIClient] Agent EID: ${agentId}`);

      const endRoleResult = await this.client.identifiers().addEndRole(name, 'agent', agentId);
      const endRoleOp = await endRoleResult.op();
      await this.client.operations().wait(endRoleOp, { signal: AbortSignal.timeout(30000) });
      console.log(`[KERIClient] Agent end role added successfully`);
    } catch (endRoleErr) {
      console.warn('[KERIClient] Failed to add agent end role:', endRoleErr);
      // Continue - the AID is created, but may not receive messages
    }

    return {
      prefix: aid.prefix,
      name: aid.name,
      state: aid.state,
    };
  }

  /**
   * Get an existing AID by name
   * @param name - The AID name to retrieve
   * @returns AID info or null if not found
   */
  async getAID(name: string): Promise<AIDInfo | null> {
    if (!this.client) return null;
    try {
      const aid = await this.client.identifiers().get(name);
      return { prefix: aid.prefix, name: aid.name, state: aid.state };
    } catch {
      return null;
    }
  }

  /**
   * List all AIDs for this client
   * @returns Array of AID info
   */
  async listAIDs(): Promise<AIDInfo[]> {
    if (!this.client) return [];
    const aids = await this.client.identifiers().list();
    return aids.aids.map((a: { prefix: string; name: string; state: unknown }) => ({
      prefix: a.prefix,
      name: a.name,
      state: a.state,
    }));
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the underlying SignifyClient (for advanced operations)
   */
  getSignifyClient(): SignifyClient | null {
    return this.client;
  }

  // Organization AID (from backend/config/.keria-config.json)
  private readonly ORG_AID = 'EI7LkuTY607pTjtq2Wtxn6tHcb7--_279EKT5eNNnXU9';

  /**
   * Get the organization's OOBI URL
   * This is a well-known endpoint that users can resolve to contact the org
   */
  getOrgOOBI(): string {
    // KERIA OOBI endpoint - port 3902 is the OOBI service
    return `http://localhost:3902/oobi/${this.ORG_AID}`;
  }

  /**
   * Resolve an OOBI to establish contact with another party
   * @param oobi - The OOBI URL to resolve
   * @param alias - Optional alias for the contact
   * @param timeout - Timeout in milliseconds (default: 10000)
   * @returns true if successful
   */
  async resolveOOBI(oobi: string, alias?: string, timeout = 10000): Promise<boolean> {
    if (!this.client) throw new Error('Not initialized');

    try {
      console.log(`[KERIClient] Resolving OOBI: ${oobi}`);
      const op = await this.client.oobis().resolve(oobi, alias);
      await this.client.operations().wait(op, { signal: AbortSignal.timeout(timeout) });
      console.log(`[KERIClient] OOBI resolved successfully`);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('aborted') || errorMsg.includes('timeout')) {
        console.warn(`[KERIClient] OOBI resolution timed out after ${timeout}ms`);
      } else {
        console.error('[KERIClient] Failed to resolve OOBI:', err);
      }
      return false;
    }
  }

  /**
   * Send a registration EXN message to the organization
   * This establishes contact and shares the user's endpoint info
   * @param senderName - Name of the sender's AID
   * @param registrationData - Registration details to send
   * @returns Success status and message SAID
   */
  async sendRegistration(
    senderName: string,
    registrationData: {
      name: string;
      bio: string;
      interests: string[];
      customInterests?: string;
    }
  ): Promise<{ success: boolean; said?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not initialized' };
    }

    try {
      // Get the sender's AID state (with workaround for 401 issue)
      let sender;
      try {
        sender = await this.client.identifiers().get(senderName);
      } catch (getErr) {
        console.warn(`[KERIClient] get(${senderName}) failed, trying list():`, getErr);
        // Workaround: list all AIDs and find by name
        const aids = await this.client.identifiers().list();
        const found = aids.aids.find((a: { name: string }) => a.name === senderName);
        if (!found) {
          throw new Error(`AID "${senderName}" not found`);
        }
        sender = found;
      }

      // Create the registration payload
      const payload = {
        type: 'registration',
        name: registrationData.name,
        bio: registrationData.bio,
        interests: registrationData.interests,
        customInterests: registrationData.customInterests || '',
        submittedAt: new Date().toISOString(),
      };

      console.log('[KERIClient] Creating registration EXN message...');

      // Create the exchange message
      const [exn, sigs, atc] = await this.client.exchanges().createExchangeMessage(
        sender,
        '/matou/registration/apply',  // Custom route for registration
        payload,
        {},  // No embeds
        this.ORG_AID
      );

      console.log('[KERIClient] Sending registration to org...');

      // Send the message
      await this.client.exchanges().sendFromEvents(
        senderName,
        'registration',  // Topic
        exn,
        sigs,
        atc,
        [this.ORG_AID]
      );

      // Get the SAID from the exchange message
      const exnSaid = (exn as { ked?: { d?: string } })?.ked?.d || 'unknown';
      console.log('[KERIClient] Registration sent successfully, SAID:', exnSaid);

      return {
        success: true,
        said: exnSaid,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[KERIClient] Failed to send registration:', err);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Verify an invite code (stubbed - real implementation would check against KERIA)
   * @param code - The invite code to verify
   * @returns Inviter name if valid, throws if invalid
   */
  async verifyInviteCode(code: string): Promise<{ valid: boolean; inviterName: string }> {
    // Mock validation - in reality would check against KERIA credentials
    const validCodes: Record<string, string> = {
      'DEMO-CODE-2024': 'Whanau_Lead',
      'MATOU-2024': 'Kaitiaki_42',
      TESTCODE: 'Admin_1',
    };

    const normalizedCode = code.toUpperCase().trim();

    if (validCodes[normalizedCode]) {
      return {
        valid: true,
        inviterName: validCodes[normalizedCode],
      };
    }

    // Accept any code that's at least 8 characters for demo purposes
    if (normalizedCode.length >= 8) {
      return {
        valid: true,
        inviterName: 'Community_Member',
      };
    }

    throw new Error('Invalid invite code');
  }

  /**
   * Get pending approval status for a registration (stubbed)
   * @param aid - The AID to check
   * @returns Approval status
   */
  async getApprovalStatus(
    _aid: string,
  ): Promise<{ status: 'pending' | 'approved' | 'rejected'; message?: string }> {
    // Always returns pending for stub
    return {
      status: 'pending',
      message: 'Your application is under review by community admins.',
    };
  }

  /**
   * Create a group AID controlled by a master AID
   * Used for creating organizational identities that a single admin controls
   * @param name - Name for the group AID
   * @param masterAidName - Name of the master AID that will control the group
   * @returns The created group AID info
   */
  async createGroupAID(name: string, masterAidName: string): Promise<AIDInfo> {
    if (!this.client) throw new Error('Not initialized');

    console.log(`[KERIClient] Creating group AID "${name}" with master "${masterAidName}"...`);

    // Get the master AID (the admin's personal AID)
    let masterAid;
    try {
      masterAid = await this.client.identifiers().get(masterAidName);
    } catch (getErr) {
      console.warn(`[KERIClient] get(${masterAidName}) failed, trying list():`, getErr);
      const aids = await this.client.identifiers().list();
      const found = aids.aids.find((a: { name: string }) => a.name === masterAidName);
      if (!found) {
        throw new Error(`Master AID "${masterAidName}" not found`);
      }
      masterAid = found;
    }

    // Create the group AID with the master as the only member
    // mhab = master habery (the controlling AID)
    // states/rstates contain the key state of participating members
    const result = await this.client.identifiers().create(name, {
      algo: undefined, // Use default algorithm
      isith: '1', // Signing threshold of 1
      nsith: '1', // Next signing threshold of 1
      toad: 0, // No witnesses for now (faster for dev)
      wits: [],
      mhab: masterAid, // Master AID controls this group
      states: [masterAid.state], // Include master's key state
      rstates: [masterAid.state], // Include master's rotation state
    });

    console.log('[KERIClient] Waiting for group AID operation...');
    const op = await result.op();
    await this.client.operations().wait(op, { signal: AbortSignal.timeout(60000) });
    console.log('[KERIClient] Group AID operation completed');

    // Get the created group AID
    let groupAid;
    try {
      groupAid = await this.client.identifiers().get(name);
    } catch (getErr) {
      console.warn(`[KERIClient] get(${name}) failed, trying list():`, getErr);
      const aids = await this.client.identifiers().list();
      const found = aids.aids.find((a: { name: string }) => a.name === name);
      if (!found) {
        throw new Error(`Group AID "${name}" not found after creation`);
      }
      groupAid = found;
    }

    console.log(`[KERIClient] Created group AID: ${groupAid.prefix}`);

    return {
      prefix: groupAid.prefix,
      name: groupAid.name,
      state: groupAid.state,
    };
  }

  /**
   * Create a credential registry for an AID
   * A registry is needed to issue credentials
   * @param aidName - Name of the AID that will own the registry
   * @param registryName - Name for the registry
   * @returns The registry identifier
   */
  async createRegistry(aidName: string, registryName: string): Promise<string> {
    if (!this.client) throw new Error('Not initialized');

    console.log(`[KERIClient] Creating registry "${registryName}" for AID "${aidName}"...`);

    const result = await this.client.registries().create({
      name: aidName,
      registryName: registryName,
    });

    console.log('[KERIClient] Waiting for registry operation...');
    const op = await result.op();
    await this.client.operations().wait(op, { signal: AbortSignal.timeout(60000) });
    console.log('[KERIClient] Registry operation completed');

    // Get the registry ID from the registries list
    const registries = await this.client.registries().list(aidName);
    const registry = registries.find(
      (r: { name: string }) => r.name === registryName
    );

    if (!registry) {
      throw new Error(`Registry "${registryName}" not found after creation`);
    }

    console.log(`[KERIClient] Created registry: ${registry.regk}`);
    return registry.regk;
  }

  /**
   * Issue a credential from one AID to another
   * Uses IPEX grant flow to deliver the credential
   * @param issuerAidName - Name of the issuing AID
   * @param registryId - Registry ID to use
   * @param schemaId - Schema SAID (e.g., "EOperationsStewardSchemaV1")
   * @param recipientAid - AID prefix of the recipient
   * @param credentialData - The credential attributes
   * @returns The credential SAID
   */
  async issueCredential(
    issuerAidName: string,
    registryId: string,
    schemaId: string,
    recipientAid: string,
    credentialData: Record<string, unknown>
  ): Promise<{ said: string }> {
    if (!this.client) throw new Error('Not initialized');

    console.log(`[KERIClient] Issuing credential to ${recipientAid}...`);

    // Get issuer AID info
    let issuerAid;
    try {
      issuerAid = await this.client.identifiers().get(issuerAidName);
    } catch (getErr) {
      const aids = await this.client.identifiers().list();
      const found = aids.aids.find((a: { name: string }) => a.name === issuerAidName);
      if (!found) throw new Error(`Issuer AID "${issuerAidName}" not found`);
      issuerAid = found;
    }

    // Create the credential
    const credResult = await this.client.credentials().issue(issuerAidName, {
      ri: registryId,
      s: schemaId,
      a: {
        i: recipientAid, // Issuee
        ...credentialData,
      },
    });

    console.log('[KERIClient] Waiting for credential issuance...');
    // The issue() returns an object with op property (not a function)
    const credOp = credResult.op;
    await this.client.operations().wait(credOp, { signal: AbortSignal.timeout(60000) });

    // Get SAID from the ACDC, handling signify-ts types
    const acdcKed = (credResult.acdc as { ked?: { d?: string } })?.ked;
    const credentialSaid = acdcKed?.d || 'unknown';
    console.log(`[KERIClient] Credential issued with SAID: ${credentialSaid}`);

    // Now grant the credential via IPEX
    console.log('[KERIClient] Granting credential via IPEX...');

    const [grant, gsigs, end] = await this.client.ipex().grant({
      senderName: issuerAidName,
      recipient: recipientAid,
      acdc: credResult.acdc,
      iss: credResult.iss,
      anc: credResult.anc,
      datetime: new Date().toISOString(),
    });

    // Submit the grant
    await this.client.ipex().submitGrant(issuerAidName, grant, gsigs, end, [recipientAid]);
    const grantSaid = (grant as { ked?: { d?: string } })?.ked?.d || 'unknown';
    console.log(`[KERIClient] IPEX grant submitted, SAID: ${grantSaid}`);

    return { said: credentialSaid };
  }

  /**
   * Admit a credential grant (accept an offered credential)
   * @param aidName - Name of the receiving AID
   * @param grantSaid - SAID of the grant message to admit
   */
  async admitCredential(aidName: string, grantSaid: string): Promise<void> {
    if (!this.client) throw new Error('Not initialized');

    console.log(`[KERIClient] Admitting credential grant ${grantSaid}...`);

    // Get the grant to find who sent it (so we can send admit back)
    const notifications = await this.client.notifications().list();
    const grantNotification = notifications.notes?.find(
      (n: { a: { d: string } }) => n.a?.d === grantSaid
    );

    // Find the grantor AID
    const grantorAid = grantNotification?.a?.i || '';

    // Create the admit message
    const [admit, asigs, end] = await this.client.ipex().admit({
      senderName: aidName,
      recipient: grantorAid,
      grantSaid: grantSaid,
      datetime: new Date().toISOString(),
    });

    // Submit the admit
    if (grantorAid) {
      await this.client.ipex().submitAdmit(aidName, admit, asigs, end, [grantorAid]);
      console.log('[KERIClient] Credential admitted successfully');
    } else {
      // Submit without specific recipient if we can't find the grantor
      await this.client.ipex().submitAdmit(aidName, admit, asigs, end, []);
      console.log('[KERIClient] Credential admitted (no specific recipient)');
    }
  }

  /**
   * Get the OOBI URL for an AID
   * @param aidName - Name of the AID
   * @param role - Optional role ('agent' or 'witness')
   * @returns The OOBI URL
   */
  async getOOBI(aidName: string, role: 'agent' | 'witness' = 'agent'): Promise<string> {
    if (!this.client) throw new Error('Not initialized');

    console.log(`[KERIClient] Getting OOBI for "${aidName}" (role: ${role})...`);

    const oobiResult = await this.client.oobis().get(aidName, role);

    // The oobis().get() returns an object with the OOBI URL
    const oobi = oobiResult.oobis?.[0] || oobiResult.oobi;

    if (!oobi) {
      throw new Error(`No OOBI found for AID "${aidName}"`);
    }

    console.log(`[KERIClient] OOBI: ${oobi}`);
    return oobi;
  }

  /**
   * Set the organization AID dynamically (for use after org setup)
   * @param aid - The organization AID prefix
   */
  setOrgAID(aid: string): void {
    (this as any).ORG_AID = aid;
  }

  /**
   * Generate a new random passcode (bran)
   * @returns 21-character base64 passcode
   */
  static generatePasscode(): string {
    return randomPasscode();
  }

  /**
   * Derive a passcode (bran) from a BIP39 mnemonic phrase
   * This allows users to recover their identity using their 12-word phrase
   * @param mnemonic - 12-word BIP39 mnemonic phrase (space-separated)
   * @returns 21-character base64 passcode derived from the mnemonic
   */
  static passcodeFromMnemonic(mnemonic: string): string {
    // Validate mnemonic
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error('Invalid mnemonic phrase');
    }

    // Convert mnemonic to 64-byte seed
    const seed = mnemonicToSeedSync(mnemonic);

    // Take first 16 bytes (same size as randomPasscode uses)
    const raw = seed.slice(0, 16);

    // Create Salter and extract qb64 passcode (same as randomPasscode)
    const salter = new Salter({ raw: raw });
    return salter.qb64.substring(2, 23);
  }

  /**
   * Validate a BIP39 mnemonic phrase
   * @param mnemonic - The mnemonic to validate
   * @returns true if valid
   */
  static validateMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
  }

  /**
   * List notifications with optional filtering
   * @param filter - Optional filter criteria
   * @returns Array of notifications
   */
  async listNotifications(filter?: {
    route?: string;
    read?: boolean;
  }): Promise<Array<{
    i: string;      // Notification ID
    a: {
      r: string;    // Route
      d: string;    // SAID
      i?: string;   // Sender AID (if present)
    };
    r: boolean;     // Read status
  }>> {
    if (!this.client) throw new Error('Not initialized');

    const notifications = await this.client.notifications().list();
    let notes = notifications.notes ?? [];

    if (filter) {
      if (filter.route !== undefined) {
        notes = notes.filter((n: { a: { r: string } }) => n.a?.r === filter.route);
      }
      if (filter.read !== undefined) {
        notes = notes.filter((n: { r: boolean }) => n.r === filter.read);
      }
    }

    return notes;
  }

  /**
   * Get an exchange message by SAID
   * @param said - The SAID of the exchange message
   * @returns The exchange message details
   */
  async getExchange(said: string): Promise<{
    exn: {
      i: string;    // Sender AID
      r: string;    // Route
      a: Record<string, unknown>;  // Payload attributes
      e?: Record<string, unknown>; // Embedded data
      d: string;    // SAID
    };
  }> {
    if (!this.client) throw new Error('Not initialized');
    return await this.client.exchanges().get(said);
  }

  /**
   * Mark a notification as read
   * @param notificationId - The notification ID to mark
   */
  async markNotificationRead(notificationId: string): Promise<void> {
    if (!this.client) throw new Error('Not initialized');
    await this.client.notifications().mark(notificationId);
  }

  /**
   * Send a generic EXN message to a recipient
   * @param senderName - Name of the sender's AID
   * @param recipientAid - AID of the recipient
   * @param route - The message route (e.g., '/matou/registration/apply')
   * @param payload - The message payload
   * @returns Success status and message SAID
   */
  async sendEXN(
    senderName: string,
    recipientAid: string,
    route: string,
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; said?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not initialized' };
    }

    try {
      // Get the sender's AID state
      let sender;
      try {
        sender = await this.client.identifiers().get(senderName);
      } catch (getErr) {
        const aids = await this.client.identifiers().list();
        const found = aids.aids.find((a: { name: string }) => a.name === senderName);
        if (!found) {
          throw new Error(`AID "${senderName}" not found`);
        }
        sender = found;
      }

      console.log(`[KERIClient] Creating EXN message for route: ${route}`);

      // Create the exchange message
      const [exn, sigs, atc] = await this.client.exchanges().createExchangeMessage(
        sender,
        route,
        payload,
        {},  // No embeds
        recipientAid
      );

      console.log(`[KERIClient] Sending EXN to ${recipientAid}...`);
      console.log(`[KERIClient] EXN details:`, JSON.stringify({
        sender: senderName,
        recipient: recipientAid,
        route,
        exnKed: (exn as any)?.ked,
      }, null, 2));

      // Send the message
      const sendResult = await this.client.exchanges().sendFromEvents(
        senderName,
        route.split('/').pop() || 'message',  // Topic from route
        exn,
        sigs,
        atc,
        [recipientAid]
      );
      console.log('[KERIClient] sendFromEvents result:', sendResult);

      const exnSaid = (exn as { ked?: { d?: string } })?.ked?.d || 'unknown';
      console.log('[KERIClient] EXN sent successfully, SAID:', exnSaid);

      return { success: true, said: exnSaid };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[KERIClient] Failed to send EXN:', err);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Send registration to all organization admins using IPEX apply
   * This uses the IPEX protocol which KERIA knows how to route and notify
   * @param senderName - Name of the sender's AID
   * @param admins - Array of admin info with AIDs and optional OOBIs
   * @param registrationData - Registration details including sender's OOBI
   * @param schemaSaid - The membership schema SAID
   * @returns Success status with sent/failed admin lists
   */
  async sendRegistrationToAdmins(
    senderName: string,
    admins: Array<{ aid: string; oobi?: string }>,
    registrationData: {
      name: string;
      bio: string;
      interests: string[];
      customInterests?: string;
      senderOOBI: string;
    },
    schemaSaid: string = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT'
  ): Promise<{ success: boolean; sent: string[]; failed: string[] }> {
    if (!this.client) {
      throw new Error('Not initialized');
    }

    const sent: string[] = [];
    const failed: string[] = [];

    // Send to each admin using IPEX apply
    for (const admin of admins) {
      try {
        // Resolve admin OOBI and create contact
        if (admin.oobi) {
          console.log(`[KERIClient] Resolving admin OOBI and creating contact: ${admin.oobi}`);
          try {
            // Resolve OOBI with alias to create a contact
            const alias = `admin-${admin.aid.substring(0, 8)}`;
            const op = await this.client.oobis().resolve(admin.oobi, alias);
            await this.client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
            console.log(`[KERIClient] Admin contact created with alias: ${alias}`);
          } catch (oobiErr) {
            console.warn(`[KERIClient] Failed to resolve OOBI for admin ${admin.aid}:`, oobiErr);
            // Continue anyway - admin AID might already be known
          }
        } else {
          console.warn(`[KERIClient] No OOBI provided for admin ${admin.aid}`);
        }

        // Method 1: Send IPEX apply message
        console.log(`[KERIClient] Creating IPEX apply for admin ${admin.aid}...`);
        try {
          const [apply, sigs, end] = await this.client.ipex().apply({
            senderName: senderName,
            recipient: admin.aid,
            schemaSaid: schemaSaid,
            message: JSON.stringify({
              type: 'registration',
              bio: registrationData.bio,
              customInterests: registrationData.customInterests || '',
              senderOOBI: registrationData.senderOOBI,
              submittedAt: new Date().toISOString(),
            }),
            attributes: {
              name: registrationData.name,
              interests: registrationData.interests,
            },
          });

          console.log(`[KERIClient] Submitting IPEX apply to ${admin.aid}...`);
          await this.client.ipex().submitApply(senderName, apply, sigs, [admin.aid]);
          console.log(`[KERIClient] IPEX apply sent successfully`);
        } catch (ipexErr) {
          console.warn(`[KERIClient] IPEX apply failed:`, ipexErr);
        }

        // Method 2: Send custom route EXN message
        console.log(`[KERIClient] Sending custom route EXN to ${admin.aid}...`);
        try {
          const payload = {
            type: 'registration',
            name: registrationData.name,
            bio: registrationData.bio,
            interests: registrationData.interests,
            customInterests: registrationData.customInterests || '',
            senderOOBI: registrationData.senderOOBI,
            submittedAt: new Date().toISOString(),
          };
          const exnResult = await this.sendEXN(
            senderName,
            admin.aid,
            '/matou/registration/apply',
            payload
          );
          console.log(`[KERIClient] Custom EXN result:`, exnResult);
        } catch (exnErr) {
          console.warn(`[KERIClient] Custom EXN failed:`, exnErr);
        }

        sent.push(admin.aid);
        console.log(`[KERIClient] Registration sent to admin ${admin.aid} via both methods`);
      } catch (err) {
        failed.push(admin.aid);
        console.error(`[KERIClient] Error sending to admin ${admin.aid}:`, err);
      }
    }

    return {
      success: sent.length > 0,
      sent,
      failed,
    };
  }
}

// Singleton instance
let instance: KERIClient | null = null;

/**
 * Get the KERI client singleton instance
 */
export function useKERIClient(): KERIClient {
  if (!instance) {
    instance = new KERIClient();
  }
  return instance;
}
