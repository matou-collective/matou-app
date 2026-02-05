/**
 * Real KERI Client using signify-ts
 * Connects to KERIA agent for AID management
 */
import { SignifyClient, Tier, randomPasscode, ready, Salter } from 'signify-ts';
import { mnemonicToSeedSync, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { fetchClientConfig, type ClientConfig } from '../clientConfig';

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

// Cached client config (fetched once at startup)
let clientConfig: ClientConfig | null = null;

/**
 * Initialize client configuration from config server
 * Should be called early in app startup (e.g., in boot/keri.ts)
 */
export async function initKeriConfig(): Promise<ClientConfig> {
  if (!clientConfig) {
    clientConfig = await fetchClientConfig();
  }
  return clientConfig;
}

/**
 * Get KERIA URLs from cached config or defaults
 */
function getKeriaUrls() {
  return {
    adminUrl: clientConfig?.keri.admin_url || 'http://localhost:3901',
    bootUrl: clientConfig?.keri.boot_url || 'http://localhost:3903',
    cesrUrl: clientConfig?.keri.cesr_url || 'http://localhost:3902',
  };
}

/**
 * KERI client wrapper using signify-ts
 * Keys never leave device - this is a core security principle
 */
export class KERIClient {
  private client: SignifyClient | null = null;
  private connected = false;

  // KERIA endpoints - fetched from config server
  private get keriaUrl(): string {
    return getKeriaUrls().adminUrl;
  }
  private get keriaBootUrl(): string {
    return getKeriaUrls().bootUrl;
  }
  private get cesrUrl(): string {
    return getKeriaUrls().cesrUrl;
  }
  // Docker internal URL no longer needed - KERIA resolves internally
  private readonly dockerCesrUrl = '';

  /**
   * Create a standalone SignifyClient for a separate KERIA agent.
   * Does NOT touch the singleton useKERIClient() instance.
   * Used by admin to operate on an invitee's agent while staying connected to their own.
   * @param bran - The passcode (21-character base64 string) for the new agent
   * @returns A connected SignifyClient instance
   */
  static async createEphemeralClient(bran: string): Promise<SignifyClient> {
    const urls = getKeriaUrls();
    const keriaUrl = urls.adminUrl;
    const bootUrl = urls.bootUrl;

    await ready();
    const client = new SignifyClient(keriaUrl, bran, Tier.low, bootUrl);

    try {
      await client.connect();
      console.log('[KERIClient] Ephemeral client connected to existing agent');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('agent does not exist')) {
        console.log('[KERIClient] Ephemeral agent not found, booting...');
        await client.boot();
        await client.connect();
        console.log('[KERIClient] Ephemeral agent booted and connected');
      } else {
        throw err;
      }
    }

    // Resolve witness OOBIs from KERIA config
    try {
      const config = await client.config().get();
      if (config.iurls && Array.isArray(config.iurls) && config.iurls.length > 0) {
        console.log(`[KERIClient] Resolving ${config.iurls.length} witness OOBIs for ephemeral client...`);
        for (let i = 0; i < config.iurls.length; i++) {
          let iurl = config.iurls[i];
          try {
            if (iurl.endsWith('/controller')) {
              iurl = iurl.replace('/controller', '');
            }
            const alias = `wit${i}`;
            const op = await client.oobis().resolve(iurl, alias);
            await client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
          } catch (resolveErr) {
            console.warn(`[KERIClient] Failed to resolve witness OOBI ${iurl}:`, resolveErr);
          }
        }
      }
    } catch (configErr) {
      console.warn('[KERIClient] Could not fetch KERIA config for ephemeral client:', configErr);
    }

    return client;
  }

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
   * Rotate the keys of an AID
   * Performs a key rotation event, which generates new signing keys and
   * promotes the pre-rotation keys. Witnesses must acknowledge the rotation.
   * @param name - The AID name to rotate
   * @returns Updated AID info with new key state
   */
  async rotateKeys(name: string): Promise<AIDInfo> {
    if (!this.client) throw new Error('Not initialized');

    console.log(`[KERIClient] Rotating keys for AID "${name}"...`);
    const result = await this.client.identifiers().rotate(name);
    const op = await result.op();
    await this.client.operations().wait(op, { signal: AbortSignal.timeout(180000) });
    console.log(`[KERIClient] Key rotation completed for "${name}"`);

    const aid = await this.client.identifiers().get(name);
    return {
      prefix: aid.prefix,
      name: aid.name,
      state: aid.state,
    };
  }

  /**
   * Rotate the agent passcode (bran) and reconnect.
   * After rotation the old SignifyClient connection is stale, so we
   * re-create and reconnect with the new passcode.
   *
   * Fetches all AID objects internally because signify-ts requires
   * full AID records (with salty/randy key management info) for re-encryption.
   *
   * @param newBran - The new passcode (21-character base64 string)
   */
  async rotateAgentPasscode(newBran: string): Promise<void> {
    if (!this.client) throw new Error('Not initialized');

    console.log('[KERIClient] Rotating agent passcode...');
    // Fetch full AID objects via get() — list() returns simplified records
    // that may lack `state` and `salty`/`randy` fields required by controller.rotate()
    const listResult = await this.client.identifiers().list();
    const aids = await Promise.all(
      listResult.aids.map((a: { name: string }) => this.client!.identifiers().get(a.name))
    );
    const res = await this.client.rotate(newBran, aids);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Agent passcode rotation failed (${res.status}): ${body}`);
    }
    // After client.rotate(), the controller state is updated in-place:
    // - controller.signer/nsigner use the new bran's keys
    // - authn is recreated with the new signer (via our signify-ts patch)
    // Do NOT create a new SignifyClient — a new bran would derive a different
    // controller prefix, which KERIA wouldn't recognize.
    console.log('[KERIClient] Agent passcode rotated successfully');
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
    return `${this.cesrUrl}/oobi/${this.ORG_AID}`;
  }

  /**
   * Convert a browser-facing OOBI URL to Docker-internal URL for KERIA resolution.
   * KERIA runs inside Docker and can't reach localhost:4902 — it needs keria:3902.
   * getOOBI() normalizes keria:3902 → localhost:4902 for browsers; this reverses it.
   */
  private toInternalOobiUrl(oobi: string): string {
    if (this.dockerCesrUrl && this.cesrUrl) {
      return oobi.replace(this.cesrUrl, this.dockerCesrUrl);
    }
    return oobi;
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
      const internalOobi = this.toInternalOobiUrl(oobi);
      console.log(`[KERIClient] Resolving OOBI: ${internalOobi}`);
      const op = await this.client.oobis().resolve(internalOobi, alias);
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

    // Add agent end role so the group AID's OOBI can be served via KERIA.
    // Without this, oobis().get(name, 'agent') returns nothing, and other
    // agents can't resolve the org AID's key state for grant verification.
    const agentId = this.client.agent?.pre;
    if (agentId) {
      try {
        const endRoleResult = await this.client.identifiers().addEndRole(name, 'agent', agentId);
        const endRoleOp = await endRoleResult.op();
        await this.client.operations().wait(endRoleOp, { signal: AbortSignal.timeout(30000) });
        console.log(`[KERIClient] Agent end role added to group AID "${name}"`);
      } catch (err) {
        console.warn(`[KERIClient] Failed to add agent end role to group AID:`, err);
      }
    }

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
    credentialData: Record<string, unknown>,
    grantMessage?: string
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
      message: grantMessage || '',
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

    // Get the grant exchange message to find the sender
    const grantExn = await this.client.exchanges().get(grantSaid);
    const grantorAid = grantExn.exn.i;

    // Submit admit with empty embeds. KERIA's sendAdmit() for single-sig
    // AIDs does not process path labels — the Admitter background task
    // retrieves ACDC/ISS/ANC data from the GRANT's cloned attachments.
    const hab = await this.client.identifiers().get(aidName);
    const [admit, asigs, end] = await this.client.exchanges().createExchangeMessage(
      hab,
      '/ipex/admit',
      { m: '' },
      {},
      grantorAid,
      undefined,
      grantSaid,
    );

    // Submit the admit
    if (grantorAid) {
      await this.client.ipex().submitAdmit(aidName, admit, asigs, end, [grantorAid]);
      console.log('[KERIClient] Credential admitted successfully');
    } else {
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
    let oobi = oobiResult.oobis?.[0] || oobiResult.oobi;

    if (!oobi) {
      throw new Error(`No OOBI found for AID "${aidName}"`);
    }

    // Normalize KERIA Docker hostname to localhost for browser access
    oobi = oobi.replace(/http:\/\/keria:(\d+)/, () => {
      return getKeriaUrls().cesrUrl;
    });

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
   * Encode a BIP39 mnemonic as a compact invite code (base64url of entropy).
   * The invite code encodes the mnemonic's 128-bit entropy as a 22-character
   * URL-safe string. The mnemonic can be recovered via mnemonicFromInviteCode().
   * @param mnemonic - 12-word BIP39 mnemonic phrase
   * @returns 22-character base64url invite code
   */
  static inviteCodeFromMnemonic(mnemonic: string): string {
    const entropy = mnemonicToEntropy(mnemonic, wordlist); // Uint8Array(16)
    const binString = String.fromCharCode(...entropy);
    return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /**
   * Decode an invite code back to a BIP39 mnemonic.
   * Reverse of inviteCodeFromMnemonic().
   * @param inviteCode - 22-character base64url invite code
   * @returns 12-word BIP39 mnemonic phrase
   */
  static mnemonicFromInviteCode(inviteCode: string): string {
    const padded = inviteCode.replace(/-/g, '+').replace(/_/g, '/');
    const binString = atob(padded);
    const entropy = new Uint8Array([...binString].map(c => c.charCodeAt(0)));
    return entropyToMnemonic(entropy, wordlist);
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
   * Send registration to all organization admins
   * Uses BOTH custom EXN (for our patch to create pending notifications) and IPEX apply (native support)
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
      email?: string;
      bio: string;
      location?: string;
      joinReason?: string;
      indigenousCommunity?: string;
      facebookUrl?: string;
      linkedinUrl?: string;
      twitterUrl?: string;
      instagramUrl?: string;
      interests: string[];
      customInterests?: string;
      avatarFileRef?: string;
      avatarData?: string;
      avatarMimeType?: string;
      senderOOBI: string;
    },
    schemaSaid: string = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT'
  ): Promise<{ success: boolean; sent: string[]; failed: string[] }> {
    if (!this.client) {
      throw new Error('Not initialized');
    }

    const sent: string[] = [];
    const failed: string[] = [];

    // Send to each admin
    for (const admin of admins) {
      try {
        // Resolve admin OOBI and create contact (critical for message delivery)
        if (admin.oobi) {
          const internalOobi = this.toInternalOobiUrl(admin.oobi);
          console.log(`[KERIClient] Resolving admin OOBI and creating contact: ${internalOobi}`);
          const alias = `admin-${admin.aid.substring(0, 8)}`;
          let oobiResolved = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const op = await this.client.oobis().resolve(internalOobi, alias);
              await this.client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
              console.log(`[KERIClient] Admin contact created with alias: ${alias}`);
              oobiResolved = true;
              break;
            } catch (oobiErr) {
              console.warn(`[KERIClient] OOBI attempt ${attempt}/3 failed for admin ${admin.aid}:`, oobiErr);
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          }
          if (!oobiResolved) {
            console.error(`[KERIClient] All OOBI attempts failed for admin ${admin.aid}, skipping`);
            failed.push(admin.aid);
            continue;
          }
        } else {
          console.warn(`[KERIClient] No OOBI provided for admin ${admin.aid}`);
          failed.push(admin.aid);
          continue;
        }

        // 1. Send custom EXN message first
        // Our KERIA patch creates pending notifications for escrowed custom EXN messages
        console.log(`[KERIClient] Sending registration EXN to ${admin.aid}...`);
        const payload = {
          type: 'registration',
          name: registrationData.name,
          email: registrationData.email || '',
          bio: registrationData.bio,
          location: registrationData.location || '',
          joinReason: registrationData.joinReason || '',
          indigenousCommunity: registrationData.indigenousCommunity || '',
          facebookUrl: registrationData.facebookUrl || '',
          linkedinUrl: registrationData.linkedinUrl || '',
          twitterUrl: registrationData.twitterUrl || '',
          instagramUrl: registrationData.instagramUrl || '',
          interests: registrationData.interests,
          customInterests: registrationData.customInterests || '',
          avatarFileRef: registrationData.avatarFileRef || '',
          avatarData: registrationData.avatarData || '',
          avatarMimeType: registrationData.avatarMimeType || '',
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

        // 2. Also send IPEX apply for native KERIA notification support
        // This provides a backup notification mechanism
        try {
          console.log(`[KERIClient] Sending IPEX apply to ${admin.aid}...`);
          const [apply, applySigs, applyEnd] = await this.client.ipex().apply({
            senderName: senderName,
            recipient: admin.aid,
            schema: schemaSaid,
            attributes: {
              name: registrationData.name,
              email: registrationData.email || '',
              bio: registrationData.bio,
              location: registrationData.location || '',
              joinReason: registrationData.joinReason || '',
              indigenousCommunity: registrationData.indigenousCommunity || '',
              facebookUrl: registrationData.facebookUrl || '',
              linkedinUrl: registrationData.linkedinUrl || '',
              twitterUrl: registrationData.twitterUrl || '',
              instagramUrl: registrationData.instagramUrl || '',
              interests: registrationData.interests,
              customInterests: registrationData.customInterests || '',
              avatarFileRef: registrationData.avatarFileRef || '',
              avatarData: registrationData.avatarData || '',
              avatarMimeType: registrationData.avatarMimeType || '',
              senderOOBI: registrationData.senderOOBI,
              submittedAt: new Date().toISOString(),
            },
            datetime: new Date().toISOString(),
          });
          await this.client.ipex().submitApply(senderName, apply, applySigs, applyEnd, [admin.aid]);
          const applySaid = (apply as { ked?: { d?: string } })?.ked?.d || 'unknown';
          console.log(`[KERIClient] IPEX apply sent, SAID: ${applySaid}`);
        } catch (ipexErr) {
          console.warn(`[KERIClient] IPEX apply failed (continuing with EXN):`, ipexErr);
          // Continue - custom EXN is the primary mechanism
        }

        sent.push(admin.aid);
        console.log(`[KERIClient] Registration sent to admin ${admin.aid}`);
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
