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
  private oobisResolved = false;
  private oobiResolutionPromise: Promise<void> | null = null;

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

    // Start resolving witness OOBIs in the background
    // Store the promise so createAID can wait for it
    this.oobiResolutionPromise = this.resolveWitnessOOBIs()
      .then(() => {
        this.oobisResolved = true;
      })
      .catch((err) => {
        console.warn('[KERIClient] Background OOBI resolution failed:', err);
        // Still mark as resolved so createAID can try (might fail with witness errors)
        this.oobisResolved = true;
      });
  }

  /**
   * Resolve OOBIs for the configured witnesses
   * This is needed before creating AIDs with witness backing
   */
  private async resolveWitnessOOBIs(): Promise<void> {
    if (!this.client) return;

    // Use Docker internal hostnames as KERIA can resolve these
    // These match the KERIA_IURLS environment variable
    const witnessOOBIs = [
      'http://witness1:5643/oobi',
      'http://witness2:5645/oobi',
      'http://witness3:5647/oobi',
    ];

    console.log('[KERIClient] Resolving witness OOBIs...');

    for (const oobi of witnessOOBIs) {
      try {
        // oobis().resolve() returns an operation that we need to wait for
        const op = await this.client.oobis().resolve(oobi);
        // Wait for the operation to complete
        await this.client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
        console.log(`[KERIClient] Resolved OOBI: ${oobi}`);
      } catch (err) {
        console.warn(`[KERIClient] Failed to resolve OOBI ${oobi}:`, err);
      }
    }

    console.log('[KERIClient] Witness OOBIs resolved');
  }

  /**
   * Create a new AID (Autonomic Identifier)
   * @param name - Human-readable name for the AID
   * @returns The created AID info
   */
  async createAID(name: string): Promise<AIDInfo> {
    if (!this.client) throw new Error('Not initialized');

    // Note: For witness-backed AIDs, we would need to wait for OOBI resolution
    // and use the witness AIDs. For dev/testing, we create AIDs without witnesses.
    // Witness AIDs (for reference):
    // - BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM (witness1:5643)
    // - BM35JN8XeJSEfpxopjn5jr7tAHCE5749f0OobhMLCorE (witness2:5645)
    // - BF2rZTW79z4IXocYRQnjjsOuvFUQv-ptCf8Yltd7PfsM (witness3:5647)

    // Try creating AID without witnesses first (faster for development)
    // In production, use witness-backed AIDs
    console.log('[KERIClient] Creating AID (without witnesses for faster dev)...');
    const result = await this.client.identifiers().create(name);

    console.log('[KERIClient] Waiting for AID operation to complete...');
    const op = await result.op();
    await this.client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
    console.log('[KERIClient] AID operation completed');

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
