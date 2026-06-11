<template>
  <div class="infra-page">
    <!-- Header -->
    <div class="infra-header">
      <div class="header-left">
        <h1 class="header-title">Infrastructure</h1>
        <p class="header-subtitle">Live health status of all Matou services</p>
      </div>
      <div class="header-right">
        <span class="last-updated">{{ lastUpdatedText }}</span>
        <button class="refresh-btn" @click="refresh" :disabled="loading">
          <RefreshCw :size="15" :class="{ spinning: loading }" />
          Refresh
        </button>
        <div class="env-badge">{{ envLabel }}</div>
      </div>
    </div>

    <!-- Status summary bar -->
    <div class="summary-bar">
      <div v-for="s in summaryStats" :key="s.label" class="summary-item">
        <span class="summary-dot" :class="`dot-${s.color}`"></span>
        <span class="summary-count">{{ s.count }}</span>
        <span class="summary-label">{{ s.label }}</span>
      </div>
    </div>

    <!-- Main content -->
    <div class="infra-body" :class="{ 'panel-open': !!selectedId }">
      <!-- Graph -->
      <div class="graph-wrap">
        <svg viewBox="0 0 1060 480" class="infra-svg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <!-- Arrow marker -->
            <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="var(--edge-color, rgba(30,95,116,0.35))" />
            </marker>
            <!-- Glow filter for selected -->
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>

          <!-- Group: KERI -->
          <rect x="22" y="115" width="290" height="320" rx="14" class="group-box keri-group" />
          <text x="167" y="136" class="group-label">KERI</text>

          <!-- Group: any-sync -->
          <rect x="672" y="95" width="375" height="370" rx="14" class="group-box anysync-group" />
          <text x="859" y="116" class="group-label">any-sync</text>

          <!-- ── Edges ── -->
          <g class="edges">
            <!-- Frontend ↔ Backend -->
            <path :d="bezier(480,107,480,237)" class="edge" :class="edgeCls('backend')" />
            <!-- Frontend → Config Server -->
            <path :d="bezier(435,88,145,188)" class="edge" :class="edgeCls('configServer')" />
            <!-- Frontend → KERIA (signify-ts uses admin + cesr) -->
            <path :d="bezier(448,95,280,188)" class="edge" :class="edgeCls('keria')" />
            <!-- Frontend → Coordinator (any-sync client) -->
            <path :d="bezier(526,88,778,183)" class="edge" :class="edgeCls('coordinator')" />
            <!-- Backend → KERIA -->
            <path :d="bezier(435,258,294,230)" class="edge" :class="edgeCls('keria')" />
            <!-- Backend → Coordinator -->
            <path :d="bezier(526,260,752,215)" class="edge" :class="edgeCls('coordinator')" />
            <!-- KERIA → Schema Server -->
            <path :d="bezier(265,248,165,318)" class="edge edge-internal" :class="edgeCls('schemaServer')" />
            <!-- KERIA → Witnesses -->
            <path :d="bezier(280,248,280,318)" class="edge edge-internal" :class="edgeCls('witnesses')" />
            <!-- Config Server → KERIA (provides urls) -->
            <path :d="bezier(188,213,250,213)" class="edge edge-internal" :class="edgeCls('keria')" />
            <!-- Coordinator → SyncNode -->
            <path :d="bezier(820,200,896,176)" class="edge edge-internal" :class="edgeCls('syncNode')" />
            <!-- Coordinator → ConsensusNode -->
            <path :d="bezier(840,212,992,212)" class="edge edge-internal" :class="edgeCls('consensusNode')" />
            <!-- Coordinator → FileNode -->
            <path :d="bezier(818,226,896,278)" class="edge edge-internal" :class="edgeCls('fileNode')" />
            <!-- Coordinator → MongoDB -->
            <path :d="bezier(784,240,784,358)" class="edge edge-internal" :class="edgeCls('mongodb')" />
            <!-- FileNode → Redis -->
            <path :d="bezier(916,305,916,368)" class="edge edge-internal" :class="edgeCls('redis')" />
            <!-- FileNode → MinIO -->
            <path :d="bezier(952,290,1008,278)" class="edge edge-internal" :class="edgeCls('minio')" />
          </g>

          <!-- ── Nodes ── -->
          <!-- Frontend -->
          <g class="node" :class="nodeCls('frontend')" @click="select('frontend')">
            <rect x="427" y="60" width="106" height="48" rx="10" class="node-rect app-node" />
            <text x="480" y="81" class="node-name">Frontend</text>
            <text x="480" y="96" class="node-sub">Electron · Vue 3</text>
            <circle cx="527" cy="65" r="7" :class="statusDot(health.frontend.status)" />
          </g>

          <!-- Backend -->
          <g class="node" :class="nodeCls('backend')" @click="select('backend')">
            <rect x="427" y="237" width="106" height="48" rx="10" class="node-rect app-node" />
            <text x="480" y="258" class="node-name">Backend</text>
            <text x="480" y="273" class="node-sub">Go · {{ ports.backend }}</text>
            <circle cx="527" cy="242" r="7" :class="statusDot(health.backend.status)" />
          </g>

          <!-- Config Server -->
          <g class="node" :class="nodeCls('configServer')" @click="select('configServer')">
            <rect x="90" y="188" width="110" height="48" rx="10" class="node-rect keri-node" />
            <text x="145" y="208" class="node-name">Config Server</text>
            <text x="145" y="224" class="node-sub">Python · {{ ports.configServer }}</text>
            <circle cx="194" cy="193" r="7" :class="statusDot(health.configServer.status)" />
          </g>

          <!-- KERIA -->
          <g class="node" :class="nodeCls('keria')" @click="select('keria')">
            <rect x="230" y="188" width="106" height="48" rx="10" class="node-rect keri-node" />
            <text x="283" y="208" class="node-name">KERIA</text>
            <text x="283" y="224" class="node-sub">Admin · Boot · CESR</text>
            <circle cx="330" cy="193" r="7" :class="statusDot(health.keria.status)" />
          </g>

          <!-- Schema Server -->
          <g class="node" :class="nodeCls('schemaServer')" @click="select('schemaServer')">
            <rect x="90" y="318" width="110" height="48" rx="10" class="node-rect keri-node" />
            <text x="145" y="338" class="node-name">Schema Server</text>
            <text x="145" y="354" class="node-sub">Python · {{ ports.schemaServer }}</text>
            <circle cx="194" cy="323" r="7" :class="statusDot(health.schemaServer.status)" />
          </g>

          <!-- Witnesses -->
          <g class="node" :class="nodeCls('witnesses')" @click="select('witnesses')">
            <rect x="230" y="318" width="106" height="48" rx="10" class="node-rect keri-node" />
            <text x="283" y="338" class="node-name">Witnesses</text>
            <text x="283" y="354" class="node-sub">6 nodes · wan–wyz</text>
            <circle cx="330" cy="323" r="7" :class="statusDot(health.witnesses.status)" />
          </g>

          <!-- Coordinator -->
          <g class="node" :class="nodeCls('coordinator')" @click="select('coordinator')">
            <rect x="730" y="188" width="110" height="48" rx="10" class="node-rect anysync-node" />
            <text x="785" y="208" class="node-name">Coordinator</text>
            <text x="785" y="224" class="node-sub">any-sync · {{ ports.coordinator }}</text>
            <circle cx="834" cy="193" r="7" :class="statusDot(health.coordinator.status)" />
          </g>

          <!-- Sync Node -->
          <g class="node" :class="nodeCls('syncNode')" @click="select('syncNode')">
            <rect x="862" y="153" width="106" height="48" rx="10" class="node-rect anysync-node" />
            <text x="915" y="173" class="node-name">Sync Node</text>
            <text x="915" y="189" class="node-sub">{{ ports.syncNode }}</text>
            <circle cx="962" cy="158" r="7" :class="statusDot(health.syncNode.status)" />
          </g>

          <!-- Consensus Node -->
          <g class="node" :class="nodeCls('consensusNode')" @click="select('consensusNode')">
            <rect x="962" y="188" width="110" height="48" rx="10" class="node-rect anysync-node" />
            <text x="1017" y="208" class="node-name">Consensus</text>
            <text x="1017" y="224" class="node-sub">{{ ports.consensusNode }}</text>
            <circle cx="1066" cy="193" r="7" :class="statusDot(health.consensusNode.status)" />
          </g>

          <!-- File Node -->
          <g class="node" :class="nodeCls('fileNode')" @click="select('fileNode')">
            <rect x="862" y="263" width="106" height="48" rx="10" class="node-rect anysync-node" />
            <text x="915" y="283" class="node-name">File Node</text>
            <text x="915" y="299" class="node-sub">{{ ports.fileNode }}</text>
            <circle cx="962" cy="268" r="7" :class="statusDot(health.fileNode.status)" />
          </g>

          <!-- MongoDB -->
          <g class="node" :class="nodeCls('mongodb')" @click="select('mongodb')">
            <rect x="732" y="358" width="106" height="44" rx="10" class="node-rect storage-node" />
            <text x="785" y="377" class="node-name">MongoDB</text>
            <text x="785" y="392" class="node-sub">{{ ports.mongodb }}</text>
            <circle cx="832" cy="363" r="7" :class="statusDot(health.mongodb.status)" />
          </g>

          <!-- Redis -->
          <g class="node" :class="nodeCls('redis')" @click="select('redis')">
            <rect x="866" y="368" width="100" height="44" rx="10" class="node-rect storage-node" />
            <text x="916" y="387" class="node-name">Redis</text>
            <text x="916" y="402" class="node-sub">{{ ports.redis }}</text>
            <circle cx="960" cy="373" r="7" :class="statusDot(health.redis.status)" />
          </g>

          <!-- MinIO -->
          <g class="node" :class="nodeCls('minio')" @click="select('minio')">
            <rect x="976" y="258" width="100" height="44" rx="10" class="node-rect storage-node" />
            <text x="1026" y="277" class="node-name">MinIO</text>
            <text x="1026" y="292" class="node-sub">S3 · {{ ports.minio }}</text>
            <circle cx="1070" cy="263" r="7" :class="statusDot(health.minio.status)" />
          </g>
        </svg>
      </div>

      <!-- Detail Panel -->
      <transition name="panel-slide">
        <div v-if="selectedId" class="detail-panel">
          <button class="panel-close" @click="selectedId = null">
            <X :size="16" />
          </button>

          <div class="panel-header">
            <div class="panel-icon" :class="`icon-${selectedNode.group}`">
              <component :is="selectedNode.icon" :size="20" />
            </div>
            <div>
              <h2 class="panel-title">{{ selectedNode.label }}</h2>
              <p class="panel-sub">{{ selectedNode.sublabel }}</p>
            </div>
          </div>

          <div class="panel-status-row">
            <span class="status-badge" :class="`status-${health[selectedId].status}`">
              {{ statusLabel(health[selectedId].status) }}
            </span>
            <span v-if="health[selectedId].latency" class="latency-badge">
              {{ health[selectedId].latency }}ms
            </span>
          </div>

          <p class="panel-description">{{ selectedNode.description }}</p>

          <!-- URLs / ports -->
          <div class="panel-section">
            <h3 class="section-title">Endpoints</h3>
            <div v-for="ep in selectedNode.endpoints" :key="ep.label" class="endpoint-row">
              <span class="ep-label">{{ ep.label }}</span>
              <code class="ep-url">{{ ep.url }}</code>
            </div>
          </div>

          <!-- Health data -->
          <div v-if="health[selectedId].data" class="panel-section">
            <h3 class="section-title">Response</h3>
            <div class="health-data">
              <div v-for="(val, key) in flattenData(health[selectedId].data)" :key="key" class="data-row">
                <span class="data-key">{{ key }}</span>
                <span class="data-val">{{ val }}</span>
              </div>
            </div>
          </div>

          <div v-if="health[selectedId].error" class="panel-section">
            <h3 class="section-title">Error</h3>
            <p class="error-text">{{ health[selectedId].error }}</p>
          </div>

          <div v-if="selectedNode.note" class="panel-note">
            <Info :size="13" />
            {{ selectedNode.note }}
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  RefreshCw, X, Info,
  Server, Cpu, Database, HardDrive, Globe, Shield, FileCode, Wifi,
} from 'lucide-vue-next';
import { fetchClientConfig, getEnv } from 'src/lib/clientConfig';
import { getBackendUrl } from 'src/lib/platform';

// ── Types ────────────────────────────────────────────────────────────────────

type Status = 'healthy' | 'unhealthy' | 'checking' | 'unknown';

interface NodeHealth {
  status: Status;
  latency?: number;
  data?: Record<string, unknown>;
  error?: string;
}

interface ServiceNode {
  label: string;
  sublabel: string;
  description: string;
  group: 'app' | 'keri' | 'anysync' | 'storage';
  icon: unknown;
  endpoints: { label: string; url: string }[];
  note?: string;
}

// ── State ────────────────────────────────────────────────────────────────────

const selectedId = ref<string | null>(null);
const loading = ref(false);
const lastUpdated = ref<Date | null>(null);
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null);

// Resolved URLs (populated from clientConfig + backendUrl)
const urls = ref({
  backend: '',
  configServer: '',
  keria: { admin: '', boot: '', cesr: '' },
  schemaServer: '',
  witnesses: [] as string[],
});

// Port display strings
const ports = computed(() => {
  const extract = (url: string) => {
    try { return new URL(url).port || '80'; } catch { return '—'; }
  };
  return {
    backend:       extract(urls.value.backend),
    configServer:  extract(urls.value.configServer),
    keria:         `${extract(urls.value.keria.admin)} · ${extract(urls.value.keria.boot)}`,
    schemaServer:  extract(urls.value.schemaServer),
    coordinator:   ':1004',
    syncNode:      ':1001',
    consensusNode: ':1006',
    fileNode:      ':1005',
    mongodb:       ':27017',
    redis:         ':6379',
    minio:         ':9000',
  };
});

// Health state for each node
const makeHealth = (): NodeHealth => ({ status: 'unknown' });
const health = ref<Record<string, NodeHealth>>({
  frontend:      makeHealth(),
  backend:       makeHealth(),
  configServer:  makeHealth(),
  keria:         makeHealth(),
  schemaServer:  makeHealth(),
  witnesses:     makeHealth(),
  coordinator:   makeHealth(),
  syncNode:      makeHealth(),
  consensusNode: makeHealth(),
  fileNode:      makeHealth(),
  mongodb:       makeHealth(),
  redis:         makeHealth(),
  minio:         makeHealth(),
});

// ── Node definitions ─────────────────────────────────────────────────────────

const nodeDefs = computed<Record<string, ServiceNode>>(() => ({
  frontend: {
    label: 'Frontend',
    sublabel: 'Electron · Vue 3 · Quasar',
    description: 'The Matou desktop app. Runs in Electron, built with Vue 3 and Quasar. Communicates with the Backend, KERIA, Config Server, and any-sync nodes directly.',
    group: 'app',
    icon: Globe,
    endpoints: [
      { label: 'Dev', url: 'http://localhost:9000' },
      { label: 'Test', url: 'http://localhost:9003' },
    ],
  },
  backend: {
    label: 'Backend',
    sublabel: 'Go · REST API',
    description: 'The Matou Go backend. Manages identity state, credential caching, any-sync spaces, trust graph computation, member registration, and invitations.',
    group: 'app',
    icon: Server,
    endpoints: [
      { label: 'API', url: urls.value.backend || 'http://localhost:8080' },
      { label: 'Health', url: `${urls.value.backend || 'http://localhost:8080'}/health` },
    ],
  },
  configServer: {
    label: 'Config Server',
    sublabel: 'Python · Docker',
    description: 'Serves the org config and KERI/any-sync client configuration to the app. The frontend fetches this at startup to discover all service URLs, witness OOBIs, and the any-sync network topology.',
    group: 'keri',
    icon: FileCode,
    endpoints: [
      { label: 'Config', url: `${urls.value.configServer || 'http://localhost:3904'}/api/client-config` },
      { label: 'Health', url: `${urls.value.configServer || 'http://localhost:3904'}/api/health` },
    ],
  },
  keria: {
    label: 'KERIA',
    sublabel: 'Python · Key agent',
    description: 'Key Event Receipt Infrastructure Agent. Manages KERI AIDs (self-sovereign identifiers), credential issuance/revocation, OOBI resolution, and key event logs for the org and all members. Patched for Matou\'s registration workflow.',
    group: 'keri',
    icon: Shield,
    endpoints: [
      { label: 'Admin', url: urls.value.keria.admin || 'http://localhost:3901' },
      { label: 'Boot', url: urls.value.keria.boot || 'http://localhost:3903' },
      { label: 'CESR', url: urls.value.keria.cesr || 'http://localhost:3902' },
    ],
  },
  schemaServer: {
    label: 'Schema Server',
    sublabel: 'Python · Docker',
    description: 'Serves ACDC credential schemas over HTTP as OOBI endpoints. KERIA resolves these when issuing credentials, ensuring both issuer and holder agree on the credential structure.',
    group: 'keri',
    icon: FileCode,
    endpoints: [
      { label: 'Schemas', url: urls.value.schemaServer || 'http://localhost:7723' },
    ],
  },
  witnesses: {
    label: 'Witnesses',
    sublabel: '6 nodes · wan wil wes wit wub wyz',
    description: 'KERI witness network. Witnesses receive and receipt key events to provide decentralised verification. All 6 run inside a single witness-demo container. At least a threshold of witnesses must be reachable for KERI operations to succeed.',
    group: 'keri',
    icon: Shield,
    endpoints: urls.value.witnesses.length
      ? urls.value.witnesses.slice(0, 3).map((u, i) => ({ label: `Witness ${i + 1}`, url: u }))
      : [{ label: 'Default', url: 'http://localhost:5642' }],
  },
  coordinator: {
    label: 'Coordinator',
    sublabel: 'any-sync · TCP/QUIC',
    description: 'any-sync network coordinator. Manages peer discovery, space routing, and network topology. All sync nodes, file nodes, and consensus nodes register with the coordinator. Backed by MongoDB.',
    group: 'anysync',
    icon: Wifi,
    endpoints: [{ label: 'TCP', url: 'localhost:1004' }],
    note: 'TCP-only service — health inferred from backend sync status.',
  },
  syncNode: {
    label: 'Sync Node',
    sublabel: 'any-sync · TCP/QUIC',
    description: 'any-sync sync node. Handles real-time document synchronisation between clients using CRDT-based conflict resolution. Spaces (community, projects, proposals) sync through this node.',
    group: 'anysync',
    icon: Wifi,
    endpoints: [{ label: 'TCP', url: 'localhost:1001' }],
    note: 'TCP-only service — health inferred from backend sync status.',
  },
  consensusNode: {
    label: 'Consensus',
    sublabel: 'any-sync · TCP/QUIC',
    description: 'any-sync consensus node. Provides Byzantine fault-tolerant ordering of write operations across the network, ensuring all nodes agree on the document state.',
    group: 'anysync',
    icon: Cpu,
    endpoints: [{ label: 'TCP', url: 'localhost:1006' }],
    note: 'TCP-only service — health inferred from backend sync status.',
  },
  fileNode: {
    label: 'File Node',
    sublabel: 'any-sync · TCP/QUIC',
    description: 'any-sync file node. Handles binary file storage and retrieval for avatars, attachments, and media uploaded to Matou spaces. Backed by MinIO (S3) with Redis as a cache layer.',
    group: 'anysync',
    icon: HardDrive,
    endpoints: [{ label: 'TCP', url: 'localhost:1005' }],
    note: 'TCP-only service — health inferred from backend sync status.',
  },
  mongodb: {
    label: 'MongoDB',
    sublabel: 'Replica set · Docker',
    description: 'MongoDB replica set used by the any-sync coordinator to store network configuration, space metadata, and peer state. Runs as a single-node replica set for consistency guarantees.',
    group: 'storage',
    icon: Database,
    endpoints: [{ label: 'TCP', url: 'localhost:27017' }],
    note: 'Internal service — health inferred from backend sync status.',
  },
  redis: {
    label: 'Redis',
    sublabel: 'Redis Stack · Docker',
    description: 'Redis used by the file node as a cache layer for frequently accessed file metadata. Uses Redis Stack with Bloom filter support.',
    group: 'storage',
    icon: Database,
    endpoints: [{ label: 'TCP', url: 'localhost:6379' }],
    note: 'Internal service — health inferred from backend sync status.',
  },
  minio: {
    label: 'MinIO',
    sublabel: 'S3-compatible · Docker',
    description: 'MinIO S3-compatible object storage. Stores all binary files and media uploaded to Matou spaces. The file node writes here and serves content through any-sync.',
    group: 'storage',
    icon: HardDrive,
    endpoints: [
      { label: 'API', url: 'localhost:9000' },
      { label: 'Console', url: 'localhost:9001' },
    ],
    note: 'Internal service — health inferred from backend sync status.',
  },
}));

// ── Computed ─────────────────────────────────────────────────────────────────

const envLabel = computed(() => {
  const e = getEnv();
  return e === 'test' ? 'TEST' : e === 'prod' ? 'PROD' : 'DEV';
});

const selectedNode = computed(() =>
  selectedId.value ? nodeDefs.value[selectedId.value] : null,
);

const lastUpdatedText = computed(() => {
  if (!lastUpdated.value) return 'Never checked';
  const secs = Math.round((Date.now() - lastUpdated.value.getTime()) / 1000);
  if (secs < 5) return 'Just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
});

const summaryStats = computed(() => {
  const counts = { healthy: 0, unhealthy: 0, unknown: 0 };
  for (const h of Object.values(health.value)) {
    if (h.status === 'healthy') counts.healthy++;
    else if (h.status === 'unhealthy') counts.unhealthy++;
    else counts.unknown++;
  }
  return [
    { label: 'healthy', count: counts.healthy, color: 'green' },
    { label: 'unhealthy', count: counts.unhealthy, color: 'red' },
    { label: 'unknown', count: counts.unknown, color: 'gray' },
  ];
});

// ── Graph helpers ─────────────────────────────────────────────────────────────

function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function statusDot(status: Status): string {
  return {
    healthy:  'dot-healthy',
    unhealthy:'dot-unhealthy',
    checking: 'dot-checking',
    unknown:  'dot-unknown',
  }[status];
}

function edgeCls(targetId: string): string {
  const s = health.value[targetId]?.status;
  if (s === 'healthy')   return 'edge-healthy';
  if (s === 'unhealthy') return 'edge-unhealthy';
  return 'edge-unknown';
}

function nodeCls(id: string): string {
  const isSelected = selectedId.value === id;
  const s = health.value[id]?.status;
  return [
    isSelected ? 'node-selected' : '',
    s === 'unhealthy' ? 'node-unhealthy' : '',
  ].filter(Boolean).join(' ');
}

function statusLabel(s: Status): string {
  return { healthy: 'Healthy', unhealthy: 'Unhealthy', checking: 'Checking…', unknown: 'Unknown' }[s];
}

function select(id: string) {
  selectedId.value = selectedId.value === id ? null : id;
}

function flattenData(data: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenData(v as Record<string, unknown>, key));
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

// ── Health checks ─────────────────────────────────────────────────────────────

async function checkHttp(
  id: string,
  url: string,
  opts: { expectStatus?: number[]; method?: string } = {},
): Promise<void> {
  const t0 = Date.now();
  health.value[id] = { status: 'checking' };
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      signal: AbortSignal.timeout(4000),
    });
    const latency = Date.now() - t0;
    const ok = opts.expectStatus
      ? opts.expectStatus.includes(res.status)
      : res.status < 500;

    let data: Record<string, unknown> | undefined;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => undefined);
    }

    health.value[id] = { status: ok ? 'healthy' : 'unhealthy', latency, data };
  } catch (err) {
    health.value[id] = {
      status: 'unhealthy',
      error: err instanceof Error ? err.message : 'Unreachable',
    };
  }
}

function inferAnySyncHealth(syncData: Record<string, unknown> | undefined) {
  // If the backend has sync data with spaces or credentials, any-sync is working
  const inferredStatus: Status = syncData
    ? ((syncData.spacesCreated as number) > 0 || (syncData.credentialsCached as number) > 0)
      ? 'healthy' : 'unknown'
    : 'unknown';

  for (const id of ['coordinator', 'syncNode', 'consensusNode', 'fileNode', 'mongodb', 'redis', 'minio']) {
    if (health.value[id].status === 'checking' || health.value[id].status === 'unknown') {
      health.value[id] = { status: inferredStatus };
    }
  }
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;

  // Set all to checking
  for (const id of Object.keys(health.value)) {
    health.value[id] = { status: 'checking' };
  }

  try {
    // Resolve URLs from config
    const [cfg, backendUrl] = await Promise.allSettled([
      fetchClientConfig(),
      getBackendUrl(),
    ]);

    if (cfg.status === 'fulfilled') {
      urls.value.configServer  = cfg.value.config_server_url;
      urls.value.keria         = { admin: cfg.value.keri.admin_url, boot: cfg.value.keri.boot_url, cesr: cfg.value.keri.cesr_url };
      urls.value.schemaServer  = cfg.value.schema_server_url;
      urls.value.witnesses     = cfg.value.witnesses.urls;
    }
    if (backendUrl.status === 'fulfilled') {
      urls.value.backend = backendUrl.value;
    }

    // Frontend: just mark as healthy (we're running)
    health.value.frontend = { status: 'healthy' };

    // Run HTTP checks in parallel
    const checks: Promise<void>[] = [
      checkHttp('backend',      `${urls.value.backend || 'http://localhost:8080'}/health`),
      checkHttp('configServer', `${urls.value.configServer || 'http://localhost:3904'}/api/health`),
      checkHttp('keria',        `${urls.value.keria.admin || 'http://localhost:3901'}/`,
                { expectStatus: [200, 401, 405] }),
      checkHttp('schemaServer', `${urls.value.schemaServer || 'http://localhost:7723'}/`),
    ];

    // Check first witness
    const witnessUrl = urls.value.witnesses[0] || 'http://localhost:5642';
    checks.push(checkHttp('witnesses', `${witnessUrl}/oobi`, { expectStatus: [200, 405] }));

    await Promise.allSettled(checks);

    // Infer any-sync health from backend sync data
    const syncData = health.value.backend.data?.sync as Record<string, unknown> | undefined;
    inferAnySyncHealth(syncData);

  } finally {
    loading.value = false;
    lastUpdated.value = new Date();
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  refresh();
  pollTimer.value = setInterval(refresh, 20_000);
});

onUnmounted(() => {
  if (pollTimer.value) clearInterval(pollTimer.value);
});
</script>

<style scoped lang="scss">
.infra-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--matou-background);
  color: var(--matou-foreground);
}

// ── Header ────────────────────────────────────────────────────────────────────

.infra-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--matou-border);
  flex-shrink: 0;

  .header-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--matou-foreground);
    margin: 0 0 2px;
  }

  .header-subtitle {
    font-size: 0.8rem;
    color: var(--matou-muted-foreground);
    margin: 0;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .last-updated {
    font-size: 0.75rem;
    color: var(--matou-muted-foreground);
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--matou-border);
    border-radius: var(--matou-radius-sm);
    background: var(--matou-card);
    color: var(--matou-foreground);
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s;

    &:hover:not(:disabled) { background: var(--matou-secondary); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
  }

  .env-badge {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    background: var(--matou-secondary);
    color: var(--matou-primary);
  }
}

// ── Summary bar ───────────────────────────────────────────────────────────────

.summary-bar {
  display: flex;
  gap: 20px;
  padding: 10px 24px;
  border-bottom: 1px solid var(--matou-border);
  background: var(--matou-card);
  flex-shrink: 0;

  .summary-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
  }

  .summary-count {
    font-weight: 600;
    color: var(--matou-foreground);
  }

  .summary-label {
    color: var(--matou-muted-foreground);
  }
}

// ── Body ──────────────────────────────────────────────────────────────────────

.infra-body {
  display: flex;
  flex: 1;
  overflow: hidden;

  &.panel-open .graph-wrap {
    flex: 1;
  }
}

.graph-wrap {
  flex: 1;
  overflow: auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.infra-svg {
  width: 100%;
  max-width: 1060px;
  height: auto;
}

// ── SVG: Groups ───────────────────────────────────────────────────────────────

.group-box {
  fill: none;
  stroke-width: 1.5;
  stroke-dasharray: 5 3;
}

.keri-group {
  stroke: rgba(74, 157, 156, 0.4);
  fill: rgba(74, 157, 156, 0.04);
}

.anysync-group {
  stroke: rgba(100, 80, 180, 0.35);
  fill: rgba(100, 80, 180, 0.03);
}

.group-label {
  text-anchor: middle;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  fill: var(--matou-muted-foreground);
}

// ── SVG: Edges ────────────────────────────────────────────────────────────────

.edge {
  fill: none;
  stroke-width: 1.5;
  stroke-linecap: round;
  transition: stroke 0.3s;

  &.edge-healthy  { stroke: rgba(74, 157, 156, 0.45); }
  &.edge-unhealthy{ stroke: rgba(200, 70, 58, 0.5); }
  &.edge-unknown  { stroke: rgba(30, 95, 116, 0.2); stroke-dasharray: 4 3; }

  &.edge-internal { stroke-width: 1; }
}

// ── SVG: Nodes ────────────────────────────────────────────────────────────────

.node {
  cursor: pointer;

  .node-rect {
    stroke-width: 1.5;
    transition: all 0.2s;
    rx: 10;
  }

  .app-node {
    fill: var(--matou-card);
    stroke: var(--matou-primary);
  }

  .keri-node {
    fill: var(--matou-card);
    stroke: #4a9d9c;
  }

  .anysync-node {
    fill: var(--matou-card);
    stroke: #7064b4;
  }

  .storage-node {
    fill: var(--matou-card);
    stroke: var(--matou-muted-foreground);
    opacity: 0.85;
  }

  .node-name {
    text-anchor: middle;
    font-size: 11px;
    font-weight: 600;
    fill: var(--matou-foreground);
  }

  .node-sub {
    text-anchor: middle;
    font-size: 9px;
    fill: var(--matou-muted-foreground);
  }

  &:hover .node-rect {
    filter: brightness(0.94);
    stroke-width: 2;
  }

  &.node-selected .node-rect {
    stroke-width: 2.5;
    filter: drop-shadow(0 0 6px rgba(74, 157, 156, 0.5));
  }

  &.node-unhealthy .node-rect {
    stroke: var(--matou-destructive) !important;
  }
}

// ── SVG: Status dots ──────────────────────────────────────────────────────────

.dot-healthy {
  fill: #3ecf8e;
  animation: pulse-green 2s ease-in-out infinite;
}

.dot-unhealthy {
  fill: var(--matou-destructive);
  animation: pulse-red 1.5s ease-in-out infinite;
}

.dot-checking {
  fill: #f59e0b;
  animation: pulse-amber 0.8s ease-in-out infinite;
}

.dot-unknown {
  fill: var(--matou-muted-foreground);
  opacity: 0.5;
}

@keyframes pulse-green {
  0%, 100% { opacity: 1; r: 7; }
  50% { opacity: 0.7; r: 8; }
}

@keyframes pulse-red {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes pulse-amber {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

// ── Detail panel ──────────────────────────────────────────────────────────────

.detail-panel {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--matou-border);
  background: var(--matou-card);
  overflow-y: auto;
  padding: 20px;
  position: relative;
}

.panel-close {
  position: absolute;
  top: 14px;
  right: 14px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  &:hover { background: var(--matou-secondary); color: var(--matou-foreground); }
}

.panel-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
  padding-right: 24px;
}

.panel-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  &.icon-app     { background: rgba(30, 95, 116, 0.12); color: var(--matou-primary); }
  &.icon-keri    { background: rgba(74, 157, 156, 0.12); color: #4a9d9c; }
  &.icon-anysync { background: rgba(112, 100, 180, 0.12); color: #7064b4; }
  &.icon-storage { background: var(--matou-secondary); color: var(--matou-muted-foreground); }
}

.panel-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 2px;
}

.panel-sub {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  margin: 0;
}

.panel-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.status-badge {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;

  &.status-healthy   { background: rgba(62, 207, 142, 0.15); color: #1a9c6a; }
  &.status-unhealthy { background: rgba(200, 70, 58, 0.12); color: var(--matou-destructive); }
  &.status-checking  { background: rgba(245, 158, 11, 0.12); color: #c27803; }
  &.status-unknown   { background: var(--matou-secondary); color: var(--matou-muted-foreground); }
}

.latency-badge {
  font-size: 0.72rem;
  color: var(--matou-muted-foreground);
  background: var(--matou-secondary);
  padding: 3px 8px;
  border-radius: 999px;
}

.panel-description {
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--matou-muted-foreground);
  margin: 0 0 18px;
}

.panel-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--matou-muted-foreground);
  margin: 0 0 8px;
}

.endpoint-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;

  .ep-label {
    font-size: 0.72rem;
    color: var(--matou-muted-foreground);
    min-width: 48px;
  }

  .ep-url {
    font-size: 0.72rem;
    font-family: monospace;
    background: var(--matou-secondary);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--matou-primary);
    word-break: break-all;
  }
}

.health-data {
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  padding: 10px;

  .data-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    border-bottom: 1px solid var(--matou-border);
    &:last-child { border-bottom: none; }
  }

  .data-key {
    font-size: 0.7rem;
    font-family: monospace;
    color: var(--matou-muted-foreground);
  }

  .data-val {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--matou-foreground);
    text-align: right;
    word-break: break-all;
    max-width: 140px;
  }
}

.error-text {
  font-size: 0.78rem;
  color: var(--matou-destructive);
  font-family: monospace;
  background: rgba(200, 70, 58, 0.06);
  padding: 8px;
  border-radius: var(--matou-radius-sm);
  word-break: break-word;
  margin: 0;
}

.panel-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 0.72rem;
  color: var(--matou-muted-foreground);
  background: var(--matou-secondary);
  padding: 8px 10px;
  border-radius: var(--matou-radius-sm);
  margin-top: 4px;
  line-height: 1.5;
}

// ── Transitions ───────────────────────────────────────────────────────────────

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: width 0.25s ease, opacity 0.2s ease;
  overflow: hidden;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  width: 0;
  opacity: 0;
}

.panel-slide-enter-to,
.panel-slide-leave-from {
  width: 300px;
  opacity: 1;
}

// ── Spin animation ────────────────────────────────────────────────────────────

.spinning {
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

// ── Summary dots ──────────────────────────────────────────────────────────────

.summary-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;

  &.dot-green { background: #3ecf8e; }
  &.dot-red   { background: var(--matou-destructive); }
  &.dot-gray  { background: var(--matou-muted-foreground); opacity: 0.5; }
}
</style>
