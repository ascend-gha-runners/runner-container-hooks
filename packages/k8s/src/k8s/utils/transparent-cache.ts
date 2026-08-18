import * as k8s from '@kubernetes/client-node'
import * as http from 'http'
import * as core from '@actions/core'

// ── Transparent cache injection (issue #1133) ────────────────────────────────
//
// When the runner (listener) is configured with the ACTIONS_RUNNER_CACHE_* env
// vars below, every job pod created by the k8s hook transparently gets:
//   1. HTTP_PROXY/HTTPS_PROXY/NO_PROXY (+ lowercase) env vars pointing at the
//      cluster squid caching proxy — only when the proxy answers a health
//      probe (fail-open: a dead proxy must not break every job).
//   2. The squid CA certificate mounted at /etc/squid-ca plus the usual
//      *_CA_* env vars (SSL_CERT_FILE, CURL_CA_BUNDLE, …) so TLS through the
//      MITM proxy verifies.
//   3. An opt-out postStart hook that installs the CA into the container's
//      system trust store (apt/yum only read the compiled bundle).
//
// Everything is gated: if ACTIONS_RUNNER_ENABLE_TRANSPARENT_CACHE is not
// exactly "true" (or the proxy is missing) the pod spec is left untouched.

export const ENV_ENABLE_TRANSPARENT_CACHE =
  'ACTIONS_RUNNER_ENABLE_TRANSPARENT_CACHE'
export const ENV_CACHE_PROXY = 'ACTIONS_RUNNER_CACHE_PROXY'
export const ENV_CACHE_NO_PROXY = 'ACTIONS_RUNNER_CACHE_NO_PROXY'
export const ENV_CACHE_CA_SECRET = 'ACTIONS_RUNNER_CACHE_CA_SECRET'
export const ENV_CACHE_CA_TRUST_HOOK = 'ACTIONS_RUNNER_CACHE_CA_TRUST_HOOK'

export const DEFAULT_CA_SECRET_NAME = 'squid-ca-cert'
export const DEFAULT_NO_PROXY =
  'localhost,127.0.0.1,::1,.svc,.cluster.local,10.0.0.0/8,169.254.169.254'

const CA_VOLUME_NAME = 'squid-ca'
const CA_MOUNT_PATH = '/etc/squid-ca'
const CA_KEY = 'squid-ca.pem'

export interface TransparentCacheConfig {
  proxy: string
  noProxy: string
  caSecret: string
  caTrustHook: boolean
}

export interface InjectionResult {
  /** CA volume/env injected into at least one container */
  caInjected: boolean
  /** proxy env vars injected (requires healthy proxy) */
  proxyEnvInjected: boolean
}

// Normalize a bare host:port into a full http URL.
export function normalizeProxyUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

// Reads the runner env and returns the injection config, or undefined when
// the feature is disabled or incomplete (gate: never partially inject).
export function readTransparentCacheConfig(
  env: Record<string, string | undefined> = process.env
): TransparentCacheConfig | undefined {
  if (env[ENV_ENABLE_TRANSPARENT_CACHE] !== 'true') {
    return undefined
  }
  const proxy = normalizeProxyUrl(env[ENV_CACHE_PROXY] ?? '')
  if (!proxy) {
    core.warning(
      `${ENV_ENABLE_TRANSPARENT_CACHE}=true but ${ENV_CACHE_PROXY} is unset; transparent cache disabled`
    )
    return undefined
  }
  return {
    proxy,
    noProxy: env[ENV_CACHE_NO_PROXY]?.trim() || DEFAULT_NO_PROXY,
    caSecret: env[ENV_CACHE_CA_SECRET]?.trim() || DEFAULT_CA_SECRET_NAME,
    caTrustHook: env[ENV_CACHE_CA_TRUST_HOOK] !== 'false'
  }
}

// ── Proxy health probe (fail-open escape, REL-1) ─────────────────────────────
//
// A short-lived HTTP request through the proxy port; any HTTP response means
// the proxy is alive. Results are cached for PROBE_CACHE_TTL_MS so a burst of
// job pods does not re-probe per pod.

const PROBE_TIMEOUT_MS = 2000
const PROBE_CACHE_TTL_MS = 30_000

let probeCache: { proxy: string; healthy: boolean; at: number } | undefined

export function resetProxyHealthCache(): void {
  probeCache = undefined
}

export async function isProxyHealthy(
  proxyUrl: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean> {
  const now = Date.now()
  if (
    probeCache &&
    probeCache.proxy === proxyUrl &&
    now - probeCache.at < PROBE_CACHE_TTL_MS
  ) {
    return probeCache.healthy
  }
  const healthy = await probeProxy(proxyUrl, timeoutMs)
  probeCache = { proxy: proxyUrl, healthy, at: now }
  return healthy
}

async function probeProxy(
  proxyUrl: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    let url: URL
    try {
      url = new URL(proxyUrl)
    } catch {
      finish(false)
      return
    }
    try {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          method: 'HEAD',
          path: '/',
          timeout: timeoutMs
        },
        res => {
          res.resume()
          finish(true)
        }
      )
      req.on('timeout', () => {
        req.destroy()
        finish(false)
      })
      req.on('error', () => finish(false))
      req.end()
    } catch {
      finish(false)
    }
  })
}

// Best-effort CA install for apt/yum/dnf which only read the compiled system
// bundle. Runs inside the job container: every statement is fault tolerant and
// the script always exits 0 (a failing postStart hook kills the pod).
const CA_TRUST_SCRIPT = [
  '/bin/sh',
  '-c',
  `SQUID_CA=${CA_MOUNT_PATH}/${CA_KEY}
i=0
while [ $i -lt 10 ] && [ ! -f "$SQUID_CA" ]; do sleep 1; i=$((i+1)); done
if [ -f "$SQUID_CA" ]; then
  if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    cat "$SQUID_CA" >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true
    command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates 2>/dev/null || true
  fi
  mkdir -p /etc/pki/ca-trust/source/anchors 2>/dev/null || true
  cp "$SQUID_CA" /etc/pki/ca-trust/source/anchors/squid-ca.crt 2>/dev/null || true
  command -v update-ca-trust >/dev/null 2>&1 && update-ca-trust extract 2>/dev/null || true
fi
exit 0`
]

function addEnvIfMissing(
  container: k8s.V1Container,
  name: string,
  value: string
): boolean {
  if (container.env?.some(e => e.name === name)) return false
  container.env = container.env ?? []
  container.env.push({ name, value })
  return true
}

// Injects the transparent cache into a pod spec. Pure spec mutation, no I/O:
// `proxyHealthy` is decided by the caller (see maybeInjectTransparentCache).
export function injectTransparentCache(
  spec: k8s.V1PodSpec,
  config: TransparentCacheConfig,
  opts: { proxyHealthy: boolean }
): InjectionResult {
  const result: InjectionResult = { caInjected: false, proxyEnvInjected: false }
  const containers = spec.containers ?? []
  if (containers.length === 0) return result

  // CA volume (skip silently when the name is already taken — an ops-provided
  // template owns it then).
  const volumeExists =
    spec.volumes?.some(v => v.name === CA_VOLUME_NAME) ?? false
  if (!volumeExists) {
    spec.volumes = spec.volumes ?? []
    spec.volumes.push({
      name: CA_VOLUME_NAME,
      secret: {
        secretName: config.caSecret,
        items: [{ key: CA_KEY, path: CA_KEY }]
      }
    })
  }

  const proxyEnvs: [string, string][] = opts.proxyHealthy
    ? [
        ['HTTP_PROXY', config.proxy],
        ['HTTPS_PROXY', config.proxy],
        ['http_proxy', config.proxy],
        ['https_proxy', config.proxy],
        ['NO_PROXY', config.noProxy],
        ['no_proxy', config.noProxy]
      ]
    : []

  for (const container of containers) {
    // CA mount
    if (!container.volumeMounts?.some(m => m.name === CA_VOLUME_NAME)) {
      container.volumeMounts = container.volumeMounts ?? []
      container.volumeMounts.push({
        name: CA_VOLUME_NAME,
        mountPath: CA_MOUNT_PATH,
        readOnly: true
      })
    }
    // CA env vars (only the common readers of a PEM file; apt/yum are covered
    // by the postStart hook below)
    addEnvIfMissing(container, 'SSL_CERT_FILE', `${CA_MOUNT_PATH}/${CA_KEY}`)
    addEnvIfMissing(container, 'CURL_CA_BUNDLE', `${CA_MOUNT_PATH}/${CA_KEY}`)
    addEnvIfMissing(
      container,
      'REQUESTS_CA_BUNDLE',
      `${CA_MOUNT_PATH}/${CA_KEY}`
    )
    addEnvIfMissing(container, 'GIT_SSL_CAINFO', `${CA_MOUNT_PATH}/${CA_KEY}`)
    addEnvIfMissing(container, 'PIP_CERT', `${CA_MOUNT_PATH}/${CA_KEY}`)
    addEnvIfMissing(
      container,
      'NODE_EXTRA_CA_CERTS',
      `${CA_MOUNT_PATH}/${CA_KEY}`
    )
    result.caInjected = true

    for (const [name, value] of proxyEnvs) {
      if (addEnvIfMissing(container, name, value)) {
        result.proxyEnvInjected = true
      }
    }

    // System trust store install — only when the container does not already
    // define a postStart hook (ops-owned) and the fleet did not opt out.
    if (config.caTrustHook && !container.lifecycle?.postStart) {
      container.lifecycle = container.lifecycle ?? {}
      container.lifecycle.postStart = { exec: { command: CA_TRUST_SCRIPT } }
    }
  }
  return result
}

// Entry point used by createJobPod/createContainerStepPod: reads the runner
// env, verifies the CA secret exists, probes the proxy health and applies the
// injection. No-op when the feature is not enabled. When the CA secret is
// missing nothing is injected at all — a pod referencing a non-existent
// secret fails to mount, which would break every job.
export async function maybeInjectTransparentCache(
  spec: k8s.V1PodSpec,
  env: Record<string, string | undefined> = process.env,
  deps: { secretExists?: (name: string) => Promise<boolean> } = {}
): Promise<InjectionResult | undefined> {
  const config = readTransparentCacheConfig(env)
  if (!config) return undefined
  if (deps.secretExists) {
    let exists = false
    try {
      exists = await deps.secretExists(config.caSecret)
    } catch {
      exists = false
    }
    if (!exists) {
      core.warning(
        `[transparent-cache] secret ${config.caSecret} not found in the runner namespace — skipping injection entirely`
      )
      return undefined
    }
  }
  let healthy = false
  try {
    healthy = await isProxyHealthy(config.proxy)
  } catch {
    healthy = false
  }
  if (!healthy) {
    core.warning(
      `[transparent-cache] proxy ${config.proxy} unhealthy — injecting CA only, job pods go direct`
    )
  }
  return injectTransparentCache(spec, config, { proxyHealthy: healthy })
}
