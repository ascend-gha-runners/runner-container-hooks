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
  UNRECOVERABLE_EVENT_REASONS,
  UNRECOVERABLE_TERMINATED_REASONS,
  PERMANENT_SCHEDULING_PATTERNS,
  deletePod,
  createJobPod,
  createContainerStepPod
} from './index'
import { PodPhase } from './utils'

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
