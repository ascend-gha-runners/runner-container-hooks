import * as k8s from '@kubernetes/client-node'
import * as http from 'http'
import * as net from 'net'
import type { AddressInfo } from 'net'

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('../index', () => ({
  execPodStepWithOutput: vi.fn(),
  getPodByName: vi.fn(),
  getSecretByName: vi.fn(),
  listPodsByRunnerInstance: vi.fn(),
  namespace: vi.fn().mockReturnValue('test-ns')
}))

import {
  NPU_METRICS_MARKER,
  buildNpuAggregateScript,
  buildNpuJobMetricsBody,
  buildNpuPushFailedBody,
  buildNpuSamplerScript,
  buildPushgatewayPath,
  collectAndPushNpuMetrics,
  collectNpuAggregateFromPod,
  containerHasNpuRequest,
  decodePushSecret,
  escapePromLabelValue,
  extractClusterFromRunnerPod,
  getIdleThresholdPercent,
  getNpuSampleIntervalSeconds,
  hasNpuRequest,
  injectNpuMetrics,
  isIdleRecord,
  maybeInjectNpuMetrics,
  nodeRequest,
  npuMetricsEnabled,
  parseNpuAggregate,
  pushToPushgateway,
  repoFromEnv,
  resolveNpuLabelsFromPod,
  withTimeout
} from './npu-metrics'
import * as k8sMod from '../index'

function makeContainer(
  overrides: Partial<k8s.V1Container> = {}
): k8s.V1Container {
  return {
    name: 'job',
    image: 'ubuntu:latest',
    ...overrides
  } as k8s.V1Container
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

// ── toggles and thresholds ─────────────────────────────────────────────────────

describe('npuMetricsEnabled', () => {
  it('defaults to enabled', () => {
    expect(npuMetricsEnabled({})).toBe(true)
  })
  it('disables on disabled', () => {
    expect(
      npuMetricsEnabled({
        ACTIONS_RUNNER_NPU_METRICS: 'disabled'
      })
    ).toBe(false)
  })
  it('is case-insensitive and trims', () => {
    expect(
      npuMetricsEnabled({
        ACTIONS_RUNNER_NPU_METRICS: ' DISABLED '
      })
    ).toBe(false)
  })
  it('keeps enabled for other values', () => {
    expect(
      npuMetricsEnabled({
        ACTIONS_RUNNER_NPU_METRICS: 'enabled'
      })
    ).toBe(true)
  })
})

describe('getNpuSampleIntervalSeconds', () => {
  it('defaults to 1s', () => {
    expect(getNpuSampleIntervalSeconds({})).toBe(1)
  })
  it('parses a valid value', () => {
    expect(
      getNpuSampleIntervalSeconds({
        NPU_SAMPLE_INTERVAL: '0.5'
      })
    ).toBe(0.5)
  })
  it('clamps to the 0.2s minimum', () => {
    expect(
      getNpuSampleIntervalSeconds({
        NPU_SAMPLE_INTERVAL: '0.01'
      })
    ).toBe(0.2)
  })
  it('falls back to default on invalid input', () => {
    expect(
      getNpuSampleIntervalSeconds({
        NPU_SAMPLE_INTERVAL: 'abc'
      })
    ).toBe(1)
    expect(
      getNpuSampleIntervalSeconds({
        NPU_SAMPLE_INTERVAL: '-2'
      })
    ).toBe(1)
  })
})

describe('getIdleThresholdPercent', () => {
  it('defaults to 5', () => {
    expect(getIdleThresholdPercent({})).toBe(5)
  })
  it('parses a custom threshold', () => {
    expect(getIdleThresholdPercent({ NPU_IDLE_THRESHOLD: '10' })).toBe(10)
  })
  it('falls back to default on invalid input', () => {
    expect(
      getIdleThresholdPercent({
        NPU_IDLE_THRESHOLD: 'oops'
      })
    ).toBe(5)
  })
})

// ── detection ──────────────────────────────────────────────────────────────────

describe('containerHasNpuRequest / hasNpuRequest', () => {
  it('detects ascend resource requests', () => {
    const c = makeContainer({
      resources: { requests: { 'huawei.com/ascend-1980': '8' } }
    })
    expect(containerHasNpuRequest(c)).toBe(true)
  })
  it('detects ascend resource limits only', () => {
    const c = makeContainer({
      resources: { limits: { 'huawei.com/ascend-310': '1' } }
    })
    expect(containerHasNpuRequest(c)).toBe(true)
  })
  it('rejects non-ascend resources', () => {
    const c = makeContainer({
      resources: { requests: { cpu: '2', 'nvidia.com/gpu': '1' } }
    })
    expect(containerHasNpuRequest(c)).toBe(false)
  })
  it('handles empty resources', () => {
    expect(containerHasNpuRequest(makeContainer())).toBe(false)
    expect(hasNpuRequest(undefined)).toBe(false)
  })
  it('hasNpuRequest scans all containers', () => {
    const spec = {
      containers: [
        makeContainer({ name: 'a' }),
        makeContainer({
          name: 'b',
          resources: { requests: { 'huawei.com/ascend-910b': '2' } }
        })
      ]
    } as k8s.V1PodSpec
    expect(hasNpuRequest(spec)).toBe(true)
  })
})

// ── shell scripts ──────────────────────────────────────────────────────────────

describe('buildNpuSamplerScript', () => {
  it('embeds the marker, card enumeration and interval', () => {
    const script = buildNpuSamplerScript(1)
    expect(script).toContain(NPU_METRICS_MARKER)
    expect(script).toContain('/dev/davinci[0-9]*')
    expect(script).toContain('npu-smi info -t usages')
    expect(script).toContain('sleep 1')
    expect(script).toContain('/tmp/npu-samples.jsonl')
  })
  it('rotates the samples file above the size cap', () => {
    expect(buildNpuSamplerScript()).toContain('-gt 4194304')
  })
  it('substitutes the requested interval', () => {
    expect(buildNpuSamplerScript(0.25)).toContain('sleep 0.25')
  })
})

describe('buildNpuAggregateScript', () => {
  it('aggregates samples and prints the marker payload', () => {
    const script = buildNpuAggregateScript()
    expect(script).toContain(NPU_METRICS_MARKER)
    expect(script).toContain('awk -v now=')
    expect(script).toContain('touch "$F"')
  })
})

// ── injection ──────────────────────────────────────────────────────────────────

describe('injectNpuMetrics / maybeInjectNpuMetrics', () => {
  afterEach(() => {
    delete process.env.ACTIONS_RUNNER_NPU_METRICS
  })

  it('injects lifecycle hooks on a bare container', () => {
    const c = makeContainer()
    expect(injectNpuMetrics(c)).toBe(true)
    expect(c.lifecycle?.postStart?.exec?.command?.[0]).toBe('sh')
    expect(c.lifecycle?.postStart?.exec?.command?.[1]).toBe('-c')
    expect(c.lifecycle?.postStart?.exec?.command?.[2]).toContain(
      NPU_METRICS_MARKER
    )
    expect(c.lifecycle?.postStart?.exec?.command?.[2]).toContain(
      '/tmp/npu-samples.jsonl'
    )
    expect(c.lifecycle?.preStop?.exec?.command?.[2]).toContain(
      `head -c 4096 > /dev/termination-log`
    )
  })

  it('appends to an existing sh -c postStart without touching it', () => {
    const c = makeContainer({
      lifecycle: {
        postStart: {
          exec: { command: ['/bin/sh', '-c', 'echo npu-precheck'] }
        }
      }
    })
    expect(injectNpuMetrics(c)).toBe(true)
    const command = c.lifecycle?.postStart?.exec?.command
    expect(command?.[0]).toBe('/bin/sh')
    const script = command?.[2] ?? ''
    expect(script).toContain('echo npu-precheck')
    expect(script).toContain(NPU_METRICS_MARKER)
    const lines = script.split('\n')
    expect(lines[0]).toBe('echo npu-precheck')
  })

  it('wraps an arbitrary existing command', () => {
    const c = makeContainer({
      lifecycle: {
        postStart: { exec: { command: ['/usr/bin/check', '--flag'] } }
      }
    })
    expect(injectNpuMetrics(c)).toBe(true)
    const command = c.lifecycle?.postStart?.exec?.command
    expect(command?.[0]).toBe('sh')
    expect(command?.[1]).toBe('-c')
    expect(command?.[2]).toContain(`'/usr/bin/check' '--flag'`)
    expect(command?.[2]).toContain(NPU_METRICS_MARKER)
  })

  it('is idempotent via the marker', () => {
    const c = makeContainer()
    injectNpuMetrics(c)
    const frozen = JSON.stringify(c.lifecycle)
    expect(injectNpuMetrics(c)).toBe(false)
    expect(JSON.stringify(c.lifecycle)).toBe(frozen)
  })

  it('skips when a non-exec handler already exists', () => {
    const c = makeContainer({
      lifecycle: {
        postStart: { httpGet: { path: '/x', port: 80 } }
      }
    })
    expect(injectNpuMetrics(c)).toBe(false)
    expect(c.lifecycle?.postStart?.httpGet?.path).toBe('/x')
  })

  it('maybeInject skips when disabled', () => {
    process.env.ACTIONS_RUNNER_NPU_METRICS = 'disabled'
    const c = makeContainer({
      resources: { requests: { 'huawei.com/ascend-1980': '8' } }
    })
    expect(maybeInjectNpuMetrics(c)).toBe(false)
    expect(c.lifecycle).toBeUndefined()
  })

  it('maybeInject skips without an npu request', () => {
    const c = makeContainer()
    expect(maybeInjectNpuMetrics(c)).toBe(false)
    expect(c.lifecycle).toBeUndefined()
  })

  it('maybeInject injects with an npu request', () => {
    const c = makeContainer({
      resources: { requests: { 'huawei.com/ascend-1980': '8' } }
    })
    expect(maybeInjectNpuMetrics(c)).toBe(true)
    expect(c.lifecycle?.postStart).toBeDefined()
  })
})

// ── parsing and idle ───────────────────────────────────────────────────────────

describe('parseNpuAggregate', () => {
  it('parses a valid payload', () => {
    const payload = parseNpuAggregate(
      `{"v":"NPU_METRICS_V1","ts":1690000100,"cards":[{"c":"0","n":3,"pu":88.5,"au":51.2,"ph":77,"fs":1690000000,"ls":1690000002}]}\n`
    )
    expect(payload?.version).toBe(NPU_METRICS_MARKER)
    expect(payload?.cards).toHaveLength(1)
    expect(payload?.cards[0]).toEqual({
      card: '0',
      samples: 3,
      peakUtil: 88.5,
      avgUtil: 51.2,
      peakHbm: 77,
      firstTs: 1690000000,
      lastTs: 1690000002
    })
  })
  it('parses payload embedded in junk (termination message)', () => {
    const payload = parseNpuAggregate(`pre {"v":"NPU_METRICS_V1"`)
    expect(payload).toBeUndefined()
  })
  it('extracts payload with prefix and suffix junk', () => {
    const payload = parseNpuAggregate(
      `some-prefix {"v":"NPU_METRICS_V1","ts":1,"cards":[]} trailing`
    )
    expect(payload?.version).toBe(NPU_METRICS_MARKER)
    expect(payload?.cards).toHaveLength(0)
  })
  it('returns undefined for missing or invalid input', () => {
    expect(parseNpuAggregate(undefined)).toBeUndefined()
    expect(parseNpuAggregate('')).toBeUndefined()
    expect(parseNpuAggregate('no json here')).toBeUndefined()
    expect(parseNpuAggregate('{"v":"OTHER","ts":1,"cards":[]}')).toBeUndefined()
  })
  it('drops malformed card entries', () => {
    const payload = parseNpuAggregate(
      `{"v":"NPU_METRICS_V1","ts":1,"cards":[{"c":"0","n":1},null,{"x":1}]}`
    )
    expect(payload?.cards).toHaveLength(1)
    expect(payload?.cards[0].samples).toBe(1)
  })
})

describe('isIdleRecord', () => {
  const card = (pu: number, au: number) => ({
    card: '0',
    samples: 5,
    peakUtil: pu,
    avgUtil: au,
    peakHbm: 10,
    firstTs: 1,
    lastTs: 2
  })
  it('marks all-low records idle', () => {
    expect(isIdleRecord([card(4.9, 1.2), card(0, 0)])).toBe(true)
  })
  it('marks records with any busy card as not idle', () => {
    expect(isIdleRecord([card(4.9, 1.2), card(12, 3)])).toBe(false)
  })
  it('treats the 5% threshold as exclusive', () => {
    expect(isIdleRecord([card(5, 1)])).toBe(false)
    expect(isIdleRecord([card(4.99, 4.99)])).toBe(true)
  })
  it('honours a custom threshold', () => {
    expect(isIdleRecord([card(8, 8)], 10)).toBe(true)
  })
  it('empty records are not idle', () => {
    expect(isIdleRecord([])).toBe(false)
  })
})

// ── prometheus text ────────────────────────────────────────────────────────────

describe('prometheus formatting', () => {
  const labels = {
    cluster: 'gy005',
    namespace: 'test-ns',
    pod: 'runner-x-workflow',
    podType: 'workflow',
    repo: 'org/repo',
    runId: '123',
    npuType: 'ascend-1980',
    cardsRequested: '8',
    result: '0'
  }
  const card = {
    card: '1',
    samples: 4,
    peakUtil: 88,
    avgUtil: 40,
    peakHbm: 66,
    firstTs: 100,
    lastTs: 145
  }

  it('escapes label values', () => {
    expect(escapePromLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd')
  })

  it('emits one series per metric per card with the idle label', () => {
    const body = buildNpuJobMetricsBody(labels, [card])
    const expectedLabels =
      `cluster="gy005",namespace="test-ns",repo="org/repo",run_id="123",` +
      `pod="runner-x-workflow",pod_type="workflow",card="1",` +
      `npu_type="ascend-1980",cards_requested="8",result="0",idle="false"`
    expect(body).toContain(
      `custom_npu_job_peak_util_percent{${expectedLabels}} 88`
    )
    expect(body).toContain(
      `custom_npu_job_avg_util_percent{${expectedLabels}} 40`
    )
    expect(body).toContain(
      `custom_npu_job_duration_seconds{${expectedLabels}} 45`
    )
    expect(body).toContain(`custom_npu_job_sample_count{${expectedLabels}} 4`)
    expect(body).toContain(
      `custom_npu_job_push_total{cluster="gy005",namespace="test-ns",status="success"} 1`
    )
  })

  it('marks idle records', () => {
    const idleCard = { ...card, peakUtil: 0, avgUtil: 0 }
    expect(buildNpuJobMetricsBody(labels, [idleCard])).toContain('idle="true"')
  })

  it('emits a failed counter body', () => {
    expect(buildNpuPushFailedBody(labels)).toContain('status="failed"')
  })

  it('builds the pushgateway grouping path with encoding', () => {
    expect(buildPushgatewayPath('gy005', 'ns-a', 'pod/b')).toBe(
      '/metrics/job/npu-job-record/cluster/gy005/ns/ns-a/pod/pod%2Fb'
    )
  })
})

// ── timeout / http ─────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('passes the value through when fast', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7)
  })
  it('rejects when the promise exceeds the budget', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 500, 'late'))
    await expect(withTimeout(slow, 20)).rejects.toThrow('timeout')
  })
  it('propagates promise rejections', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000)
    ).rejects.toThrow('boom')
  })
})

describe('nodeRequest', () => {
  let server: http.Server
  let port: number
  let seen: { auth?: string; body?: string; path?: string }

  beforeAll(async () => {
    seen = {}
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        seen = { auth: req.headers.authorization, body, path: req.url }
        res.statusCode = 204
        res.end()
      })
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('posts the body with basic auth over http', async () => {
    const response = await nodeRequest({
      url: `http://127.0.0.1:${port}/metrics/job/npu-job-record`,
      method: 'POST',
      body: 'custom_npu_job_peak_util_percent 1',
      username: 'user',
      password: 'pass'
    })
    expect(response.statusCode).toBe(204)
    expect(seen.path).toBe('/metrics/job/npu-job-record')
    expect(seen.auth).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`
    )
    expect(seen.body).toContain('custom_npu_job_peak_util_percent')
  })

  it('rejects on connection errors', async () => {
    const socket = new net.Socket()
    const freePort = (socket.address() as AddressInfo)?.port
    socket.destroy()
    await expect(
      nodeRequest({
        url: `http://127.0.0.1:${freePort + 1}/metrics`,
        method: 'POST',
        body: 'x',
        timeoutMs: 1000
      })
    ).rejects.toThrow()
  })
})

describe('pushToPushgateway', () => {
  const config = { url: 'http://pgw.example', username: 'u', password: 'p' }

  it('succeeds on 2xx without retries', async () => {
    const requestFn = vi.fn().mockResolvedValue({ statusCode: 200 })
    await pushToPushgateway(config, '/metrics/job/x', 'body', { requestFn })
    expect(requestFn).toHaveBeenCalledTimes(1)
    expect(requestFn).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://pgw.example/metrics/job/x',
        method: 'POST',
        body: 'body',
        username: 'u',
        password: 'p'
      })
    )
  })

  it('retries failures and succeeds eventually', async () => {
    const requestFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockResolvedValueOnce({ statusCode: 202 })
    await pushToPushgateway(config, '/metrics/job/x', 'body', {
      requestFn,
      retryDelayMs: 0
    })
    expect(requestFn).toHaveBeenCalledTimes(2)
  })

  it('gives up after the configured retries', async () => {
    const requestFn = vi.fn().mockRejectedValue(new Error('down'))
    await expect(
      pushToPushgateway(config, '/metrics/job/x', 'body', {
        requestFn,
        retryDelayMs: 0
      })
    ).rejects.toThrow('down')
    expect(requestFn).toHaveBeenCalledTimes(3)
  })

  it('treats non-2xx as failure and retries', async () => {
    const requestFn = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 500 })
      .mockResolvedValue({ statusCode: 200 })
    await pushToPushgateway(config, '/metrics/job/x', 'body', {
      requestFn,
      retryDelayMs: 0
    })
    expect(requestFn).toHaveBeenCalledTimes(2)
  })

  it('strips trailing slashes from the base url', async () => {
    const requestFn = vi.fn().mockResolvedValue({ statusCode: 200 })
    await pushToPushgateway(
      { url: 'http://pgw.example/' },
      '/metrics/job/x',
      'body',
      { requestFn }
    )
    expect(requestFn).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://pgw.example/metrics/job/x' })
    )
  })
})

// ── secret / labels ────────────────────────────────────────────────────────────

describe('decodePushSecret', () => {
  it('decodes url, user and password', () => {
    const secret = {
      data: {
        PUSHGATEWAY_URL: b64('http://pgw:9091'),
        PUSHGATEWAY_USER: b64('u'),
        PUSHGATEWAY_PASSWORD: b64('p')
      }
    } as k8s.V1Secret
    expect(decodePushSecret(secret)).toEqual({
      url: 'http://pgw:9091',
      username: 'u',
      password: 'p'
    })
  })
  it('requires the url key', () => {
    expect(
      decodePushSecret({ data: { PUSHGATEWAY_USER: b64('u') } } as k8s.V1Secret)
    ).toBeUndefined()
    expect(decodePushSecret(undefined)).toBeUndefined()
    expect(decodePushSecret({} as k8s.V1Secret)).toBeUndefined()
  })
})

describe('extractClusterFromRunnerPod', () => {
  it('prefers scale-set-like label keys', () => {
    const pod = {
      metadata: {
        name: 'ephemeral-abc',
        labels: {
          'actions.github.com/scale-set-name': 'linux-aarch64-a3-2-gy005'
        }
      }
    } as k8s.V1Pod
    expect(extractClusterFromRunnerPod(pod)).toBe('gy005')
  })
  it('falls back to any label value shaped like a scale set name', () => {
    const pod = {
      metadata: {
        name: 'pod',
        labels: { misc: 'linux-aarch64-910b-8-wlcb-001' }
      }
    } as k8s.V1Pod
    expect(extractClusterFromRunnerPod(pod)).toBe('wlcb-001')
  })
  it('falls back to the pod name', () => {
    const pod = {
      metadata: { name: 'linux-aarch64-a3-2-cn12-001', labels: {} }
    } as k8s.V1Pod
    expect(extractClusterFromRunnerPod(pod)).toBe('cn12-001')
  })
  it('returns unknown when nothing matches', () => {
    const pod = {
      metadata: { name: 'linux-aarch64-a3-2', labels: { app: 'x' } }
    } as k8s.V1Pod
    expect(extractClusterFromRunnerPod(pod)).toBe('unknown')
  })
  it('does not treat a numeric suffix as a cluster', () => {
    const pod = {
      metadata: { name: 'linux-aarch64-a3-2', labels: {} }
    } as k8s.V1Pod
    expect(extractClusterFromRunnerPod(pod)).toBe('unknown')
  })
})

describe('resolveNpuLabelsFromPod', () => {
  it('derives step pod type and aggregates npu types', () => {
    const pod = {
      metadata: { name: 'runner-x-step-abc12345' },
      spec: {
        containers: [
          {
            name: 'job',
            resources: { requests: { 'huawei.com/ascend-310': '2' } }
          },
          {
            name: 'side',
            resources: { requests: { 'huawei.com/ascend-1980': '8' } }
          }
        ]
      },
      status: { phase: 'Running' }
    } as unknown as k8s.V1Pod
    const labels = resolveNpuLabelsFromPod(pod, 'runner-x-step-abc12345')
    expect(labels.podType).toBe('step')
    expect(labels.npuType).toBe('ascend-1980,ascend-310')
    expect(labels.cardsRequested).toBe('8')
    expect(labels.result).toBe('Running')
  })
  it('uses the terminated exit code as result', () => {
    const pod = {
      metadata: { name: 'runner-x-workflow' },
      spec: { containers: [{ name: 'job' }] },
      status: {
        phase: 'Succeeded',
        containerStatuses: [
          { name: 'job', state: { terminated: { exitCode: 0, message: '' } } }
        ]
      }
    } as unknown as k8s.V1Pod
    expect(resolveNpuLabelsFromPod(pod, 'runner-x-workflow').result).toBe('0')
  })
  it('handles a pod without status', () => {
    const pod = {
      metadata: { name: 'p' },
      spec: { containers: [] }
    } as unknown as k8s.V1Pod
    const labels = resolveNpuLabelsFromPod(pod, 'p')
    expect(labels.podType).toBe('workflow')
    expect(labels.npuType).toBe('unknown')
    expect(labels.cardsRequested).toBe('0')
    expect(labels.result).toBe('unknown')
  })
})

describe('repoFromEnv', () => {
  afterEach(() => {
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_WORKSPACE
  })
  it('prefers GITHUB_REPOSITORY', () => {
    process.env.GITHUB_REPOSITORY = 'org/repo'
    expect(repoFromEnv()).toBe('org/repo')
  })
  it('falls back to the last two GITHUB_WORKSPACE segments', () => {
    process.env.GITHUB_WORKSPACE = '/__w/repo-name/repo-name'
    expect(repoFromEnv()).toBe('repo-name/repo-name')
  })
  it('returns unknown without envs', () => {
    expect(repoFromEnv({})).toBe('unknown')
  })
})

// ── collection from pods ───────────────────────────────────────────────────────

describe('collectNpuAggregateFromPod', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('parses the termination message when the container terminated', async () => {
    const pod = {
      metadata: { name: 'job-pod' },
      status: {
        containerStatuses: [
          {
            name: 'job',
            state: {
              terminated: {
                exitCode: 0,
                message:
                  '{"v":"NPU_METRICS_V1","ts":9,"cards":[{"c":"0","n":1,"pu":2,"au":1,"ph":1,"fs":1,"ls":2}]}'
              }
            }
          }
        ]
      }
    } as unknown as k8s.V1Pod
    const payload = await collectNpuAggregateFromPod(pod)
    expect(payload?.cards[0].peakUtil).toBe(2)
    expect(k8sMod.execPodStepWithOutput).not.toHaveBeenCalled()
  })

  it('execs the aggregate script when the container is running', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 0,
      output: '{"v":"NPU_METRICS_V1","ts":9,"cards":[]}'
    })
    const pod = {
      metadata: { name: 'job-pod' },
      status: {
        phase: 'Running',
        containerStatuses: [
          { name: 'job', state: { running: { startedAt: new Date() } } }
        ]
      }
    } as unknown as k8s.V1Pod
    const payload = await collectNpuAggregateFromPod(pod)
    expect(k8sMod.execPodStepWithOutput).toHaveBeenCalledWith(
      expect.arrayContaining(['sh', '-c']),
      'job-pod',
      'job',
      5
    )
    expect(payload?.version).toBe(NPU_METRICS_MARKER)
  })

  it('returns undefined when the pod has no name', async () => {
    expect(await collectNpuAggregateFromPod({} as k8s.V1Pod)).toBeUndefined()
  })

  it('returns undefined when the container is pending', async () => {
    const pod = {
      metadata: { name: 'job-pod' },
      status: {
        containerStatuses: [{ name: 'job', state: { waiting: {} } }]
      }
    } as unknown as k8s.V1Pod
    expect(await collectNpuAggregateFromPod(pod)).toBeUndefined()
  })
})

// ── end to end collection and push ─────────────────────────────────────────────

describe('collectAndPushNpuMetrics', () => {
  let server: http.Server
  let port: number
  let received: { path?: string; body?: string }[]

  beforeAll(async () => {
    received = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        received.push({ path: req.url, body })
        res.statusCode = 200
        res.end('ok')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  beforeEach(() => {
    received.length = 0
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-x'
    process.env.GITHUB_REPOSITORY = 'org/repo'
    process.env.GITHUB_RUN_ID = '42'
    const jobPod = {
      metadata: {
        name: 'runner-x-workflow',
        labels: { 'runner-pod': 'runner-x' }
      },
      spec: {
        containers: [
          {
            name: 'job',
            resources: { requests: { 'huawei.com/ascend-1980': '2' } }
          }
        ]
      },
      status: {
        phase: 'Running',
        containerStatuses: [
          { name: 'job', state: { running: { startedAt: new Date() } } }
        ]
      }
    } as unknown as k8s.V1Pod
    const stepPod = {
      metadata: {
        name: 'runner-x-step-ab12cd34',
        labels: { 'runner-pod': 'runner-x' }
      },
      spec: {
        containers: [
          {
            name: 'job',
            resources: { requests: { 'huawei.com/ascend-1980': '2' } }
          }
        ]
      },
      status: {
        phase: 'Succeeded',
        containerStatuses: [
          {
            name: 'job',
            state: {
              terminated: {
                exitCode: 0,
                message:
                  '{"v":"NPU_METRICS_V1","ts":9,"cards":[{"c":"1","n":1,"pu":1,"au":0.5,"ph":1,"fs":10,"ls":11}]}'
              }
            }
          }
        ]
      }
    } as unknown as k8s.V1Pod
    const cpuPod = {
      metadata: {
        name: 'runner-x-cpu-extra',
        labels: { 'runner-pod': 'runner-x' }
      },
      spec: { containers: [{ name: 'job' }] },
      status: { phase: 'Running' }
    } as unknown as k8s.V1Pod
    const runnerPod = {
      metadata: {
        name: 'runner-x',
        labels: {
          'actions.github.com/scale-set-name': 'linux-aarch64-a3-2-gy005'
        }
      }
    } as k8s.V1Pod
    vi.mocked(k8sMod.listPodsByRunnerInstance).mockResolvedValue([
      jobPod,
      stepPod,
      cpuPod
    ])
    vi.mocked(k8sMod.getPodByName).mockImplementation(async (name: string) => {
      if (name === 'runner-x') return runnerPod
      throw new Error(`unexpected pod ${name}`)
    })
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 0,
      output:
        '{"v":"NPU_METRICS_V1","ts":9,"cards":[{"c":"0","n":2,"pu":88,"au":50,"ph":70,"fs":100,"last":0,"ls":160}]}'
    })
    vi.mocked(k8sMod.getSecretByName).mockResolvedValue({
      data: {
        PUSHGATEWAY_URL: b64(`http://127.0.0.1:${port}`),
        PUSHGATEWAY_USER: b64('push-user'),
        PUSHGATEWAY_PASSWORD: b64('push-pass')
      }
    } as k8s.V1Secret)
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_RUN_ID
    delete process.env.ACTIONS_RUNNER_NPU_METRICS
  })

  it('collects from job and step pods and pushes one record per pod', async () => {
    await collectAndPushNpuMetrics()
    const paths = received.map(r => r.path)
    expect(paths).toContain(
      '/metrics/job/npu-job-record/cluster/gy005/ns/test-ns/pod/runner-x-workflow'
    )
    expect(paths).toContain(
      '/metrics/job/npu-job-record/cluster/gy005/ns/test-ns/pod/runner-x-step-ab12cd34'
    )
    expect(received).toHaveLength(2)

    const workflowBody = received.find(r =>
      r.path?.endsWith('runner-x-workflow')
    )?.body
    expect(workflowBody).toContain('custom_npu_job_peak_util_percent')
    expect(workflowBody).toContain('idle="false"')
    expect(workflowBody).toContain('pod_type="workflow"')
    expect(workflowBody).toContain('repo="org/repo"')
    expect(workflowBody).toContain('run_id="42"')
    expect(workflowBody).toContain('npu_type="ascend-1980"')
    expect(workflowBody).toContain('cards_requested="2"')
    expect(workflowBody).toContain('custom_npu_job_push_total')
    expect(workflowBody).toContain('custom_npu_job_duration_seconds{')

    const stepBody = received.find(r => r.path?.endsWith('ab12cd34'))?.body
    expect(stepBody).toContain('pod_type="step"')
    expect(stepBody).toContain('idle="true"')
    expect(stepBody).toContain('card="1"')
  })

  it('skips everything when disabled', async () => {
    process.env.ACTIONS_RUNNER_NPU_METRICS = 'disabled'
    await collectAndPushNpuMetrics()
    expect(k8sMod.listPodsByRunnerInstance).not.toHaveBeenCalled()
  })

  it('skips push when the secret is missing', async () => {
    vi.mocked(k8sMod.getSecretByName).mockRejectedValue(
      new Error('secrets "npu-metrics-pushgw" not found')
    )
    await expect(collectAndPushNpuMetrics()).resolves.toBeUndefined()
    expect(k8sMod.listPodsByRunnerInstance).toHaveBeenCalled()
  })

  it('skips when no aggregate payload can be read', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 0,
      output: 'no sampler output'
    })
    await expect(collectAndPushNpuMetrics()).resolves.toBeUndefined()
    expect(received).toHaveLength(1) // only the step pod termination message
  })

  it('survives an unreachable pushgateway', async () => {
    vi.mocked(k8sMod.getSecretByName).mockResolvedValue({
      data: { PUSHGATEWAY_URL: b64('http://127.0.0.1:1') }
    } as k8s.V1Secret)
    await expect(collectAndPushNpuMetrics()).resolves.toBeUndefined()
  }, 30000)

  it('returns silently when the pod list fails', async () => {
    vi.mocked(k8sMod.listPodsByRunnerInstance).mockRejectedValue(
      new Error('404')
    )
    await expect(collectAndPushNpuMetrics()).resolves.toBeUndefined()
  })

  it('keeps going when one pod collection throws', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockRejectedValue(
      new Error('exec boom')
    )
    await expect(collectAndPushNpuMetrics()).resolves.toBeUndefined()
    expect(received).toHaveLength(1) // step pod record still pushed
  })

  it('does nothing for pods without npu requests', async () => {
    vi.mocked(k8sMod.listPodsByRunnerInstance).mockResolvedValue([
      {
        metadata: { name: 'cpu-only', labels: { 'runner-pod': 'runner-x' } },
        spec: { containers: [{ name: 'job' }] },
        status: { phase: 'Succeeded' }
      } as unknown as k8s.V1Pod
    ])
    await collectAndPushNpuMetrics()
    expect(k8sMod.execPodStepWithOutput).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)
  })
})
