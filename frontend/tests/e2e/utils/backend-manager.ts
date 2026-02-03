/**
 * Multi-backend manager for per-user E2E tests.
 *
 * In per-user mode, each user needs their own Go backend instance with a
 * separate data directory (identity.json, peer.key, anystore DB). This
 * manager spawns and manages additional backend processes for test users.
 *
 * The admin backend (port 9080) is expected to be started manually before
 * tests run (`cd backend && MATOU_ENV=test go run ./cmd/server`). This
 * manager handles spawning extra user backends on ports 9081+.
 *
 * Usage:
 *   const backends = new BackendManager();
 *   const user = await backends.start('user1');
 *   // user.port, user.url, user.dataDir
 *   await backends.stopAll();
 */
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface BackendInstance {
  name: string;
  port: number;
  dataDir: string;
  url: string;
  process: ChildProcess;
}

export class BackendManager {
  private instances = new Map<string, BackendInstance>();
  private backendDir: string;
  private nextPort: number;

  constructor(startPort = 9180) {
    this.backendDir = path.resolve(__dirname, '..', '..', '..', '..', 'backend');
    this.nextPort = startPort;
  }

  /**
   * Start a new backend instance for a test user.
   *
   * @param name  - Unique name for this instance (used for data dir and logging)
   * @param port  - Optional port number (auto-assigned from 9081+ if omitted)
   * @returns The running backend instance
   */
  async start(name: string, port?: number): Promise<BackendInstance> {
    if (this.instances.has(name)) {
      return this.instances.get(name)!;
    }

    const assignedPort = port ?? this.nextPort++;
    const dataDir = path.join(this.backendDir, `data-test-${name}`);

    // Clean and create data directory for a fresh start
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true });
    }
    fs.mkdirSync(dataDir, { recursive: true });

    // Prefer pre-built binary, fall back to `go run`
    const binaryPath = path.join(this.backendDir, 'bin', 'server');
    const useGoBuild = fs.existsSync(binaryPath);

    const cmd = useGoBuild ? binaryPath : 'go';
    const args = useGoBuild ? [] : ['run', './cmd/server'];

    console.log(
      `[BackendManager] Starting '${name}' on port ${assignedPort}` +
        ` (${useGoBuild ? 'binary' : 'go run'})...`,
    );

    const proc = spawn(cmd, args, {
      cwd: this.backendDir,
      env: {
        ...process.env,
        MATOU_ENV: 'test',
        MATOU_SERVER_PORT: String(assignedPort),
        MATOU_DATA_DIR: dataDir,
        MATOU_ANYSYNC_CONFIG: path.join(this.backendDir, 'config', 'client.yml'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      if (process.env.TEST_VERBOSE === '1') {
        console.log(`[Backend:${name}] ${data.toString().trimEnd()}`);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      console.error(`[Backend:${name}:err] ${data.toString().trimEnd()}`);
    });

    proc.on('exit', (code) => {
      console.log(`[BackendManager] '${name}' exited with code ${code}`);
    });

    const url = `http://localhost:${assignedPort}`;
    const instance: BackendInstance = { name, port: assignedPort, dataDir, url, process: proc };
    this.instances.set(name, instance);

    // Wait for health check to pass
    await this.waitForHealth(assignedPort, name);
    console.log(`[BackendManager] '${name}' ready on port ${assignedPort}`);

    return instance;
  }

  /** Get a running instance by name. */
  get(name: string): BackendInstance | undefined {
    return this.instances.get(name);
  }

  /** Get the URL for a named instance. Throws if not found. */
  getUrl(name: string): string {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`No backend instance named '${name}'`);
    return instance.url;
  }

  /** Stop a specific backend instance. */
  async stop(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) return;

    console.log(`[BackendManager] Stopping '${name}'...`);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        instance.process.kill('SIGKILL');
        resolve();
      }, 5000);

      instance.process.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      instance.process.kill('SIGTERM');
    });

    this.instances.delete(name);
  }

  /** Stop all managed backend instances. */
  async stopAll(): Promise<void> {
    const names = [...this.instances.keys()];
    await Promise.all(names.map((name) => this.stop(name)));
  }

  /** Clean up data directories for all managed instances. */
  cleanupData(): void {
    // Clean any data-test-* directories even if the instances were already stopped
    const entries = fs.readdirSync(this.backendDir);
    for (const entry of entries) {
      if (entry.startsWith('data-test-') && entry !== 'data-test') {
        const fullPath = path.join(this.backendDir, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          fs.rmSync(fullPath, { recursive: true });
          console.log(`[BackendManager] Cleaned up ${entry}`);
        }
      }
    }
  }

  private async waitForHealth(port: number, name: string, maxAttempts = 60): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await fetch(`http://localhost:${port}/health`);
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Backend '${name}' on port ${port} did not become healthy within 30s`);
  }
}
