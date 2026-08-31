import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { getRunnerPodName, JOB_CONTAINER_NAME } from '../../hooks/constants'
import { formatError } from './index'
import {
  execPodStepWithOutput,
  getPodByName,
  getSecretByName,
  listPodsByRunnerInstance,
  namespace
} from '../index'

export const NPU_METRICS_MARKER = 'NPU_METRICS_V1'
export const ENV_NPU_METRICS_ENABLED = 'ACTIONS_RUNNER_NPU_METRICS'
export const ENV_NPU_SAMPLE_INTERVAL = 'NPU_SAMPLE_INTERVAL'
export const ENV_NPU_IDLE_THRESHOLD = 'NPU_IDLE_THRESHOLD'

export const DEFAULT_NPU_SAMPLE_INTERVAL_SECONDS = 1
export const MIN_NPU_SAMPLE_INTERVAL_SECONDS = 0.2
export const DEFAULT_NPU_IDLE_THRESHOLD_PERCENT = 5

export const NPU_SAMPLES_FILE = '/tmp/npu-samples.jsonl'
export const NPU_TERMINATION_LOG = '/dev/termination-log'
export const NPU_SAMPLES_MAX_BYTES = 4 * 1024 * 1024
export const NPU_AGGREGATE_MAX_BYTES = 4096

export const NPU_METRICS_SECRET_NAME = 'npu-metrics-pushgw'
export const NPU_METRICS_PUSH_JOB = 'npu-job-record'
export const NPU_COLLECT_TIMEOUT_MS = 10_000

const NPU_RESOURCE_REGEX = /^huawei\.com\/(ascend\S*)$/i
const SCALE_SET_NAME_REGEX = /^linux-[a-z0-9]+-[a-z0-9]+-\d+-([a-z][a-z0-9-]*)$/

export interface NpuCardAggregate {
  card: string
  samples: number
  peakUtil: number
  avgUtil: number
  peakHbm: number
  firstTs: number
  lastTs: number
}

export interface NpuAggregatePayload {
  version: string
  ts: number
  cards: NpuCardAggregate[]
}

export interface NpuPushConfig {
  url: string
  username?: string
  password?: string
}

export interface NpuJobLabels {
  cluster: string
  namespace: string
  pod: string
  podType: string
  repo: string
  runId: string
  npuType: string
  cardsRequested: string
  result: string
}

export function npuMetricsEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    (env[ENV_NPU_METRICS_ENABLED] ?? '').trim().toLowerCase() !== 'disabled'
  )
}

export function getNpuSampleIntervalSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[ENV_NPU_SAMPLE_INTERVAL]
  if (!raw) {
    return DEFAULT_NPU_SAMPLE_INTERVAL_SECONDS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    core.warning(
      `NPU_SAMPLE_INTERVAL is invalid ("${raw}"): use ${DEFAULT_NPU_SAMPLE_INTERVAL_SECONDS}`
    )
    return DEFAULT_NPU_SAMPLE_INTERVAL_SECONDS
  }
  return Math.max(parsed, MIN_NPU_SAMPLE_INTERVAL_SECONDS)
}

export function getIdleThresholdPercent(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[ENV_NPU_IDLE_THRESHOLD]
  if (!raw) {
    return DEFAULT_NPU_IDLE_THRESHOLD_PERCENT
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    core.warning(
      `NPU_IDLE_THRESHOLD is invalid ("${raw}"): use ${DEFAULT_NPU_IDLE_THRESHOLD_PERCENT}`
    )
    return DEFAULT_NPU_IDLE_THRESHOLD_PERCENT
  }
  return parsed
}

export function containerHasNpuRequest(container: k8s.V1Container): boolean {
  const resources = [container.resources?.requests, container.resources?.limits]
  for (const entry of resources) {
    for (const key of Object.keys(entry ?? {})) {
      if (NPU_RESOURCE_REGEX.test(key)) {
        return true
      }
    }
  }
  return false
}

export function hasNpuRequest(spec: k8s.V1PodSpec | undefined): boolean {
  return (spec?.containers ?? []).some(c => containerHasNpuRequest(c))
}

function listNpuCardsCommand(): string {
  return `ls /dev/davinci[0-9]* 2>/dev/null | sed 's|.*/davinci||' | sort -n | uniq | tr '\\n' ' '`
}

export function buildNpuSamplerScript(
  intervalSeconds = DEFAULT_NPU_SAMPLE_INTERVAL_SECONDS
): string {
  return [
    `# ${NPU_METRICS_MARKER} sampler (detached, best-effort)`,
    `F=${NPU_SAMPLES_FILE}`,
    `CARDS=$(${listNpuCardsCommand()})`,
    `[ -z "$CARDS" ] && exit 0`,
    `while :; do`,
    `  NOW=$(date +%s)`,
    `  for C in $CARDS; do`,
    `    OUT=$(npu-smi info -t usages -i "$C" 2>/dev/null) || continue`,
    `    U=$(printf '%s\\n' "$OUT" | awk '{l=$0; gsub(/[ \\t\\r]/, "", l)} l ~ /AICore/ { if (match(l, /[0-9.]+%?$/)) { v = substr(l, RSTART, RLENGTH); sub(/%$/, "", v); print v; exit } }')`,
    `    H=$(printf '%s\\n' "$OUT" | awk '{l=$0; gsub(/[ \\t\\r]/, "", l)} l ~ /HBM/ { if (match(l, /[0-9.]+%?$/)) { v = substr(l, RSTART, RLENGTH); sub(/%$/, "", v); print v; exit } }')`,
    `    printf '{"ts":%s,"card":%s,"util":%s,"hbm":%s}\\n' "$NOW" "$C" "\${U:-0}" "\${H:-0}" >> "$F" 2>/dev/null || true`,
    `  done`,
    `  SZ=$(wc -c < "$F" 2>/dev/null || echo 0)`,
    `  if [ "$SZ" -gt ${NPU_SAMPLES_MAX_BYTES} ]; then`,
    `    tail -n 2000 "$F" > "$F.r" 2>/dev/null && mv "$F.r" "$F" || true`,
    `  fi`,
    `  sleep ${intervalSeconds}`,
    `done`
  ].join('\n')
}

const AGGREGATE_AWK = [
  `BEGIN {`,
  `  n = split(cards, a, " ")`,
  `  for (i = 1; i <= n; i++) { cnt[a[i]] = 0; pu[a[i]] = 0; ph[a[i]] = 0; su[a[i]] = 0; fs[a[i]] = 0; ls[a[i]] = 0 }`,
  `}`,
  `{`,
  `  ts = $0; sub(/.*"ts":/, "", ts); sub(/[^0-9].*/, "", ts)`,
  `  c = $0;  sub(/.*"card":/, "", c); sub(/[^0-9].*/, "", c)`,
  `  u = $0; sub(/.*"util":/, "", u); sub(/[^0-9.].*/, "", u)`,
  `  h = $0; sub(/.*"hbm":/, "", h); sub(/[^0-9.].*/, "", h)`,
  `  if (c == "") next`,
  `  cnt[c]++`,
  `  if (ts != "") { t = ts + 0; if (fs[c] == 0 || t < fs[c]) fs[c] = t; if (t > ls[c]) ls[c] = t }`,
  `  if (u + 0 > pu[c]) pu[c] = u + 0`,
  `  if (h + 0 > ph[c]) ph[c] = h + 0`,
  `  su[c] += u + 0`,
  `}`,
  `END {`,
  `  printf "{\\"v\\":\\"${NPU_METRICS_MARKER}\\",\\"ts\\":%d,\\"cards\\":[", now`,
  `  sep = ""`,
  `  for (c in cnt) {`,
  `    au = cnt[c] > 0 ? su[c] / cnt[c] : 0`,
  `    printf "%s{\\"c\\":\\"%s\\",\\"n\\":%d,\\"pu\\":%.1f,\\"au\\":%.1f,\\"ph\\":%.1f,\\"fs\\":%d,\\"ls\\":%d}", sep, c, cnt[c], pu[c], au, ph[c], fs[c], ls[c]`,
  `    sep = ","`,
  `  }`,
  `  printf "]}\\n"`,
  `}`
].join('\n')

export function buildNpuAggregateScript(): string {
  return [
    `# ${NPU_METRICS_MARKER} aggregate`,
    `F=${NPU_SAMPLES_FILE}`,
    `CARDS=$(${listNpuCardsCommand()})`,
    `NOW=$(date +%s)`,
    `touch "$F" 2>/dev/null || true`,
    `awk -v now="$NOW" -v cards="$CARDS" '${AGGREGATE_AWK}' "$F" 2>/dev/null`
  ].join('\n')
}

function commandHasMarker(command: string[] | undefined): boolean {
  return (command ?? []).join(' ').includes(NPU_METRICS_MARKER)
}

function appendExecCommand(
  existing: string[] | undefined,
  appendLines: string[]
): string[] {
  if (
    existing &&
    existing.length >= 3 &&
    /(^|\/)sh$/.test(existing[0]) &&
    existing[1] === '-c'
  ) {
    return [
      existing[0],
      existing[1],
      [...existing.slice(2), ...appendLines].join('\n')
    ]
  }
  const prefix = (existing ?? []).map(
    part => `'${part.replace(/'/g, "'\\''")}'`
  )
  return ['sh', '-c', [prefix.join(' '), ...appendLines].join('\n')]
}

export function injectNpuMetrics(
  container: k8s.V1Container,
  intervalSeconds = DEFAULT_NPU_SAMPLE_INTERVAL_SECONDS
): boolean {
  const lifecycle = container.lifecycle ?? {}
  if (
    commandHasMarker(lifecycle.postStart?.exec?.command) ||
    commandHasMarker(lifecycle.preStop?.exec?.command)
  ) {
    return false
  }

  if (
    (lifecycle.postStart && !lifecycle.postStart.exec) ||
    (lifecycle.preStop && !lifecycle.preStop.exec)
  ) {
    core.warning(
      'npu-metrics: container already has a non-exec lifecycle handler, skip injection'
    )
    return false
  }

  const samplerLine = `(${buildNpuSamplerScript(intervalSeconds)}) >/dev/null 2>&1 &`
  const aggregateLine = `{ ( ${buildNpuAggregateScript()} ) | head -c ${NPU_AGGREGATE_MAX_BYTES} > ${NPU_TERMINATION_LOG}; } 2>/dev/null || true`

  lifecycle.postStart = {
    exec: {
      command: appendExecCommand(lifecycle.postStart?.exec?.command, [
        `# ${NPU_METRICS_MARKER} postStart: start detached npu sampler`,
        samplerLine
      ])
    }
  }
  lifecycle.preStop = {
    exec: {
      command: appendExecCommand(lifecycle.preStop?.exec?.command, [
        `# ${NPU_METRICS_MARKER} preStop: write npu aggregate to termination log`,
        aggregateLine
      ])
    }
  }
  container.lifecycle = lifecycle
  return true
}

export function maybeInjectNpuMetrics(container: k8s.V1Container): boolean {
  if (!npuMetricsEnabled()) {
    return false
  }
  if (!containerHasNpuRequest(container)) {
    return false
  }
  return injectNpuMetrics(container)
}

export function parseNpuAggregate(
  raw: string | undefined
): NpuAggregatePayload | undefined {
  if (!raw) {
    return undefined
  }
  const start = raw.indexOf('{"v":')
  if (start === -1) {
    return undefined
  }
  const candidates = [raw.slice(start)]
  const end = raw.lastIndexOf('}')
  if (end > start) {
    candidates.push(raw.slice(start, end + 1))
  }
  for (const candidate of candidates) {
    let parsed: any
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (parsed?.v !== NPU_METRICS_MARKER || !Array.isArray(parsed.cards)) {
      continue
    }
    const cards: NpuCardAggregate[] = []
    for (const c of parsed.cards) {
      if (c === null || typeof c !== 'object' || c.c === undefined) {
        continue
      }
      cards.push({
        card: String(c.c),
        samples: Number(c.n) || 0,
        peakUtil: Number(c.pu) || 0,
        avgUtil: Number(c.au) || 0,
        peakHbm: Number(c.ph) || 0,
        firstTs: Number(c.fs) || 0,
        lastTs: Number(c.ls) || 0
      })
    }
    return { version: parsed.v, ts: Number(parsed.ts) || 0, cards }
  }
  return undefined
}

export function isIdleRecord(
  cards: NpuCardAggregate[],
  threshold = DEFAULT_NPU_IDLE_THRESHOLD_PERCENT
): boolean {
  if (!cards.length) {
    return false
  }
  return cards.every(c => c.peakUtil < threshold && c.avgUtil < threshold)
}

export function escapePromLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function formatPromLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${escapePromLabelValue(v)}"`)
    .join(',')
}

const NPU_JOB_METRIC_LABEL_KEYS = [
  'cluster',
  'namespace',
  'repo',
  'run_id',
  'pod',
  'pod_type',
  'card',
  'npu_type',
  'cards_requested',
  'result',
  'idle'
]

export function buildNpuJobMetricsBody(
  labels: NpuJobLabels,
  cards: NpuCardAggregate[],
  idleThreshold = DEFAULT_NPU_IDLE_THRESHOLD_PERCENT
): string {
  const base: Record<string, string> = {
    cluster: labels.cluster,
    namespace: labels.namespace,
    repo: labels.repo,
    run_id: labels.runId,
    pod: labels.pod,
    pod_type: labels.podType,
    npu_type: labels.npuType,
    cards_requested: labels.cardsRequested,
    result: labels.result
  }
  const idle = isIdleRecord(cards, idleThreshold) ? 'true' : 'false'
  const lines: string[] = []
  lines.push('# TYPE custom_npu_job_peak_util_percent gauge')
  lines.push('# TYPE custom_npu_job_avg_util_percent gauge')
  lines.push('# TYPE custom_npu_job_duration_seconds gauge')
  lines.push('# TYPE custom_npu_job_sample_count gauge')
  for (const card of cards) {
    const cardLabels = { ...base, card: card.card, idle }
    const l = formatPromLabels(
      Object.fromEntries(
        NPU_JOB_METRIC_LABEL_KEYS.map(k => [k, cardLabels[k]])
      ) as Record<string, string>
    )
    lines.push(`custom_npu_job_peak_util_percent{${l}} ${card.peakUtil}`)
    lines.push(`custom_npu_job_avg_util_percent{${l}} ${card.avgUtil}`)
    const duration = Math.max(card.lastTs - card.firstTs, 0)
    lines.push(`custom_npu_job_duration_seconds{${l}} ${duration}`)
    lines.push(`custom_npu_job_sample_count{${l}} ${card.samples}`)
  }
  lines.push('# TYPE custom_npu_job_push_total counter')
  lines.push(
    `custom_npu_job_push_total{cluster="${escapePromLabelValue(labels.cluster)}",namespace="${escapePromLabelValue(labels.namespace)}",status="success"} 1`
  )
  return lines.join('\n') + '\n'
}

export function buildNpuPushFailedBody(labels: NpuJobLabels): string {
  return (
    `# TYPE custom_npu_job_push_total counter\n` +
    `custom_npu_job_push_total{cluster="${escapePromLabelValue(labels.cluster)}",namespace="${escapePromLabelValue(labels.namespace)}",status="failed"} 1\n`
  )
}

export function buildPushgatewayPath(
  cluster: string,
  ns: string,
  pod: string
): string {
  return `/metrics/job/${NPU_METRICS_PUSH_JOB}/cluster/${encodeURIComponent(
    cluster
  )}/ns/${encodeURIComponent(ns)}/pod/${encodeURIComponent(pod)}`
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export interface PushRequest {
  url: string
  method: string
  body: string
  username?: string
  password?: string
  timeoutMs?: number
}

export type RequestFn = (req: PushRequest) => Promise<{ statusCode: number }>

export async function nodeRequest(req: PushRequest): Promise<{
  statusCode: number
}> {
  const target = new URL(req.url)
  const client = target.protocol === 'http:' ? http : https
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain'
  }
  if (req.username !== undefined || req.password !== undefined) {
    const basic = Buffer.from(
      `${req.username ?? ''}:${req.password ?? ''}`
    ).toString('base64')
    headers['Authorization'] = `Basic ${basic}`
  }
  return await new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: req.method,
        headers,
        timeout: req.timeoutMs ?? 5000,
        rejectUnauthorized: false
      },
      response => {
        response.resume()
        response.on('end', () =>
          resolve({ statusCode: response.statusCode ?? 0 })
        )
      }
    )
    request.on('timeout', () => request.destroy(new Error('request timeout')))
    request.on('error', reject)
    request.end(req.body)
  })
}

export async function pushToPushgateway(
  config: NpuPushConfig,
  path: string,
  body: string,
  options?: { retries?: number; retryDelayMs?: number; requestFn?: RequestFn }
): Promise<void> {
  const retries = options?.retries ?? 2
  const retryDelayMs = options?.retryDelayMs ?? 1000
  const requestFn = options?.requestFn ?? nodeRequest
  const url = `${config.url.replace(/\/+$/, '')}${path}`
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))
    }
    try {
      const response = await requestFn({
        url,
        method: 'POST',
        body,
        username: config.username,
        password: config.password
      })
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return
      }
      lastError = new Error(`pushgateway returned ${response.statusCode}`)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export function decodePushSecret(
  secret: k8s.V1Secret | undefined
): NpuPushConfig | undefined {
  const data = secret?.data ?? {}
  const decode = (key: string): string | undefined => {
    const encoded = data[key]
    if (!encoded) {
      return undefined
    }
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8')
      return decoded.length ? decoded : undefined
    } catch {
      return undefined
    }
  }
  const url = decode('PUSHGATEWAY_URL')
  if (!url) {
    return undefined
  }
  return {
    url,
    username: decode('PUSHGATEWAY_USER'),
    password: decode('PUSHGATEWAY_PASSWORD')
  }
}

export async function readNpuPushConfig(): Promise<NpuPushConfig | undefined> {
  try {
    const secret = await getSecretByName(NPU_METRICS_SECRET_NAME)
    return decodePushSecret(secret)
  } catch (err) {
    core.debug(
      `npu-metrics: secret ${NPU_METRICS_SECRET_NAME} unavailable, skip push: ${formatError(err)}`
    )
    return undefined
  }
}

function parseScaleSetSuffix(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const match = value.match(SCALE_SET_NAME_REGEX)
  return match ? match[1] : undefined
}

export function extractClusterFromRunnerPod(pod: k8s.V1Pod): string {
  const labels = pod.metadata?.labels ?? {}
  const annotations = pod.metadata?.annotations ?? {}
  const entries: [string, string][] = [
    ...Object.entries(labels),
    ...Object.entries(annotations)
  ]
  for (const [key, value] of entries) {
    if (/scale[-_]?set|runner[-_]?deployment/i.test(key)) {
      const suffix = parseScaleSetSuffix(value)
      if (suffix) {
        return suffix
      }
    }
  }
  for (const [, value] of entries) {
    const suffix = parseScaleSetSuffix(value)
    if (suffix) {
      return suffix
    }
  }
  return parseScaleSetSuffix(pod.metadata?.name) ?? 'unknown'
}

export function resolveNpuLabelsFromPod(
  pod: k8s.V1Pod,
  podName: string
): {
  podType: string
  npuType: string
  cardsRequested: string
  result: string
} {
  const podType = podName.includes('-step-') ? 'step' : 'workflow'
  const npuTypes = new Set<string>()
  let cards = 0
  for (const container of pod.spec?.containers ?? []) {
    for (const resources of [
      container.resources?.requests,
      container.resources?.limits
    ]) {
      for (const [key, quantity] of Object.entries(resources ?? {})) {
        const match = key.match(NPU_RESOURCE_REGEX)
        if (match) {
          npuTypes.add(match[1])
          cards = Math.max(cards, parseInt(String(quantity), 10) || 0)
        }
      }
    }
  }
  const mainStatus = (pod.status?.containerStatuses ?? []).find(
    s => s.name === JOB_CONTAINER_NAME
  )
  const terminated = mainStatus?.state?.terminated
  const result = terminated
    ? String(terminated.exitCode)
    : (pod.status?.phase ?? 'unknown')
  return {
    podType,
    npuType: Array.from(npuTypes).sort().join(',') || 'unknown',
    cardsRequested: String(cards || 0),
    result
  }
}

export function repoFromEnv(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.GITHUB_REPOSITORY) {
    return env.GITHUB_REPOSITORY
  }
  const workspace = env.GITHUB_WORKSPACE ?? ''
  const parts = workspace.split('/').filter(p => p.length > 0)
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  }
  return 'unknown'
}

export async function collectNpuAggregateFromPod(
  pod: k8s.V1Pod
): Promise<NpuAggregatePayload | undefined> {
  const podName = pod.metadata?.name
  if (!podName) {
    return undefined
  }
  const mainStatus = (pod.status?.containerStatuses ?? []).find(
    s => s.name === JOB_CONTAINER_NAME
  )
  const terminatedMessage = mainStatus?.state?.terminated?.message
  if (terminatedMessage) {
    return parseNpuAggregate(terminatedMessage)
  }
  if (!mainStatus?.state?.running) {
    return undefined
  }
  const { output } = await execPodStepWithOutput(
    ['sh', '-c', buildNpuAggregateScript()],
    podName,
    JOB_CONTAINER_NAME,
    5
  )
  return parseNpuAggregate(output)
}

export async function collectAndPushNpuMetrics(): Promise<void> {
  if (!npuMetricsEnabled()) {
    return
  }
  let pods: k8s.V1Pod[] = []
  try {
    pods = await listPodsByRunnerInstance()
  } catch (err) {
    core.debug(`npu-metrics: pod list failed: ${formatError(err)}`)
    return
  }
  const npuPods = pods.filter(
    pod => pod.metadata?.name && hasNpuRequest(pod.spec)
  )
  if (!npuPods.length) {
    return
  }

  let cluster = 'unknown'
  try {
    const runnerPod = await getPodByName(getRunnerPodName())
    cluster = extractClusterFromRunnerPod(runnerPod)
  } catch (err) {
    core.debug(`npu-metrics: cluster label unresolved: ${formatError(err)}`)
  }

  const config = await readNpuPushConfig()
  if (!config) {
    core.debug(
      `npu-metrics: push config missing (secret ${NPU_METRICS_SECRET_NAME}), skip push`
    )
    return
  }

  for (const pod of npuPods) {
    const podName = pod.metadata?.name as string
    try {
      await collectAndPushForPod(pod, podName, cluster, config)
    } catch (err) {
      core.debug(
        `npu-metrics: collection failed for ${podName}: ${formatError(err)}`
      )
    }
  }
}

async function collectAndPushForPod(
  pod: k8s.V1Pod,
  podName: string,
  cluster: string,
  config: NpuPushConfig
): Promise<void> {
  const payload = await collectNpuAggregateFromPod(pod)
  if (!payload || !payload.cards.length) {
    core.debug(`npu-metrics: no aggregate payload for ${podName}, skip`)
    return
  }

  const npuInfo = resolveNpuLabelsFromPod(pod, podName)
  const labels: NpuJobLabels = {
    cluster,
    namespace: namespace(),
    pod: podName,
    podType: npuInfo.podType,
    repo: repoFromEnv(),
    runId: process.env.GITHUB_RUN_ID ?? '',
    npuType: npuInfo.npuType,
    cardsRequested: npuInfo.cardsRequested,
    result: npuInfo.result
  }

  const body = buildNpuJobMetricsBody(
    labels,
    payload.cards,
    getIdleThresholdPercent()
  )
  const path = buildPushgatewayPath(labels.cluster, labels.namespace, podName)
  try {
    await pushToPushgateway(config, path, body)
    core.debug(`npu-metrics: pushed job record for ${podName}`)
  } catch (err) {
    core.warning(`npu-metrics: push failed for ${podName}: ${formatError(err)}`)
    try {
      await pushToPushgateway(config, path, buildNpuPushFailedBody(labels))
    } catch {
      // pushgateway unreachable, nothing else to record
    }
  }
}
