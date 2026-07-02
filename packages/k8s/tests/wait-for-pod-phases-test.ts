import * as k8s from '@kubernetes/client-node'
import {
  describePodFailure,
  getContainerErrors,
  getContainerTerminatedErrors,
  getPodEventErrors,
  getUnrecoverableEventReasons,
  getUnrecoverableTerminatedReasons,
  getUnrecoverableWaitingReasons,
  parsePodPhase,
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

  it('detects every unrecoverable waiting reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_WAITING_REASONS)) {
      const pod = buildPod(PodPhase.PENDING, {
        containerStatuses: [waitingContainer('job', reason)]
      })
      expect(getContainerErrors(pod)).toEqual([
        `  ✗ container "job": ${reason}`
      ])
    }
  })

  it('includes the waiting message as an indented second line', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        waitingContainer(
          'job',
          'ErrImagePull',
          'Back-off pulling image "does-not-exist:latest"'
        )
      ]
    })
    expect(getContainerErrors(pod)).toEqual([
      '  ✗ container "job": ErrImagePull\n    Back-off pulling image "does-not-exist:latest"'
    ])
  })

  it('inspects init containers as well as regular containers', () => {
    const pod = buildPod(PodPhase.PENDING, {
      initContainerStatuses: [waitingContainer('init', 'ImagePullBackOff')],
      containerStatuses: [waitingContainer('job', 'CreateContainerError')]
    })
    expect(getContainerErrors(pod)).toEqual([
      '  ✗ container "init": ImagePullBackOff',
      '  ✗ container "job": CreateContainerError'
    ])
  })

  it('ignores running/terminated containers and only collects waiting errors', () => {
    const pod = buildPod(PodPhase.PENDING, {
      containerStatuses: [
        { name: 'running', state: { running: {} } } as k8s.V1ContainerStatus,
        waitingContainer('bad', 'InvalidImageName')
      ]
    })
    expect(getContainerErrors(pod)).toEqual([
      '  ✗ container "bad": InvalidImageName'
    ])
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

  it('detects FailedMount (the hostPath Directory missing case)', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent(
          'FailedMount',
          'Unable to attach or mount volume "bad-hostpath": mount path "/this/path/does/not/exist" does not exist',
          { count: 3 }
        )
      ])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([
      '  ✗ event: FailedMount (x3)\n    Unable to attach or mount volume "bad-hostpath": mount path "/this/path/does/not/exist" does not exist'
    ])
  })

  it('detects every unrecoverable event reason', async () => {
    eventSpy.mockResolvedValue(
      eventResult([
        buildEvent('FailedScheduling', '0/1 nodes are available'),
        buildEvent('FailedBinding', 'no persistent volumes available'),
        buildEvent('FailedMount', 'volume not found')
      ])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([
      '  ✗ event: FailedScheduling\n    0/1 nodes are available',
      '  ✗ event: FailedBinding\n    no persistent volumes available',
      '  ✗ event: FailedMount\n    volume not found'
    ])
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
    expect(await getPodEventErrors('my-pod')).toEqual([
      '  ✗ event: FailedMount\n    first attempt'
    ])
  })

  it('honors extra reasons from the env var', async () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS'] =
      'FailedPreStopHook'
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedPreStopHook', 'hook failed')])
    )
    expect(await getPodEventErrors('my-pod')).toEqual([
      '  ✗ event: FailedPreStopHook\n    hook failed'
    ])
  })

  it('degrades gracefully when listing events is forbidden', async () => {
    eventSpy.mockRejectedValue(new Error('events is forbidden') as never)
    expect(await getPodEventErrors('my-pod')).toEqual([])
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
    expect(getContainerErrors(pod)).toEqual([
      '  ✗ container "job": CrashLoopBackOff'
    ])
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

  it('detects OOMKilled', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'OOMKilled', 137, 'The node was low on resource: memory')
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      '  ✗ container "job": OOMKilled (exit code 137)\n    The node was low on resource: memory'
    ])
  })

  it('detects Error (exit non-zero)', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'Error', 1)
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      '  ✗ container "job": Error (exit code 1)'
    ])
  })

  it('detects FailedPostStartHookError', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'FailedPostStartHookError', 137, 'postStart hook failed')
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      '  ✗ container "job": FailedPostStartHookError (exit code 137)\n    postStart hook failed'
    ])
  })

  it('detects every unrecoverable terminated reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      const pod = buildPod(PodPhase.FAILED, {
        containerStatuses: [terminatedContainer('job', reason, 1)]
      })
      expect(getContainerTerminatedErrors(pod)).toEqual([
        `  ✗ container "job": ${reason} (exit code 1)`
      ])
    }
  })

  it('detects terminated errors in init containers as well', () => {
    const pod = buildPod(PodPhase.FAILED, {
      initContainerStatuses: [terminatedContainer('init', 'Error', 2)],
      containerStatuses: [terminatedContainer('job', 'OOMKilled', 137)]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      '  ✗ container "init": Error (exit code 2)',
      '  ✗ container "job": OOMKilled (exit code 137)'
    ])
  })

  it('ignores terminated with reason not in the whitelist', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [
        terminatedContainer('job', 'Completed', 0)
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('does not flag containers with unrecoverable reason but exitCode=0 (false positive guard)', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [
        terminatedContainer('job', 'Error', 0),
        terminatedContainer('side', 'OOMKilled', 0)
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
    expect(getContainerTerminatedErrors(pod)).toEqual([
      '  ✗ container "job": DeadlineExceeded (exit code 1)'
    ])
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
          containerStatuses: [
            waitingContainer(
              'job',
              'ImagePullBackOff',
              'Back-off pulling image "nope:latest"'
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
    ).rejects.toThrow('Pod my-pod has unrecoverable errors')
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

  it('fast-fails on FailedScheduling events', async () => {
    readSpy.mockResolvedValue(podResult(buildPod(PodPhase.PENDING)))
    eventSpy.mockResolvedValue(
      eventResult([buildEvent('FailedScheduling', '0/1 nodes are available')])
    )

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/event: FailedScheduling[\s\S]*0\/1 nodes are available/)
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

  it('skips readPod when preFetchedPod is provided', async () => {
    const pod = {
      status: {
        phase: PodPhase.FAILED,
        containerStatuses: [
          {
            name: 'job',
            state: { terminated: { exitCode: 1, reason: 'Error' } }
          }
        ]
      }
    } as k8s.V1Pod

    readSpy.mockRejectedValue(new Error('should not be called') as never)

    const description = await describePodFailure('my-pod', pod)
    expect(readSpy).not.toHaveBeenCalled()
    expect(description).toContain('Pod status: Failed')
    expect(description).toContain('✗ container "job" terminated: Error (exit code 1)')
  })
})
