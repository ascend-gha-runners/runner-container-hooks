import * as k8s from '@kubernetes/client-node'
import {
  describePodFailure,
  evaluateImagePullFailures,
  getContainerErrors,
  getContainerTerminatedErrors,
  getImagePullGraceMs,
  getPodEventErrors,
  getUnrecoverableEventReasons,
  getUnrecoverableTerminatedReasons,
  getUnrecoverableWaitingReasons,
  isPermanentSchedulingFailure,
  parsePodPhase,
  PERMANENT_SCHEDULING_PATTERNS,
  UNRECOVERABLE_EVENT_REASONS,
  UNRECOVERABLE_TERMINATED_REASONS,
  UNRECOVERABLE_WAITING_REASONS,
  waitForPodPhases
} from '../src/k8s'
import { PodPhase } from '../src/k8s/utils'

// Build a minimal V1Pod with the given phase and container statuses so we can
// exercise the container-error detection logic in isolation.
function buildPod(
  phase?: string,
  opts: {
    containerStatuses?: k8s.V1ContainerStatus[]
    initContainerStatuses?: k8s.V1ContainerStatus[]
  } = {}
): k8s.V1Pod {
  return {
    status: {
      phase,
      containerStatuses: opts.containerStatuses,
      initContainerStatuses: opts.initContainerStatuses
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

// Build a Warning event with the fields getPodEventErrors() inspects.
function buildEvent(
  reason: string,
  message: string,
  opts: { type?: string; count?: number } = {}
): k8s.CoreV1Event {
  return {
    type: opts.type ?? 'Warning',
    reason,
    message,
    count: opts.count,
    lastTimestamp: new Date('2026-01-01T00:00:00Z')
  } as k8s.CoreV1Event
}

// @kubernetes/client-node 1.x object-style API returns the object directly
// (not wrapped in { body }), so mocks must do the same.
function podResult(pod: k8s.V1Pod): never {
  return pod as never
}
function eventResult(items: k8s.CoreV1Event[]): never {
  return { items } as never
}

describe('parsePodPhase', () => {
  it('returns the phase when it is a known value', () => {
    expect(parsePodPhase(buildPod(PodPhase.RUNNING))).toBe(PodPhase.RUNNING)
    expect(parsePodPhase(buildPod(PodPhase.PENDING))).toBe(PodPhase.PENDING)
    expect(parsePodPhase(buildPod(PodPhase.SUCCEEDED))).toBe(PodPhase.SUCCEEDED)
    expect(parsePodPhase(buildPod(PodPhase.FAILED))).toBe(PodPhase.FAILED)
  })

  it('returns UNKNOWN when phase is missing', () => {
    expect(parsePodPhase(buildPod(undefined))).toBe(PodPhase.UNKNOWN)
    expect(parsePodPhase({} as k8s.V1Pod)).toBe(PodPhase.UNKNOWN)
  })

  it('returns UNKNOWN when phase is not a recognized value', () => {
    expect(parsePodPhase(buildPod('SomethingElse'))).toBe(PodPhase.UNKNOWN)
  })
})

describe('getContainerErrors', () => {
  it('returns no errors when there are no container statuses', () => {
    expect(getContainerErrors(buildPod(PodPhase.PENDING))).toEqual([])
    expect(getContainerErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns no errors when containers are waiting for a recoverable reason', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ContainerCreating')]
    })
    expect(getContainerErrors(pod)).toEqual([])
  })

  it('detects every unrecoverable waiting reason and includes a hint', () => {
    for (const reason of Array.from(UNRECOVERABLE_WAITING_REASONS)) {
      const pod = buildPod(PodPhase.PENDING, {
        containerStatuses: [waitingContainer('job', reason)]
      })
      const errors = getContainerErrors(pod)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(`  ✗ container "job": ${reason}`)
      expect(errors[0]).toContain('→')
    }
  })

  it('does not fast-fail on ImagePullBackOff (handled by the grace period)', () => {
    // ImagePullBackOff is NOT an immediate unrecoverable reason: a transient
    // network outage can self-heal. waitForPodPhases gives it a bounded grace
    // period (see evaluateImagePullFailures) before failing.
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer(
          'job',
          'ImagePullBackOff',
          'Back-off pulling image "does-not-exist:latest"'
        )
      ]
    })
    expect(getContainerErrors(pod)).toEqual([])
  })

  it('does not fast-fail on ErrImagePull (treated as transient, grace period applies)', () => {
    // ErrImagePull fires on the first pull failure (could be a TLS timeout).
    // k8s will retry and promote to ImagePullBackOff if it keeps failing.
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ErrImagePull', 'TLS handshake timeout')]
    })
    expect(getContainerErrors(pod)).toEqual([])
  })

  it('does not fast-fail on CreateContainerError (treated as transient runtime issue)', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'CreateContainerError')]
    })
    expect(getContainerErrors(pod)).toEqual([])
  })

  it('inspects init containers as well as regular containers', () => {
    const pod = buildPod(PodPhase.PENDING, {
      initContainerStatuses: [
        waitingContainer('init', 'CreateContainerConfigError')
      ],
      containerStatuses: [waitingContainer('job', 'InvalidImageName')]
    })
    const errors = getContainerErrors(pod)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain(
      '  ✗ container "init": CreateContainerConfigError'
    )
    expect(errors[1]).toContain('  ✗ container "job": InvalidImageName')
  })

  it('ignores running/terminated containers and only collects waiting errors', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        { name: 'running', state: { running: {} } } as k8s.V1ContainerStatus,
        waitingContainer('bad', 'InvalidImageName')
      ]
    })
    const errors = getContainerErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "bad": InvalidImageName')
  })
})

describe('getImagePullGraceMs', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS']
  })

  it('returns the default 5 minutes when the env var is unset', () => {
    expect(getImagePullGraceMs()).toBe(5 * 60 * 1000)
  })

  it('reads ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS in seconds', () => {
    process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS'] = '120'
    expect(getImagePullGraceMs()).toBe(120 * 1000)
  })

  it('returns 0 when grace is set to 0 (immediate fail, old behavior)', () => {
    process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS'] = '0'
    expect(getImagePullGraceMs()).toBe(0)
  })

  it('falls back to the default for invalid or negative values', () => {
    process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS'] = 'abc'
    expect(getImagePullGraceMs()).toBe(5 * 60 * 1000)
    process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS'] = '-5'
    expect(getImagePullGraceMs()).toBe(5 * 60 * 1000)
  })
})

describe('evaluateImagePullFailures', () => {
  it('returns no errors when there are no image-pull failures', () => {
    const firstSeen = new Map<string, number>()
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ContainerCreating')]
    })
    expect(evaluateImagePullFailures(pod, firstSeen, 300000, 1000)).toEqual([])
    expect(firstSeen.size).toBe(0)
  })

  it('records first observation and stays silent within the grace period', () => {
    const firstSeen = new Map<string, number>()
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer(
          'job',
          'ImagePullBackOff',
          'Back-off pulling image "nope:latest"'
        )
      ]
    })
    expect(evaluateImagePullFailures(pod, firstSeen, 300000, 1000)).toEqual([])
    expect(firstSeen.get('job')).toBe(1000)
    // Still within grace on a later poll.
    expect(
      evaluateImagePullFailures(pod, firstSeen, 300000, 1000 + 299999)
    ).toEqual([])
  })

  it('errors for ImagePullBackOff and ErrImagePull once the grace period expires', () => {
    const firstSeen = new Map<string, number>()
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer('job', 'ImagePullBackOff'),
        waitingContainer('svc', 'ErrImagePull', 'TLS handshake timeout')
      ]
    })
    const now = 1000
    evaluateImagePullFailures(pod, firstSeen, 300000, now)
    const errors = evaluateImagePullFailures(
      pod,
      firstSeen,
      300000,
      now + 300000
    )
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('  ✗ container "job": ImagePullBackOff')
    expect(errors[0]).toContain('exceeding the 300s grace period')
    expect(errors[0]).toContain('→')
    expect(errors[1]).toContain('  ✗ container "svc": ErrImagePull')
  })

  it('fails immediately on a permanent image-pull error message', () => {
    const firstSeen = new Map<string, number>()
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer(
          'job',
          'ImagePullBackOff',
          'pull access denied for nope/nonexistent, repository does not exist or may require docker login'
        )
      ]
    })
    const errors = evaluateImagePullFailures(pod, firstSeen, 300000, 1000)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "job": ImagePullBackOff')
    expect(errors[0]).toContain('(permanent image error)')
  })

  it('does not reset the grace window while the failure persists', () => {
    const firstSeen = new Map<string, number>()
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ImagePullBackOff')]
    })
    evaluateImagePullFailures(pod, firstSeen, 300000, 1000)
    evaluateImagePullFailures(pod, firstSeen, 300000, 50000)
    expect(firstSeen.get('job')).toBe(1000)
  })

  it('clears tracking on recovery so a later failure gets a fresh grace window', () => {
    const firstSeen = new Map<string, number>()
    const failing = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'ImagePullBackOff')]
    })
    const recovered = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        { name: 'job', state: { running: {} } } as k8s.V1ContainerStatus
      ]
    })
    evaluateImagePullFailures(failing, firstSeen, 300000, 1000)
    expect(firstSeen.size).toBe(1)
    evaluateImagePullFailures(recovered, firstSeen, 300000, 2000)
    expect(firstSeen.size).toBe(0)
    // A fresh failure starts a new grace window.
    expect(evaluateImagePullFailures(failing, firstSeen, 300000, 3000)).toEqual(
      []
    )
  })

  it('tracks containers independently', () => {
    const firstSeen = new Map<string, number>()
    const now = 1000
    firstSeen.set('old', now) // 'old' has been failing since `now`
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer('old', 'ImagePullBackOff'),
        waitingContainer('fresh', 'ImagePullBackOff')
      ]
    })
    const errors = evaluateImagePullFailures(
      pod,
      firstSeen,
      300000,
      now + 300000
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('container "old"')
    expect(errors[0]).not.toContain('"fresh"')
    expect(firstSeen.get('fresh')).toBe(now + 300000)
  })
})

describe('getPodEventErrors', () => {
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    eventSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS']
  })

  it('returns no errors when there are no warning events', async () => {
    eventSpy.mockResolvedValue(eventResult([]))
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('returns no errors for warning events whose reason is not unrecoverable', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('Unhealthy', 'Liveness probe failed'),
        buildEvent('BackOff', 'container restart back-off')
      ])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('detects FailedMount (the hostPath Directory missing case) and includes hint', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent(
          'FailedMount',
          'Unable to attach or mount volume "bad-hostpath": mount path "/this/path/does/not/exist" does not exist',
          { count: 3 }
        )
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ event: FailedMount (x3)')
    expect(errors[0]).toContain('does not exist')
    expect(errors[0]).toContain('PVC')
  })

  it('fast-fails on FailedScheduling with permanent config errors', async () => {
    for (const msg of [
      "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.",
      '0/3 nodes are available: 3 node(s) had untolerated taint {gpu: true}.',
      '0/3 nodes are available: persistentvolumeclaim "my-pvc" not found. preemption: 0/3'
    ]) {
      eventSpy.mockResolvedValue(
        eventResult([buildEvent('FailedScheduling', msg)])
      )
      const errors = await getPodEventErrors('my-pod')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('  ✗ event: FailedScheduling')
      expect(errors[0]).toContain('→')
    }
  })

  it('does NOT fast-fail on FailedScheduling with resource shortages (keeps queuing)', async () => {
    for (const msg of [
      '0/3 nodes are available: 3 Insufficient nvidia.com/gpu.',
      '0/5 nodes are available: 5 Insufficient memory.',
      '0/1 nodes are available'
    ]) {
      eventSpy.mockResolvedValue(
        eventResult([buildEvent('FailedScheduling', msg)])
      )
      expect(await getPodEventErrors('my-pod')).toEqual([])
    }
    // No message at all — unknown cause, treat as transient
    eventSpy.mockResolvedValue(
      eventResult([{ type: 'Warning', reason: 'FailedScheduling' } as k8s.CoreV1Event])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('detects FailedBinding and FailedMount (always unrecoverable) and includes hints', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedBinding', 'no persistent volumes available'),
        buildEvent('FailedMount', 'volume not found')
      ])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('  ✗ event: FailedBinding')
    expect(errors[0]).toContain('StorageClass')
    expect(errors[1]).toContain('  ✗ event: FailedMount')
    expect(errors[1]).toContain('PVC')
  })

  it('ignores Normal-type events even if the reason matches', async () => {
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedMount', 'volume not found', { type: 'Normal' })])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })

  it('deduplicates events that share the same reason', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedMount', 'first attempt', { count: 1 }),
        buildEvent('FailedMount', 'second attempt', { count: 5 })
      ])
    )
    // Only the first occurrence is kept.
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ event: FailedMount')
    expect(errors[0]).toContain('first attempt')
  })

  it('honors extra reasons from the env var and includes default hint', async () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS'] =
      'FailedPreStopHook'
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedPreStopHook', 'hook failed')])
    )
    const errors = await getPodEventErrors('my-pod')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ event: FailedPreStopHook')
    expect(errors[0]).toContain('hook failed')
    expect(errors[0]).toContain('kubectl describe pod')
  })

  it('degrades gracefully when listing events is forbidden', async () => {
    eventSpy.mockRejectedValue(new Error('events is forbidden') as never)
    expect(await getPodEventErrors('my-pod')).toEqual([])
  })
})

describe('isPermanentSchedulingFailure', () => {
  it('returns true for node affinity/selector mismatch', () => {
    expect(
      isPermanentSchedulingFailure(
        "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector."
      )
    ).toBe(true)
    expect(
      isPermanentSchedulingFailure(
        "0/5 nodes are available: 5 node(s) didn't match node affinity."
      )
    ).toBe(true)
  })

  it('returns true for untolerated taint', () => {
    expect(
      isPermanentSchedulingFailure(
        '0/3 nodes are available: 3 node(s) had untolerated taint {gpu: true}.'
      )
    ).toBe(true)
  })

  it('returns true for PVC not found', () => {
    expect(
      isPermanentSchedulingFailure(
        '0/3 nodes are available: persistentvolumeclaim "my-pvc" not found. preemption: 0/3'
      )
    ).toBe(true)
  })

  it('returns false for resource shortages (transient — keep queuing)', () => {
    expect(isPermanentSchedulingFailure('0/3 nodes are available: 3 Insufficient nvidia.com/gpu.')).toBe(false)
    expect(isPermanentSchedulingFailure('0/5 nodes are available: 5 Insufficient memory.')).toBe(false)
    expect(isPermanentSchedulingFailure('0/2 nodes are available: 2 Insufficient cpu.')).toBe(false)
  })

  it('returns false for ambiguous / unknown messages (safe default: keep queuing)', () => {
    expect(isPermanentSchedulingFailure('0/1 nodes are available')).toBe(false)
    expect(isPermanentSchedulingFailure('preemption: 0/3 nodes are available')).toBe(false)
    expect(isPermanentSchedulingFailure(undefined)).toBe(false)
  })

  it('PERMANENT_SCHEDULING_PATTERNS is non-empty', () => {
    expect(PERMANENT_SCHEDULING_PATTERNS.length).toBeGreaterThan(0)
  })
})

describe('getUnrecoverableWaitingReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS']
  })

  it('returns the built-in defaults when the env var is unset', () => {
    expect(getUnrecoverableWaitingReasons()).toEqual(
      UNRECOVERABLE_WAITING_REASONS
    )
  })

  it('adds extra reasons from the env var without dropping the defaults', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS'] =
      'CrashLoopBackOff, RunContainerError'
    const reasons = getUnrecoverableWaitingReasons()
    for (const builtin of Array.from(UNRECOVERABLE_WAITING_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
    expect(reasons.has('CrashLoopBackOff')).toBe(true)
    expect(reasons.has('RunContainerError')).toBe(true)
  })

  it('makes getContainerErrors honor the extended whitelist', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS'] =
      'CrashLoopBackOff'
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [waitingContainer('job', 'CrashLoopBackOff')]
    })
    const errors = getContainerErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "job": CrashLoopBackOff')
  })
})

describe('getUnrecoverableEventReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS']
  })

  it('returns the built-in defaults when the env var is unset', () => {
    expect(getUnrecoverableEventReasons()).toEqual(UNRECOVERABLE_EVENT_REASONS)
  })

  it('adds extra reasons from the env var without dropping the defaults', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS'] =
      'FailedPreStopHook, FailedPostStartHook'
    const reasons = getUnrecoverableEventReasons()
    for (const builtin of Array.from(UNRECOVERABLE_EVENT_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
    expect(reasons.has('FailedPreStopHook')).toBe(true)
    expect(reasons.has('FailedPostStartHook')).toBe(true)
  })
})

describe('getContainerTerminatedErrors', () => {
  it('returns no errors when there are no container statuses', () => {
    expect(getContainerTerminatedErrors(buildPod(PodPhase.FAILED))).toEqual([])
    expect(getContainerTerminatedErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns no errors when containers have no terminated state', () => {
    const pod = buildPod(PodPhase.RUNNING, {
      containerStatuses: [
        { name: 'job', state: { running: {} } } as k8s.V1ContainerStatus,
        waitingContainer('sidecar', 'ContainerCreating')
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('returns no errors for terminated containers with recoverable reasons', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [
        terminatedContainer('fs-init', 'Completed', 0)
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('detects OOMKilled and includes hint', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'OOMKilled', 137, 'The node was low on resource: memory')
      ]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "job": OOMKilled (exit code 137)')
    expect(errors[0]).toContain('The node was low on resource: memory')
    expect(errors[0]).toContain('memory limit')
  })

  it('detects Error exit code 1 and includes generic hint', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'Error', 1)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "job": Error (exit code 1)')
    expect(errors[0]).toContain('non-zero code (1)')
  })

  it('detects Error exit code 137 and includes SIGKILL hint', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'Error', 137)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors[0]).toContain('exit code 137')
    expect(errors[0]).toContain('SIGKILL')
  })

  it('detects Error exit code 127 and includes command-not-found hint', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'Error', 127)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors[0]).toContain('command not found')
  })

  it('detects FailedPostStartHookError and includes hint', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'FailedPostStartHookError', 137, 'postStart hook failed')
      ]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "job": FailedPostStartHookError (exit code 137)')
    expect(errors[0]).toContain('postStart hook failed')
    expect(errors[0]).toContain('postStart lifecycle hook')
  })

  it('detects every unrecoverable terminated reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      const pod = buildPod(PodPhase.FAILED, {
        containerStatuses: [terminatedContainer('job', reason, 1)]
      })
      const errors = getContainerTerminatedErrors(pod)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(`  ✗ container "job": ${reason} (exit code 1)`)
    }
  })

  it('detects terminated errors in init containers as well', () => {
    const pod = buildPod(PodPhase.FAILED, {
      initContainerStatuses: [terminatedContainer('init', 'Error', 2)],
      containerStatuses: [terminatedContainer('job', 'OOMKilled', 137)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('  ✗ container "init": Error (exit code 2)')
    expect(errors[1]).toContain('  ✗ container "job": OOMKilled (exit code 137)')
  })

  it('ignores terminated with reason not in the whitelist', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [
        terminatedContainer('job', 'Completed', 0)
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })
})

describe('getUnrecoverableTerminatedReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS']
  })

  it('returns the built-in defaults when the env var is unset', () => {
    expect(getUnrecoverableTerminatedReasons()).toEqual(UNRECOVERABLE_TERMINATED_REASONS)
  })

  it('adds extra reasons from the env var without dropping the defaults', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] =
      'DeadlineExceeded, CustomReason'
    const reasons = getUnrecoverableTerminatedReasons()
    for (const builtin of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
    expect(reasons.has('DeadlineExceeded')).toBe(true)
    expect(reasons.has('CustomReason')).toBe(true)
  })

  it('makes getContainerTerminatedErrors honor the extended whitelist', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] =
      'DeadlineExceeded'
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'DeadlineExceeded', 1)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('  ✗ container "job": DeadlineExceeded (exit code 1)')
  })

  it('filters empty strings from the env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] =
      ', , CustomReason, '
    const reasons = getUnrecoverableTerminatedReasons()
    expect(reasons.has('')).toBe(false)
    expect(reasons.has('CustomReason')).toBe(true)
    for (const builtin of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
  })
})

describe('waitForPodPhases', () => {
  let readSpy: jest.SpyInstance
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod')
    // waitForPodPhases now calls getPodEventErrors (lists events) on every poll
    // for fast-fail detection, and describePodFailure on failure paths (also
    // lists events). Stub it out so the tests never hit a real cluster.
    eventSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent')
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS']
  })

  it('returns once the pod reaches an awaited phase', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.RUNNING)))

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).resolves.toBeUndefined()
  })

  it('surfaces unrecoverable container errors in the thrown message', async () => {
    readSpy.mockResolvedValue(
      podResult(
        buildPod(PodPhase.PENDING, {
          containerStatuses: [waitingContainer('job', 'InvalidImageName', 'nope')]
        })
      )
    )

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow('Pod my-pod has unrecoverable errors')
  })

  it('fails immediately on ImagePullBackOff when grace is set to 0 (old behavior)', async () => {
    process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS'] = '0'
    readSpy.mockResolvedValue(
      podResult(
        buildPod(PodPhase.PENDING, {
          containerStatuses: [
            waitingContainer('job', 'ImagePullBackOff', 'Back-off pulling image "nope:latest"')
          ]
        })
      )
    )

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/has unrecoverable errors:[\s\S]*ImagePullBackOff/)
  })

  it('keeps polling an image-pull failure within the grace period and succeeds once the pod becomes ready', async () => {
    // Default grace (300s): a fresh ImagePullBackOff must NOT fail the job.
    readSpy
      .mockResolvedValueOnce(
        podResult(
          buildPod(PodPhase.PENDING, {
            containerStatuses: [waitingContainer('job', 'ImagePullBackOff')]
          })
        )
      )
      .mockResolvedValueOnce(podResult(buildPod(PodPhase.RUNNING)))

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).resolves.toBeUndefined()
  })

  it('fails immediately on a permanent image error even with a large grace period', async () => {
    process.env['ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS'] = '600'
    readSpy.mockResolvedValue(
      podResult(
        buildPod(PodPhase.PENDING, {
          containerStatuses: [
            waitingContainer(
              'job',
              'ImagePullBackOff',
              'pull access denied for nope/nonexistent, repository does not exist or may require docker login'
            )
          ]
        })
      )
    )

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(
      /has unrecoverable errors:[\s\S]*\(permanent image error\)/
    )
  })

  it('fast-fails on FailedMount events instead of polling to timeout', async () => {
    // Container is in ContainerCreating (recoverable waiting reason), but the
    // pod has a FailedMount Warning event -- this is the hostPath-missing case.
    readSpy.mockResolvedValue(
      podResult(
        buildPod(PodPhase.PENDING, {
          containerStatuses: [waitingContainer('job', 'ContainerCreating')]
        })
      )
    )
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent(
          'FailedMount',
          'mount path "/this/path/does/not/exist" does not exist',
          { count: 4 }
        )
      ])
    )

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(
      /has unrecoverable errors:[\s\S]*event: FailedMount \(x4\)/
    )
  })

  it('fast-fails on FailedScheduling with permanent message (PVC not found)', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.PENDING)))
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent(
          'FailedScheduling',
          '0/3 nodes are available: persistentvolumeclaim "missing-pvc" not found. preemption: 0/3'
        )
      ])
    )
    await expect(
      waitForPodPhases('my-pod', new Set([PodPhase.RUNNING]), new Set([PodPhase.PENDING]))
    ).rejects.toThrow(/has unrecoverable errors:[\s\S]*event: FailedScheduling/)
  })

  it('does NOT fast-fail on FailedScheduling with Insufficient resources (keeps polling)', async () => {
    readSpy
      .mockResolvedValueOnce(podResult(buildPod(PodPhase.PENDING)))
      .mockResolvedValueOnce(podResult(buildPod(PodPhase.RUNNING)))
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedScheduling', '0/3 nodes are available: 3 Insufficient nvidia.com/gpu.')])
    )
    await expect(
      waitForPodPhases('my-pod', new Set([PodPhase.RUNNING]), new Set([PodPhase.PENDING]))
    ).resolves.toBeUndefined()
  })

  it('retries on transient readPod failure and recovers when pod becomes ready', async () => {
    // Risk A fix: a transient readPod error must NOT crash the loop immediately.
    // Pod read fails twice, then returns Running — function must resolve.
    readSpy
      .mockRejectedValueOnce(new Error('connection refused') as never)
      .mockRejectedValueOnce(new Error('connection refused') as never)
      .mockResolvedValue(podResult(buildPod(PodPhase.RUNNING)))
    // eventSpy already returns [] from beforeEach

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).resolves.toBeUndefined()
  })

  it('throws with the phase when the pod is in a non-backoff phase', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.FAILED)))

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow('Pod my-pod is unhealthy (phase: Failed)')
  })
})

describe('describePodFailure', () => {
  let readSpy: jest.SpyInstance
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod')
    eventSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent')
    // Default: no events. Individual tests override this.
    eventSpy.mockResolvedValue(eventResult([]))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('reports phase, failing conditions and terminated containers', async () => {
    readSpy.mockResolvedValue(
      podResult({
        status: {
          phase: PodPhase.FAILED,
          reason: 'Evicted',
          message: 'The node was low on resource: memory',
          conditions: [
            {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: 'no nodes available'
            }
          ],
          containerStatuses: [
            {
              name: 'job',
              state: {
                terminated: { exitCode: 137, reason: 'OOMKilled' }
              }
            }
          ]
        }
      } as k8s.V1Pod)
    )

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Pod status: Failed (Evicted)')
    expect(description).toContain('The node was low on resource: memory')
    expect(description).toContain(
      '✗ PodScheduled=False (Unschedulable): no nodes available'
    )
    expect(description).toContain(
      '✗ container "job" terminated: OOMKilled (exit code 137)'
    )
  })

  it('includes recent Warning events and skips Normal ones', async () => {
    readSpy.mockResolvedValue(
      podResult({ status: { phase: PodPhase.PENDING } } as k8s.V1Pod)
    )
    eventSpy.mockResolvedValue(
      eventResult([
        {
          type: 'Normal',
          reason: 'Scheduled',
          message: 'assigned',
          lastTimestamp: new Date('2026-01-01T00:00:00Z')
        } as k8s.CoreV1Event,
        {
          type: 'Warning',
          reason: 'FailedScheduling',
          message: '0/1 nodes are available',
          count: 3,
          lastTimestamp: new Date('2026-01-01T00:01:00Z')
        } as k8s.CoreV1Event
      ])
    )

    const description = await describePodFailure('my-pod')
    expect(description).toContain(
      '[FailedScheduling] (x3) 0/1 nodes are available'
    )
    expect(description).not.toContain('[Scheduled]')
  })

  it('degrades gracefully when listing events is forbidden', async () => {
    readSpy.mockResolvedValue(
      podResult({ status: { phase: PodPhase.PENDING } } as k8s.V1Pod)
    )
    eventSpy.mockRejectedValue(new Error('events is forbidden') as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Pod status: Pending')
    // No throw, and no event lines.
    expect(description).not.toContain('[Warning]')
  })

  it('never throws when the pod cannot be read', async () => {
    readSpy.mockRejectedValue(new Error('pod not found') as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Could not read pod my-pod for diagnostics')
  })
})
