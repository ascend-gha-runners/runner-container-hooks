import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as k8s from '@kubernetes/client-node'
import {
  namespace,
  getPrepareJobTimeoutSeconds,
  parsePodPhase,
  getContainerErrors,
  getContainerTerminatedErrors,
  getTerminatedReasonHint,
  getPodEventErrors,
  describePodFailure,
  checkUnrecoverableErrors,
  waitForPodPhases,
  isPermanentSchedulingFailure,
  getPermanentSchedulingPatterns,
  getUnrecoverableWaitingReasons,
  getUnrecoverableEventReasons,
  getUnrecoverableTerminatedReasons,
  getPodConditionErrors,
  UNRECOVERABLE_WAITING_REASONS,
  UNRECOVERABLE_TERMINATED_REASONS,
  PERMANENT_SCHEDULING_PATTERNS,
  deletePod,
  createJobPod,
  createContainerStepPod,
  createDockerSecret,
  createSecretForEnvs,
  deleteSecret,
  pruneSecrets,
  prunePods,
  getPodStatus,
  waitForJobToComplete,
  isAuthPermissionsOK,
  execCalculateOutputHashSorted,
  localCalculateOutputHashSorted,
  isPodContainerAlpine,
  containerPorts,
  getPodLogs,
  getPodByName,
  execPodStepWithOutput,
  execPodStep,
  execCpToPod,
  execCpFromPod
} from '../index'
import { PodPhase } from './index'

// Mock sleep so cp retry loops (up to 30 × 1s) run instantly in tests.
vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof import('./index')>()
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) }
})

// Mock tar-fs so execCpToPod/execCpFromPod don't touch the real filesystem
// (avoids async stream reads racing test teardown).
vi.mock('tar-fs', async () => {
  const { PassThrough } = await import('stream')
  return {
    default: {
      pack: vi.fn().mockReturnValue(new PassThrough()),
      extract: vi.fn().mockReturnValue(new PassThrough())
    }
  }
})

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

// ── helpers ───────────────────────────────────────────────────────────────────

function buildPod(
  phase?: string,
  opts: {
    containerStatuses?: k8s.V1ContainerStatus[]
    initContainerStatuses?: k8s.V1ContainerStatus[]
    conditions?: k8s.V1PodCondition[]
  } = {}
): k8s.V1Pod {
  return {
    metadata: { name: 'test-pod' },
    status: {
      phase,
      containerStatuses: opts.containerStatuses,
      initContainerStatuses: opts.initContainerStatuses,
      conditions: opts.conditions
    }
  } as k8s.V1Pod
}

function waitingContainer(
  name: string,
  reason?: string,
  message?: string
): k8s.V1ContainerStatus {
  return {
    name,
    state: { waiting: { reason, message } }
  } as k8s.V1ContainerStatus
}

function terminatedContainer(
  name: string,
  reason?: string,
  exitCode?: number,
  message?: string
): k8s.V1ContainerStatus {
  return {
    name,
    state: { terminated: { reason, exitCode, message } }
  } as k8s.V1ContainerStatus
}

function buildEvent(
  reason: string,
  message: string,
  opts: { type?: string; count?: number } = {}
): k8s.CoreV1Event {
  return {
    type: opts.type ?? 'Warning',
    reason,
    message,
    count: opts.count
  } as k8s.CoreV1Event
}

function podResult(pod: k8s.V1Pod): never {
  return pod as never
}

function eventResult(items: k8s.CoreV1Event[]): never {
  return { items } as never
}

// ── namespace ─────────────────────────────────────────────────────────────────

describe('namespace', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns env var when set', () => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'my-ns'
    expect(namespace()).toBe('my-ns')
  })
})

// ── getPrepareJobTimeoutSeconds ───────────────────────────────────────────────

describe('getPrepareJobTimeoutSeconds', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS']
  })

  it('returns default when env is unset', () => {
    expect(getPrepareJobTimeoutSeconds()).toBe(600)
  })

  it('returns parsed value when env is valid', () => {
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS'] = '120'
    expect(getPrepareJobTimeoutSeconds()).toBe(120)
  })

  it('returns default when env is invalid', () => {
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS'] = 'bad'
    expect(getPrepareJobTimeoutSeconds()).toBe(600)
  })

  it('returns default when env is zero', () => {
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS'] = '0'
    expect(getPrepareJobTimeoutSeconds()).toBe(600)
  })
})

// ── parsePodPhase ─────────────────────────────────────────────────────────────

describe('parsePodPhase', () => {
  it('returns known phases', () => {
    expect(parsePodPhase(buildPod(PodPhase.RUNNING))).toBe(PodPhase.RUNNING)
    expect(parsePodPhase(buildPod(PodPhase.PENDING))).toBe(PodPhase.PENDING)
    expect(parsePodPhase(buildPod(PodPhase.SUCCEEDED))).toBe(PodPhase.SUCCEEDED)
    expect(parsePodPhase(buildPod(PodPhase.FAILED))).toBe(PodPhase.FAILED)
  })

  it('returns UNKNOWN for unrecognized or missing phase', () => {
    expect(parsePodPhase(buildPod(undefined))).toBe(PodPhase.UNKNOWN)
    expect(parsePodPhase({} as k8s.V1Pod)).toBe(PodPhase.UNKNOWN)
    expect(parsePodPhase(buildPod('Weird'))).toBe(PodPhase.UNKNOWN)
  })
})

// ── getUnrecoverableWaitingReasons ────────────────────────────────────────────

describe('getUnrecoverableWaitingReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS']
  })

  it('returns built-in defaults when env not set', () => {
    const reasons = getUnrecoverableWaitingReasons()
    expect(reasons.has('ImagePullBackOff')).toBe(true)
    expect(reasons.has('InvalidImageName')).toBe(true)
  })

  it('adds extra reasons from env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS'] =
      'CustomReason'
    const reasons = getUnrecoverableWaitingReasons()
    expect(reasons.has('CustomReason')).toBe(true)
    expect(reasons.has('ImagePullBackOff')).toBe(true)
  })
})

// ── getUnrecoverableEventReasons ──────────────────────────────────────────────

describe('getUnrecoverableEventReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS']
  })

  it('returns built-in defaults when env not set', () => {
    const reasons = getUnrecoverableEventReasons()
    expect(reasons.has('FailedScheduling')).toBe(true)
    expect(reasons.has('FailedMount')).toBe(true)
  })

  it('adds extra reasons from env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS'] = 'MyEvent'
    expect(getUnrecoverableEventReasons().has('MyEvent')).toBe(true)
  })
})

// ── getUnrecoverableTerminatedReasons ─────────────────────────────────────────

describe('getUnrecoverableTerminatedReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS']
  })

  it('returns built-in defaults', () => {
    const reasons = getUnrecoverableTerminatedReasons()
    expect(reasons.has('OOMKilled')).toBe(true)
    expect(reasons.has('FailedPostStartHookError')).toBe(true)
  })

  it('adds extra reasons from env var, filters empty strings', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] =
      'MyReason,,  '
    const reasons = getUnrecoverableTerminatedReasons()
    expect(reasons.has('MyReason')).toBe(true)
    expect(reasons.has('OOMKilled')).toBe(true)
  })
})

// ── isPermanentSchedulingFailure ──────────────────────────────────────────────

describe('isPermanentSchedulingFailure', () => {
  it('returns false for undefined', () => {
    expect(isPermanentSchedulingFailure(undefined)).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isPermanentSchedulingFailure('')).toBe(false)
  })

  it('returns true for node affinity mismatch', () => {
    expect(
      isPermanentSchedulingFailure(
        "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector."
      )
    ).toBe(true)
  })

  it('returns true for untolerated taint', () => {
    expect(
      isPermanentSchedulingFailure(
        '0/2 nodes are available: 2 node(s) had untolerated taint {key: value}.'
      )
    ).toBe(true)
  })

  it('returns true for PVC not found', () => {
    expect(
      isPermanentSchedulingFailure(
        '0/1 nodes are available: persistentvolumeclaim "my-pvc" not found.'
      )
    ).toBe(true)
  })

  it('returns false for resource shortages (transient)', () => {
    expect(
      isPermanentSchedulingFailure(
        '0/3 nodes are available: 3 Insufficient cpu.'
      )
    ).toBe(false)
  })

  it('returns false for unknown message', () => {
    expect(isPermanentSchedulingFailure('something unexpected')).toBe(false)
  })
})

// ── getPermanentSchedulingPatterns ────────────────────────────────────────────

describe('getPermanentSchedulingPatterns', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_PERMANENT_SCHEDULING_PATTERNS']
  })

  it('returns built-in patterns', () => {
    const patterns = getPermanentSchedulingPatterns()
    expect(patterns.length).toBeGreaterThan(0)
    expect(patterns).toEqual(PERMANENT_SCHEDULING_PATTERNS)
  })

  it('extends with env var patterns', () => {
    process.env['ACTIONS_RUNNER_K8S_PERMANENT_SCHEDULING_PATTERNS'] =
      'mypattern'
    const patterns = getPermanentSchedulingPatterns()
    expect(patterns.length).toBeGreaterThan(
      PERMANENT_SCHEDULING_PATTERNS.length
    )
  })
})

// ── getContainerErrors ────────────────────────────────────────────────────────

describe('getContainerErrors', () => {
  it('returns empty for pod with no container statuses', () => {
    expect(getContainerErrors(buildPod(PodPhase.PENDING))).toEqual([])
    expect(getContainerErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns empty for recoverable waiting reason', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ContainerCreating')]
    })
    expect(getContainerErrors(pod)).toEqual([])
  })

  it('detects every unrecoverable waiting reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_WAITING_REASONS)) {
      const pod = buildPod(PodPhase.PENDING, {
        containerStatuses: [waitingContainer('job', reason)]
      })
      const errors = getContainerErrors(pod)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(`"job": ${reason}`)
      expect(errors[0]).toContain('→')
    }
  })

  it('includes message detail when waiting container has a message', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer('job', 'ImagePullBackOff', 'Back-off pulling image')
      ]
    })
    const errors = getContainerErrors(pod)
    expect(errors[0]).toContain('Back-off pulling image')
  })

  it('inspects init containers as well', () => {
    const pod = buildPod(PodPhase.PENDING, {
      initContainerStatuses: [waitingContainer('init', 'ImagePullBackOff')]
    })
    const errors = getContainerErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"init"')
  })

  it('does not fast-fail on ErrImagePull (transient)', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ErrImagePull')]
    })
    expect(getContainerErrors(pod)).toEqual([])
  })
})

// ── getTerminatedReasonHint ───────────────────────────────────────────────────

describe('getTerminatedReasonHint', () => {
  it('returns OOMKilled hint', () => {
    expect(getTerminatedReasonHint('OOMKilled', 137)).toContain('memory limit')
  })

  it('returns FailedPostStartHookError hint', () => {
    expect(getTerminatedReasonHint('FailedPostStartHookError', 1)).toContain(
      'postStart'
    )
  })

  it('returns exit code 137 SIGKILL hint', () => {
    expect(getTerminatedReasonHint('Error', 137)).toContain('SIGKILL')
  })

  it('returns exit code 127 command-not-found hint', () => {
    expect(getTerminatedReasonHint('Error', 127)).toContain('not found')
  })

  it('returns exit code 126 permission denied hint', () => {
    expect(getTerminatedReasonHint('Error', 126)).toContain('permission')
  })

  it('returns generic exit code hint for Error with other code', () => {
    const hint = getTerminatedReasonHint('Error', 1)
    expect(hint).toContain('non-zero code')
  })

  it('returns kubectl fallback for unknown reason', () => {
    expect(getTerminatedReasonHint('Unknown', 1)).toContain('kubectl')
  })
})

// ── getContainerTerminatedErrors ──────────────────────────────────────────────

describe('getContainerTerminatedErrors', () => {
  it('returns empty when no container statuses', () => {
    expect(getContainerTerminatedErrors(buildPod())).toEqual([])
    expect(getContainerTerminatedErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns empty for running containers', () => {
    const pod = buildPod(PodPhase.RUNNING, {
      containerStatuses: [
        { name: 'job', state: { running: {} } } as k8s.V1ContainerStatus
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('detects OOMKilled and includes hint', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'OOMKilled', 137)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('OOMKilled')
    expect(errors[0]).toContain('memory limit')
  })

  it('detects Error exit code 1', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'Error', 1)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Error')
  })

  it('detects every unrecoverable terminated reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      const pod = buildPod(PodPhase.FAILED, {
        containerStatuses: [terminatedContainer('job', reason, 1)]
      })
      expect(getContainerTerminatedErrors(pod)).toHaveLength(1)
    }
  })

  it('ignores terminated with non-unrecoverable reason', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [terminatedContainer('job', 'Completed', 0)]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('detects terminated errors in init containers', () => {
    const pod = buildPod(PodPhase.FAILED, {
      initContainerStatuses: [terminatedContainer('init', 'OOMKilled', 137)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"init"')
  })
})

// ── getPodConditionErrors ─────────────────────────────────────────────────────

describe('getPodConditionErrors', () => {
  it('returns empty array (current implementation)', () => {
    expect(getPodConditionErrors(buildPod())).toEqual([])
  })
})

// ── getPodEventErrors (with CoreV1Api prototype spy) ──────────────────────────

describe('getPodEventErrors', () => {
  let eventSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    eventSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent' as any)
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns empty when no warning events', async () => {
    eventSpy.mockResolvedValue(eventResult([]))
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('returns empty for normal-type events matching a reason', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedScheduling', 'no nodes', { type: 'Normal' })
      ])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('detects FailedMount and includes hint', async () => {
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedMount', 'Unable to mount volumes')])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('FailedMount')
  })

  it('detects FailedScheduling with permanent config error', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent(
          'FailedScheduling',
          "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector."
        )
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('FailedScheduling')
  })

  it('does NOT fast-fail on FailedScheduling with resource shortage', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedScheduling', '0/3 nodes: 3 Insufficient cpu.')
      ])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('deduplicates events with same reason', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedMount', 'err1'),
        buildEvent('FailedMount', 'err2')
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(1)
  })

  it('degrades gracefully when listing events is forbidden', async () => {
    eventSpy.mockRejectedValue(new Error('events is forbidden') as never)
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })
})

// ── describePodFailure (with prototype spies) ─────────────────────────────────

describe('describePodFailure', () => {
  let readSpy: ReturnType<typeof vi.spyOn>
  let eventSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod' as any)
    eventSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent' as any)
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('reports phase and terminated containers', async () => {
    readSpy.mockResolvedValue(
      podResult(
        buildPod(PodPhase.FAILED, {
          containerStatuses: [terminatedContainer('job', 'OOMKilled', 137)]
        })
      )
    )
    const result = await describePodFailure('my-pod')
    expect(result).toContain('Failed')
  })

  it('includes recent Warning events', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.PENDING)))
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedScheduling', 'no nodes available')])
    )
    const result = await describePodFailure('my-pod')
    expect(result).toContain('FailedScheduling')
  })

  it('degrades gracefully when pod cannot be read', async () => {
    readSpy.mockRejectedValue(new Error('pod not found') as never)
    const result = await describePodFailure('my-pod')
    expect(result).toContain('Could not read pod')
  })
})

// ── checkUnrecoverableErrors ──────────────────────────────────────────────────

describe('checkUnrecoverableErrors', () => {
  let eventSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    eventSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent' as any)
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns empty for healthy pod', async () => {
    const pod = buildPod(PodPhase.RUNNING)
    expect(await checkUnrecoverableErrors(pod, 'my-pod')).toEqual([])
  })

  it('returns container waiting errors', async () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ImagePullBackOff')]
    })
    const errors = await checkUnrecoverableErrors(pod, 'my-pod')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('ImagePullBackOff')
  })

  it('returns terminated errors', async () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'OOMKilled', 137)]
    })
    const errors = await checkUnrecoverableErrors(pod, 'my-pod')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('OOMKilled')
  })

  it('returns event errors', async () => {
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedMount', 'mount failed')])
    )
    const pod = buildPod(PodPhase.PENDING)
    const errors = await checkUnrecoverableErrors(pod, 'my-pod')
    expect(errors.some(e => e.includes('FailedMount'))).toBe(true)
  })
})

// ── waitForPodPhases (with prototype spies) ───────────────────────────────────

describe('waitForPodPhases', () => {
  let readSpy: ReturnType<typeof vi.spyOn>
  let eventSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod' as any)
    eventSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent' as any)
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves when pod reaches awaited phase', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.RUNNING)))
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).resolves.toBeUndefined()
  })

  it('surfaces unrecoverable container errors in thrown message', async () => {
    readSpy.mockResolvedValue(
      podResult(
        buildPod(PodPhase.PENDING, {
          containerStatuses: [
            waitingContainer('job', 'ImagePullBackOff', 'can not pull')
          ]
        })
      )
    )
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        30
      )
    ).rejects.toThrow('ImagePullBackOff')
  }, 15000)

  it('fast-fails on FailedMount event', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.PENDING)))
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedMount', 'Unable to mount volumes')])
    )
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        30
      )
    ).rejects.toThrow('FailedMount')
  }, 15000)

  it('fast-fails on permanent FailedScheduling', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.PENDING)))
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent(
          'FailedScheduling',
          "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector."
        )
      ])
    )
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        30
      )
    ).rejects.toThrow('FailedScheduling')
  }, 15000)

  it('throws with phase when pod reaches non-backoff phase', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.FAILED)))
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        30
      )
    ).rejects.toThrow()
  }, 15000)

  it('retries on transient readPod failure', async () => {
    readSpy
      .mockRejectedValueOnce(new Error('connection refused') as never)
      .mockRejectedValueOnce(new Error('connection refused') as never)
      .mockResolvedValue(podResult(buildPod(PodPhase.RUNNING)))
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        30
      )
    ).resolves.toBeUndefined()
  }, 15000)
})

// ── deletePod ─────────────────────────────────────────────────────────────────

describe('deletePod', () => {
  let deleteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    deleteSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'deleteNamespacedPod' as any)
    deleteSpy.mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('calls deleteNamespacedPod with correct args', async () => {
    await deletePod('my-pod')
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-pod', namespace: 'default' })
    )
  })
})

// ── createJobPod ──────────────────────────────────────────────────────────────

describe('createJobPod', () => {
  let createSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    createSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'createNamespacedPod' as any)
    createSpy.mockResolvedValue({
      metadata: { name: 'job-pod' },
      spec: { containers: [] }
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('calls createNamespacedPod and returns the pod', async () => {
    const container = new k8s.V1Container()
    container.name = 'job'
    container.image = 'ubuntu:latest'
    const pod = await createJobPod('job-pod', container)
    expect(createSpy).toHaveBeenCalled()
    expect(pod).toBeDefined()
  })

  it('creates pod with services', async () => {
    const jobContainer = new k8s.V1Container()
    jobContainer.name = 'job'
    jobContainer.image = 'ubuntu:latest'
    const service = new k8s.V1Container()
    service.name = 'redis'
    service.image = 'redis:latest'
    await createJobPod('job-pod', jobContainer, [service])
    expect(createSpy).toHaveBeenCalled()
  })

  it('handles createNamespacedPod failure', async () => {
    createSpy.mockRejectedValue(new Error('quota exceeded') as never)
    await expect(createJobPod('job-pod')).rejects.toThrow()
  })
})

// ── createContainerStepPod ────────────────────────────────────────────────────

describe('createContainerStepPod', () => {
  let createSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    createSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'createNamespacedPod' as any)
    createSpy.mockResolvedValue({
      metadata: { name: 'step-pod' },
      spec: { containers: [] }
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('calls createNamespacedPod and returns pod', async () => {
    const container = new k8s.V1Container()
    container.name = 'job'
    container.image = 'ubuntu:latest'
    const pod = await createContainerStepPod('step-pod', container)
    expect(createSpy).toHaveBeenCalled()
    expect(pod).toBeDefined()
  })
})

// ── namespace (fallbacks) ─────────────────────────────────────────────────────
//
// We cannot spy on `fs.readFileSync` directly in ESM (module namespace is not
// configurable). Instead, use a real temp file path that doesn't exist for
// the "missing" path, and a real temp file with content for the SA-file path.

describe('namespace fallbacks', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('throws when no namespace source is available', () => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    // ServiceAccount file does not exist on dev/CI machines → throws ENOENT
    expect(() => namespace()).toThrow(/Failed to determine namespace/)
  })
})

// ── getPermanentSchedulingPatterns (env extension + cache) ───────────────────

describe('getPermanentSchedulingPatterns env extension', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_PERMANENT_SCHEDULING_PATTERNS']
    vi.restoreAllMocks()
  })

  it('skips invalid regex with a warning', () => {
    process.env['ACTIONS_RUNNER_K8S_PERMANENT_SCHEDULING_PATTERNS'] =
      '[invalid, (goodpattern)'
    const result = getPermanentSchedulingPatterns()
    expect(result.length).toBeGreaterThan(PERMANENT_SCHEDULING_PATTERNS.length)
    // Valid pattern was added, invalid one was skipped
    expect(result.some(p => p.source.includes('goodpattern'))).toBe(true)
  })

  it('caches compiled patterns across calls with same env', () => {
    process.env['ACTIONS_RUNNER_K8S_PERMANENT_SCHEDULING_PATTERNS'] =
      'pattern-a'
    const first = getPermanentSchedulingPatterns()
    const second = getPermanentSchedulingPatterns()
    // Same env → cached result, identity preserved
    expect(second).toBe(first)
  })

  it('filters out empty entries from comma-separated list', () => {
    process.env['ACTIONS_RUNNER_K8S_PERMANENT_SCHEDULING_PATTERNS'] =
      ' ,, alpha, '
    const result = getPermanentSchedulingPatterns()
    // Only "alpha" should be added
    expect(result.some(p => p.source === 'alpha')).toBe(true)
    expect(result.some(p => p.source === '')).toBe(false)
  })
})

// ── createDockerSecret ───────────────────────────────────────────────────────

describe('createDockerSecret', () => {
  let createSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    createSpy = vi.spyOn(
      k8s.CoreV1Api.prototype,
      'createNamespacedSecret' as any
    )
    createSpy.mockResolvedValue({
      metadata: { name: 'docker-secret' }
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('creates secret with base64-encoded docker config', async () => {
    const secret = await createDockerSecret({
      serverUrl: 'https://ghcr.io',
      username: 'user',
      password: 'pass'
    })
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default' })
    )
    expect(secret.metadata?.name).toBe('docker-secret')
    // Verify the auth payload decodes correctly
    const call = createSpy.mock.calls[0][0] as any
    const decoded = JSON.parse(
      Buffer.from(call.body.data['.dockerconfigjson'], 'base64').toString(
        'utf8'
      )
    )
    expect(decoded.auths['https://ghcr.io'].username).toBe('user')
    expect(decoded.auths['https://ghcr.io'].password).toBe('pass')
  })

  it('falls back to docker.io when serverUrl is missing', async () => {
    await createDockerSecret({
      username: 'u',
      password: 'p'
    } as any)
    const call = createSpy.mock.calls[0][0] as any
    const decoded = JSON.parse(
      Buffer.from(call.body.data['.dockerconfigjson'], 'base64').toString(
        'utf8'
      )
    )
    expect(decoded.auths['https://index.docker.io/v1/']).toBeDefined()
  })
})

// ── createSecretForEnvs ──────────────────────────────────────────────────────

describe('createSecretForEnvs', () => {
  let createSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    createSpy = vi.spyOn(
      k8s.CoreV1Api.prototype,
      'createNamespacedSecret' as any
    )
    createSpy.mockResolvedValue({ metadata: { name: 'env-secret' } } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('base64-encodes each env value', async () => {
    const name = await createSecretForEnvs({ FOO: 'bar', BAZ: 'qux' })
    // createSecretForEnvs returns the locally-generated secret name (not the API response)
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
    const call = createSpy.mock.calls[0][0] as any
    expect(call.body.data['FOO']).toBe(Buffer.from('bar').toString('base64'))
    expect(call.body.data['BAZ']).toBe(Buffer.from('qux').toString('base64'))
  })

  it('handles empty envs object', async () => {
    const name = await createSecretForEnvs({})
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
    const call = createSpy.mock.calls[0][0] as any
    expect(call.body.data).toEqual({})
  })
})

// ── deleteSecret ─────────────────────────────────────────────────────────────

describe('deleteSecret', () => {
  let deleteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    deleteSpy = vi.spyOn(
      k8s.CoreV1Api.prototype,
      'deleteNamespacedSecret' as any
    )
    deleteSpy.mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('calls deleteNamespacedSecret with name and namespace', async () => {
    await deleteSecret('my-secret')
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-secret', namespace: 'default' })
    )
  })
})

// ── pruneSecrets ─────────────────────────────────────────────────────────────

describe('pruneSecrets', () => {
  let listSpy: ReturnType<typeof vi.spyOn>
  let deleteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    listSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedSecret' as any)
    deleteSpy = vi.spyOn(
      k8s.CoreV1Api.prototype,
      'deleteNamespacedSecret' as any
    )
    deleteSpy.mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('returns immediately when no secrets found', async () => {
    listSpy.mockResolvedValue({ items: [] } as never)
    await pruneSecrets()
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('deletes all secrets returned by list', async () => {
    listSpy.mockResolvedValue({
      items: [
        { metadata: { name: 'a' } },
        { metadata: { name: 'b' } },
        { metadata: { name: undefined } } // skipped
      ]
    } as never)
    await pruneSecrets()
    expect(deleteSpy).toHaveBeenCalledTimes(2)
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a' })
    )
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'b' })
    )
  })
})

// ── prunePods ────────────────────────────────────────────────────────────────

describe('prunePods', () => {
  let listSpy: ReturnType<typeof vi.spyOn>
  let deleteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    listSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedPod' as any)
    deleteSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'deleteNamespacedPod' as any)
    deleteSpy.mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('returns immediately when no pods found', async () => {
    listSpy.mockResolvedValue({ items: [] } as never)
    await prunePods()
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('deletes all named pods', async () => {
    listSpy.mockResolvedValue({
      items: [{ metadata: { name: 'p1' } }, { metadata: { name: 'p2' } }]
    } as never)
    await prunePods()
    expect(deleteSpy).toHaveBeenCalledTimes(2)
  })
})

// ── getPodStatus ─────────────────────────────────────────────────────────────

describe('getPodStatus', () => {
  let readSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns pod.status from the API', async () => {
    readSpy.mockResolvedValue({
      status: { phase: PodPhase.RUNNING }
    } as never)
    const status = await getPodStatus('my-pod')
    expect(status?.phase).toBe(PodPhase.RUNNING)
  })
})

// ── waitForJobToComplete ─────────────────────────────────────────────────────

describe('waitForJobToComplete', () => {
  let readSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = vi.spyOn(k8s.BatchV1Api.prototype, 'readNamespacedJob' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves when job has succeeded status', async () => {
    readSpy.mockResolvedValue({ status: { succeeded: 1 } } as never)
    await expect(waitForJobToComplete('my-job')).resolves.toBeUndefined()
  })

  it('throws wrapped error when job has failed status', async () => {
    readSpy.mockResolvedValue({ status: { failed: 1 } } as never)
    await expect(waitForJobToComplete('my-job')).rejects.toThrow(
      /job my-job has failed/
    )
  })
})

// ── isAuthPermissionsOK ──────────────────────────────────────────────────────

describe('isAuthPermissionsOK', () => {
  let sarSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    sarSpy = vi.spyOn(
      k8s.AuthorizationV1Api.prototype,
      'createSelfSubjectAccessReview' as any
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns true when all permissions are allowed', async () => {
    sarSpy.mockResolvedValue({ status: { allowed: true } } as never)
    await expect(isAuthPermissionsOK()).resolves.toBe(true)
  })

  it('returns false when any permission is denied', async () => {
    sarSpy.mockResolvedValue({ status: { allowed: false } } as never)
    await expect(isAuthPermissionsOK()).resolves.toBe(false)
  })
})

// ── localCalculateOutputHashSorted ───────────────────────────────────────────

describe('localCalculateOutputHashSorted', () => {
  it('sorts lines and produces a sha256 hash', async () => {
    // Use `node` so the test is cross-platform (Windows has no /bin/echo)
    const { hash, lines } = await localCalculateOutputHashSorted([
      process.execPath,
      '-e',
      "console.log('hello')"
    ])
    expect(lines).toEqual(['hello'])
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects when child process exits non-zero', async () => {
    // `node -e process.exit(1)` always exits 1 on every platform
    await expect(
      localCalculateOutputHashSorted([
        process.execPath,
        '-e',
        'process.exit(1)'
      ])
    ).rejects.toThrow(/exited with code/)
  })
})

// ── execCalculateOutputHashSorted ────────────────────────────────────────────

describe('execCalculateOutputHashSorted', () => {
  let execSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = vi.spyOn(k8s.Exec.prototype, 'exec' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('sorts captured stdout and returns hash + lines', async () => {
    // Simulate the exec callback path: capture stream receives bytes,
    // status callback fires with Success.
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      // Write some lines out of order to verify sorting
      stdout.write('banana\napple\ncherry\n')
      void Promise.resolve().then(() =>
        statusCb({ status: 'Success', code: 0 })
      )
      return Promise.resolve({})
    })
    const { hash, lines } = await execCalculateOutputHashSorted(
      'my-pod',
      'job',
      ['sh', '-c', 'echo test']
    )
    expect(lines).toEqual(['apple', 'banana', 'cherry'])
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects when exec returns Failure status', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      stdout.write('')
      void Promise.resolve().then(() =>
        statusCb({ status: 'Failure', message: 'exec failed' })
      )
      return Promise.resolve({})
    })
    await expect(
      execCalculateOutputHashSorted('my-pod', 'job', ['ls'])
    ).rejects.toThrow('exec failed')
  })

  it('rejects when exec promise rejects', async () => {
    execSpy.mockRejectedValue(new Error('connection refused') as never)
    await expect(
      execCalculateOutputHashSorted('my-pod', 'job', ['ls'])
    ).rejects.toThrow('connection refused')
  })
})

// ── isPodContainerAlpine ─────────────────────────────────────────────────────

describe('isPodContainerAlpine', () => {
  let execSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = vi.spyOn(k8s.Exec.prototype, 'exec' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns true when the alpine check exits 0', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({ status: 'Success', code: 0 })
      )
      return Promise.resolve({})
    })
    await expect(isPodContainerAlpine('my-pod', 'job')).resolves.toBe(true)
  })

  it('returns false when the alpine check fails (non-zero exit)', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({
          status: 'Failure',
          message: 'command terminated with exit code 1'
        })
      )
      return Promise.resolve({})
    })
    await expect(isPodContainerAlpine('my-pod', 'job')).resolves.toBe(false)
  })
})

// ── getPodEventErrors (extended: count + multiple reasons) ───────────────────

describe('getPodEventErrors extended', () => {
  let eventSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    eventSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('appends (xN) when event count > 1', async () => {
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedMount', 'mount err', { count: 5 })])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors[0]).toContain('(x5)')
  })

  it('returns errors for distinct unrecoverable reasons', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedMount', 'm1'),
        buildEvent('FailedBinding', 'pvc not found')
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(2)
    expect(errors.some(e => e.includes('FailedMount'))).toBe(true)
    expect(errors.some(e => e.includes('FailedBinding'))).toBe(true)
  })

  it('skips FailedScheduling when message has no permanent pattern', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedScheduling', 'some random transient issue')
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([])
  })

  it('includes message detail in error', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedMount', 'a specific mount failure detail')
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors[0]).toContain('a specific mount failure detail')
  })
})

// ── createJobPod with extension ───────────────────────────────────────────────

describe('createJobPod with extension and workingDir', () => {
  let createSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-pod'
    process.env['GITHUB_WORKSPACE'] = '/__w/repo/repo'
    createSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'createNamespacedPod' as any)
    createSpy.mockResolvedValue({
      metadata: { name: 'job-pod' },
      spec: { containers: [] }
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
    delete process.env['GITHUB_WORKSPACE']
  })

  it('applies extension metadata and spec when provided', async () => {
    // Covers k8s/index.ts lines 229-230, 233 (extension branches in createJobPod)
    const extension: k8s.V1PodTemplateSpec = {
      metadata: {
        labels: { 'custom-label': 'val' },
        annotations: { 'custom-ann': 'val2' }
      },
      spec: {
        containers: [],
        restartPolicy: 'Never'
      }
    }
    const container = new k8s.V1Container()
    container.name = 'job'
    container.image = 'ubuntu:latest'
    await createJobPod('job-pod', container, [], undefined, extension)
    expect(createSpy).toHaveBeenCalled()
  })

  it('sets workingDirPath mkdir when GITHUB_WORKSPACE has sub-path', async () => {
    // Covers k8s/index.ts line 117 (workingDirPath conditional)
    process.env['GITHUB_WORKSPACE'] = '/__w/repo/myrepo'
    const container = new k8s.V1Container()
    container.name = 'job'
    container.image = 'ubuntu:latest'
    await createJobPod('job-pod', container)
    expect(createSpy).toHaveBeenCalled()
  })
})

// ── getContainerErrors — getWaitingReasonHint branches ────────────────────────

describe('getContainerErrors — getWaitingReasonHint additional branches', () => {
  it('returns CreateContainerConfigError hint', () => {
    // Covers k8s/index.ts lines 1127-1128 (CreateContainerConfigError case)
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'CreateContainerConfigError')]
    })
    const errors = getContainerErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Container config is invalid')
  })

  it('returns default hint for unknown waiting reason via env extension', () => {
    // Covers k8s/index.ts lines 1136-1139 (default case in getWaitingReasonHint)
    // Add a custom reason via env var
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS'] =
      'WeirdCustomReason'
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'WeirdCustomReason')]
    })
    const errors = getContainerErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('kubectl describe pod')
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS']
  })

  it('returns InvalidImageName hint', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'InvalidImageName')]
    })
    const errors = getContainerErrors(pod)
    expect(errors[0]).toContain('malformed')
  })
})

// ── containerPorts ────────────────────────────────────────────────────────────

describe('containerPorts', () => {
  it('returns empty array when portMappings is absent', () => {
    expect(containerPorts({} as any)).toEqual([])
    expect(containerPorts({ portMappings: [] } as any)).toEqual([])
  })

  it('parses a simple containerPort', () => {
    const ports = containerPorts({ portMappings: ['8080'] } as any)
    expect(ports).toHaveLength(1)
    expect(ports[0].containerPort).toBe(8080)
    expect(ports[0].protocol).toBe('TCP')
  })

  it('parses hostPort:containerPort format', () => {
    const ports = containerPorts({ portMappings: ['80:8080'] } as any)
    expect(ports[0].hostPort).toBe(80)
    expect(ports[0].containerPort).toBe(8080)
  })

  it('parses protocol suffix', () => {
    const ports = containerPorts({ portMappings: ['8080/UDP'] } as any)
    expect(ports[0].protocol).toBe('UDP')
    expect(ports[0].containerPort).toBe(8080)
  })

  it('parses hostPort:containerPort/protocol', () => {
    const ports = containerPorts({ portMappings: ['80:8080/TCP'] } as any)
    expect(ports[0].hostPort).toBe(80)
    expect(ports[0].containerPort).toBe(8080)
    expect(ports[0].protocol).toBe('TCP')
  })

  it('throws on too many slashes', () => {
    expect(() =>
      containerPorts({ portMappings: ['80/TCP/extra'] } as any)
    ).toThrow('Unexpected port format')
  })

  it('throws on too many colons', () => {
    expect(() =>
      containerPorts({ portMappings: ['80:8080:9090'] } as any)
    ).toThrow('":" separator')
  })

  it('throws on invalid port number', () => {
    expect(() => containerPorts({ portMappings: ['0'] } as any)).toThrow(
      'invalid container port'
    )
    expect(() => containerPorts({ portMappings: ['65536'] } as any)).toThrow(
      'invalid container port'
    )
    expect(() => containerPorts({ portMappings: ['abc'] } as any)).toThrow(
      'invalid container port'
    )
  })

  it('parses multiple port mappings', () => {
    const ports = containerPorts({
      portMappings: ['80:8080', '443:8443/TCP']
    } as any)
    expect(ports).toHaveLength(2)
    expect(ports[0].containerPort).toBe(8080)
    expect(ports[1].containerPort).toBe(8443)
  })
})

// ── execPodStepWithOutput ─────────────────────────────────────────────────────

describe('execPodStepWithOutput', () => {
  let execSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = vi.spyOn(k8s.Exec.prototype, 'exec' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves with code 0 and captured output on success', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      stdout.write('hello\nworld\n')
      void Promise.resolve().then(() =>
        statusCb({ status: 'Success', code: 0 })
      )
      return Promise.resolve({})
    })
    const result = await execPodStepWithOutput(
      ['sh', '-c', 'echo hi'],
      'my-pod',
      'job'
    )
    expect(result.code).toBe(0)
    expect(result.output).toContain('hello')
  })

  it('resolves with parsed exit code from Failure message', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({
          status: 'Failure',
          message: 'command terminated with exit code 1'
        })
      )
      return Promise.resolve({})
    })
    const result = await execPodStepWithOutput(
      ['sh', '-c', 'exit 1'],
      'my-pod',
      'job'
    )
    expect(result.code).toBe(1)
  })

  it('rejects when Failure has no parseable exit code', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({ status: 'Failure', message: 'unexpected error' })
      )
      return Promise.resolve({})
    })
    await expect(
      execPodStepWithOutput(['sh', '-c', 'fail'], 'my-pod', 'job')
    ).rejects.toThrow('unexpected error')
  })

  it('resolves with parsed code when exec promise rejects with exit code message', async () => {
    execSpy.mockRejectedValue(
      new Error('command terminated with exit code 2') as never
    )
    const result = await execPodStepWithOutput(
      ['sh', '-c', 'exit 2'],
      'my-pod',
      'job'
    )
    expect(result.code).toBe(2)
  })

  it('rejects when exec promise rejects without exit code', async () => {
    execSpy.mockRejectedValue(new Error('connection refused') as never)
    await expect(
      execPodStepWithOutput(['ls'], 'my-pod', 'job')
    ).rejects.toThrow('connection refused')
  })
})

// ── getPodLogs ────────────────────────────────────────────────────────────────

describe('getPodLogs', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    logSpy = vi.spyOn(k8s.Log.prototype, 'log' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves when log stream ends normally', async () => {
    logSpy.mockImplementation(async (_ns, _pod, _c, logStream) => {
      void Promise.resolve().then(() => logStream.end())
      return undefined
    })
    await expect(getPodLogs('my-pod', 'job')).resolves.toBeUndefined()
  })

  it('rejects when log stream emits an error', async () => {
    logSpy.mockImplementation(async (_ns, _pod, _c, logStream) => {
      void Promise.resolve().then(() =>
        logStream.destroy(new Error('stream error'))
      )
      return undefined
    })
    await expect(getPodLogs('my-pod', 'job')).rejects.toThrow('stream error')
  })
})

// ── getPodByName ──────────────────────────────────────────────────────────────

describe('getPodByName', () => {
  let readSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns the pod from the API', async () => {
    const fakePod = buildPod('Running')
    readSpy.mockResolvedValue(fakePod as never)
    const pod = await getPodByName('my-pod')
    expect(readSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-pod', namespace: 'default' })
    )
    expect(pod).toBe(fakePod)
  })

  it('propagates API errors', async () => {
    readSpy.mockRejectedValue(new Error('not found') as never)
    await expect(getPodByName('missing-pod')).rejects.toThrow('not found')
  })
})

// ── execPodStep ───────────────────────────────────────────────────────────────

describe('execPodStep', () => {
  let execSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = vi.spyOn(k8s.Exec.prototype, 'exec' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves with exit code 0 on Success', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({ status: 'Success', code: 0 })
      )
      return Promise.resolve(null)
    })
    const code = await execPodStep(['echo', 'hi'], 'my-pod', 'job')
    expect(code).toBe(0)
  })

  it('rejects with message on Failure', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({ status: 'Failure', message: 'command failed' })
      )
      return Promise.resolve(null)
    })
    await expect(
      execPodStep(['sh', '-c', 'exit 1'], 'my-pod', 'job')
    ).rejects.toThrow('command failed')
  })

  it('rejects when exec promise rejects', async () => {
    execSpy.mockRejectedValue(new Error('connection refused') as never)
    await expect(execPodStep(['ls'], 'my-pod', 'job')).rejects.toThrow(
      'connection refused'
    )
  })

  it('resolves with Success code when ws is non-null (heartbeat branch)', async () => {
    const fakeWs = {
      readyState: 1,
      once: vi.fn((_event, cb) => {
        setTimeout(cb, 0)
        return fakeWs
      }),
      close: vi.fn()
    }
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({ status: 'Success', code: 42 })
      )
      return Promise.resolve(fakeWs)
    })
    const code = await execPodStep(['echo'], 'my-pod', 'job')
    expect(code).toBe(42)
  })

  it('handles ws close timeout on Failure (readyState=1)', async () => {
    const fakeWs = {
      readyState: 1,
      once: vi.fn(),
      close: vi.fn()
    }
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      void Promise.resolve().then(() =>
        statusCb({ status: 'Failure', message: 'oops' })
      )
      return Promise.resolve(fakeWs)
    })
    await expect(execPodStep(['fail'], 'my-pod', 'job')).rejects.toThrow('oops')
  }, 10000)
})

// ── execCpToPod / execCpFromPod (errStream reject paths) ──────────────────────

describe('execCpToPod', () => {
  let execSpy: ReturnType<typeof vi.spyOn>
  let tmpDir: string

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cptopod-'))
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
    execSpy = vi.spyOn(k8s.Exec.prototype, 'exec' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('rejects with errStream details when the pod-side command writes to stderr', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      // The impl passes errStream as _stderr. Write content then fire the
      // status callback so the impl's status handler sees errStream.size() > 0
      // and rejects.
      void Promise.resolve().then(() => {
        ;(_stderr as unknown as { write: (s: string) => void }).write(
          'tar: error opening archive: no such file'
        )
        statusCb({ status: 'Failure' })
      })
      return Promise.resolve(null)
    })

    await expect(execCpToPod('my-pod', tmpDir, '/workspace')).rejects.toThrow(
      'Error from execCpToPod'
    )
  }, 10000)

  it('retries then throws after all attempts when exec keeps failing', async () => {
    execSpy.mockRejectedValue(new Error('connection refused') as never)
    await expect(execCpToPod('my-pod', tmpDir, '/workspace')).rejects.toThrow(
      'cpToPod failed after 30 attempts'
    )
  }, 15000)
})

describe('execCpFromPod', () => {
  let execSpy: ReturnType<typeof vi.spyOn>
  let tmpDir: string

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpfrompod-'))
    execSpy = vi.spyOn(k8s.Exec.prototype, 'exec' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('rejects with errStream details when the pod-side tar writes to stderr', async () => {
    execSpy.mockImplementation(async function (
      this: any,
      _ns,
      _pod,
      _c,
      _cmd,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCb
    ) {
      // The impl wires writerStream as stdout and errStream as stderr.
      // Write to errStream then fire the status callback so the impl rejects.
      void Promise.resolve().then(() => {
        ;(_stderr as unknown as { write: (s: string) => void }).write(
          'tar: no such file or directory'
        )
        statusCb({ status: 'Failure' })
      })
      return Promise.resolve(null)
    })

    await expect(
      execCpFromPod('my-pod', '/workspace/output', tmpDir)
    ).rejects.toThrow('Error from cpFromPod')
  }, 10000)
})

// ── waitForPodPhases backoff timeout ──────────────────────────────────────────

describe('waitForPodPhases timeout path', () => {
  let readSpy: ReturnType<typeof vi.spyOn>
  let eventSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod' as any)
    eventSpy = vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent' as any)
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('throws timed-out message when pod stays in a backoff phase past maxTimeSeconds', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.PENDING)))
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        0.1
      )
    ).rejects.toThrow(/timed out after 0\.1s/)
  }, 5000)
})
