/**
 * Real KERI Client using signify-ts
 * Connects to KERIA agent for AID management
 */
import { SignifyClient, Tier, randomPasscode, ready } from 'signify-ts';

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

  // KERIA endpoints
  // Note: KERIA needs to be configured with CORS or use a reverse proxy in production
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
   * Generate a new random passcode (bran)
   * @returns 21-character base64 passcode
   */
  static generatePasscode(): string {
    return randomPasscode();
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
