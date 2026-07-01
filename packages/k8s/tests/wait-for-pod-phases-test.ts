import * as k8s from '@kubernetes/client-node'
import {
  describePodFailure,
  getContainerErrors,
  getContainerTerminatedErrors,
  getPodConditionErrors,
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

function buildPod(
  phase?: string,
  opts: {
    containerStatuses?: k8s.V1ContainerStatus[]
    initContainerStatuses?: k8s.V1ContainerStatus[]
    conditions?: k8s.V1PodCondition[]
  } = {}
): k8s.V1Pod {
  return {
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

  it('detects every unrecoverable waiting reason including FailedMount', () => {
    for (const reason of Array.from(UNRECOVERABLE_WAITING_REASONS)) {
      const pod = buildPod(PodPhase.PENDING, {
        containerStatuses: [waitingContainer('job', reason)]
      })
      expect(getContainerErrors(pod)).toEqual([`container "job": ${reason}`])
    }
  })

  it('includes the waiting message when present', () => {
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
      'container "job": ErrImagePull - Back-off pulling image "does-not-exist:latest"'
    ])
  })

  it('inspects init containers as well as regular containers', () => {
    const pod = buildPod(PodPhase.PENDING, {
      initContainerStatuses: [waitingContainer('init', 'ImagePullBackOff')],
      containerStatuses: [waitingContainer('job', 'CreateContainerError')]
    })
    expect(getContainerErrors(pod)).toEqual([
      'container "init": ImagePullBackOff',
      'container "job": CreateContainerError'
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
      'container "bad": InvalidImageName'
    ])
  })
})

describe('getPodConditionErrors', () => {
  it('returns empty array when no conditions', () => {
    expect(getPodConditionErrors(buildPod(PodPhase.PENDING))).toEqual([])
    expect(getPodConditionErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns empty array when all conditions are True', () => {
    const pod = buildPod(PodPhase.RUNNING, {
      conditions: [
        { type: 'PodScheduled', status: 'True' } as k8s.V1PodCondition,
        { type: 'Ready', status: 'True' } as k8s.V1PodCondition
      ]
    })
    expect(getPodConditionErrors(pod)).toEqual([])
  })

  it('detects PodScheduled=False with reason and message', () => {
    const pod = buildPod(PodPhase.PENDING, {
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: '0/1 nodes are available: 1 Insufficient memory.'
        } as k8s.V1PodCondition
      ]
    })
    expect(getPodConditionErrors(pod)).toEqual([
      'Condition PodScheduled=False (reason: Unschedulable): 0/1 nodes are available: 1 Insufficient memory.'
    ])
  })

  it('detects multiple False conditions', () => {
    const pod = buildPod(PodPhase.PENDING, {
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: 'no nodes'
        } as k8s.V1PodCondition,
        {
          type: 'Ready',
          status: 'False',
          reason: 'ContainersNotReady',
          message: 'containers unready'
        } as k8s.V1PodCondition
      ]
    })
    const errors = getPodConditionErrors(pod)
    expect(errors.length).toBe(2)
    expect(errors[0]).toContain('PodScheduled=False')
    expect(errors[1]).toContain('Ready=False')
  })

  it('handles conditions without reason or message', () => {
    const pod = buildPod(PodPhase.PENDING, {
      conditions: [
        { type: 'Ready', status: 'False' } as k8s.V1PodCondition
      ]
    })
    expect(getPodConditionErrors(pod)).toEqual([
      'Condition Ready=False (reason: ): '
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
  })

  it('detects FailedScheduling event', async () => {
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/1 nodes are available'
          }
        ]
      }
    } as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([
      'Event [Warning] FailedScheduling: 0/1 nodes are available'
    ])
  })

  it('detects FailedBinding event', async () => {
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Warning',
            reason: 'FailedBinding',
            message: 'no persistent volumes available'
          }
        ]
      }
    } as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([
      'Event [Warning] FailedBinding: no persistent volumes available'
    ])
  })

  it('detects FailedMount event', async () => {
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Warning',
            reason: 'FailedMount',
            message: 'MountVolume.SetUp failed for volume'
          }
        ]
      }
    } as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([
      'Event [Warning] FailedMount: MountVolume.SetUp failed for volume'
    ])
  })

  it('returns empty when events are Normal type', async () => {
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Normal',
            reason: 'Scheduled',
            message: 'assigned'
          }
        ]
      }
    } as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([])
  })

  it('returns empty when event reason is not in unrecoverable set', async () => {
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Warning',
            reason: 'SomeOtherReason',
            message: 'something happened'
          }
        ]
      }
    } as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([])
  })

  it('returns empty array when event API is forbidden', async () => {
    eventSpy.mockRejectedValue(new Error('events is forbidden') as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors).toEqual([])
  })

  it('detects multiple unrecoverable events', async () => {
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/1 nodes'
          },
          {
            type: 'Warning',
            reason: 'FailedMount',
            message: 'mount failed'
          }
        ]
      }
    } as never)

    const errors = await getPodEventErrors('my-pod')
    expect(errors.length).toBe(2)
    expect(errors[0]).toContain('FailedScheduling')
    expect(errors[1]).toContain('FailedMount')
  })
})

describe('getContainerTerminatedErrors', () => {
  it('returns empty when no container statuses', () => {
    expect(getContainerTerminatedErrors(buildPod(PodPhase.FAILED))).toEqual([])
    expect(getContainerTerminatedErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns empty when containers are running or waiting', () => {
    const pod = buildPod(PodPhase.RUNNING, {
      containerStatuses: [
        { name: 'job', state: { running: {} } } as k8s.V1ContainerStatus,
        waitingContainer('init', 'ContainerCreating')
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('detects OOMKilled', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'OOMKilled', 137, 'Memory limit exceeded')
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      'container "job": OOMKilled (exit code 137) - Memory limit exceeded'
    ])
  })

  it('detects Error reason with non-zero exit code', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'Error', 1)]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      'container "job": Error (exit code 1) - '
    ])
  })

  it('detects FailedPostStartHookError', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer(
          'job',
          'FailedPostStartHookError',
          137,
          'postStart hook failed'
        )
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      'container "job": FailedPostStartHookError (exit code 137) - postStart hook failed'
    ])
  })

  it('detects every unrecoverable terminated reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      const pod = buildPod(PodPhase.FAILED, {
        containerStatuses: [terminatedContainer('job', reason, 1)]
      })
      expect(getContainerTerminatedErrors(pod)).toEqual([
        `container "job": ${reason} (exit code 1) - `
      ])
    }
  })

  it('does not detect Completed reason (not in set)', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [
        terminatedContainer('job', 'Completed', 0)
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('inspects init containers as well', () => {
    const pod = buildPod(PodPhase.FAILED, {
      initContainerStatuses: [
        terminatedContainer('init', 'OOMKilled', 137)
      ],
      containerStatuses: [terminatedContainer('job', 'Error', 1)]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([
      'container "init": OOMKilled (exit code 137) - ',
      'container "job": Error (exit code 1) - '
    ])
  })
})

describe('waitForPodPhases', () => {
  let readSpy: jest.SpyInstance
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod')
    eventSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent')
    eventSpy.mockResolvedValue({ body: { items: [] } } as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('returns once the pod reaches an awaited phase', async () => {
    readSpy.mockResolvedValue({ body: buildPod(PodPhase.RUNNING) } as never)

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).resolves.toBeUndefined()
  })

  it('surfaces unrecoverable container errors in the thrown message', async () => {
    readSpy.mockResolvedValue({
      body: buildPod(PodPhase.PENDING, {
        containerStatuses: [
          waitingContainer(
            'job',
            'ImagePullBackOff',
            'Back-off pulling image "nope:latest"'
          )
        ]
      })
    } as never)

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(
      'container "job": ImagePullBackOff - Back-off pulling image "nope:latest"'
    )
  })

  it('throws with the phase when the pod is in a non-backoff phase', async () => {
    readSpy.mockResolvedValue({
      body: buildPod(PodPhase.FAILED)
    } as never)

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow('Pod my-pod is unhealthy with phase status Failed')
  })

  it('surfaces condition errors when PodScheduled=False', async () => {
    readSpy.mockResolvedValue({
      body: buildPod(PodPhase.PENDING, {
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: '0/1 nodes are available'
          } as k8s.V1PodCondition
        ]
      })
    } as never)

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow('condition errors')
  })

  it('surfaces event errors when FailedScheduling event detected', async () => {
    readSpy.mockResolvedValue({
      body: buildPod(PodPhase.PENDING)
    } as never)
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/1 nodes are available'
          }
        ]
      }
    } as never)

    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow('event errors')
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
      'container "job": CrashLoopBackOff'
    ])
  })

  it('filters empty strings from env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS'] = ', , '
    const reasons = getUnrecoverableWaitingReasons()
    expect(reasons).toEqual(UNRECOVERABLE_WAITING_REASONS)
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
      'SomeOtherReason'
    const reasons = getUnrecoverableEventReasons()
    for (const builtin of Array.from(UNRECOVERABLE_EVENT_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
    expect(reasons.has('SomeOtherReason')).toBe(true)
  })

  it('filters empty strings from env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS'] = ', , '
    const reasons = getUnrecoverableEventReasons()
    expect(reasons).toEqual(UNRECOVERABLE_EVENT_REASONS)
  })
})

describe('getUnrecoverableTerminatedReasons', () => {
  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS']
  })

  it('returns the built-in defaults when the env var is unset', () => {
    expect(getUnrecoverableTerminatedReasons()).toEqual(
      UNRECOVERABLE_TERMINATED_REASONS
    )
  })

  it('adds extra reasons from the env var without dropping the defaults', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] =
      'DeadlineExceeded'
    const reasons = getUnrecoverableTerminatedReasons()
    for (const builtin of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
    expect(reasons.has('DeadlineExceeded')).toBe(true)
  })

  it('filters empty strings from env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] = ', , '
    const reasons = getUnrecoverableTerminatedReasons()
    expect(reasons).toEqual(UNRECOVERABLE_TERMINATED_REASONS)
  })
})

describe('describePodFailure', () => {
  let readSpy: jest.SpyInstance
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod')
    eventSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent')
    eventSpy.mockResolvedValue({ body: { items: [] } } as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('reports phase, separator, ✗ conditions and ✗ terminated containers', async () => {
    readSpy.mockResolvedValue({
      body: {
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
      }
    } as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Phase: Failed (reason: Evicted)')
    expect(description).toContain('Message: The node was low on resource: memory')
    expect(description).toContain('────────────────────────────────────────────────────────────')
    expect(description).toContain('✗ PodScheduled=False (Unschedulable): no nodes available')
    expect(description).toContain(
      '✗ container "job": OOMKilled (exit code 137)'
    )
  })

  it('includes recent Warning events and skips Normal ones', async () => {
    readSpy.mockResolvedValue({
      body: { status: { phase: PodPhase.PENDING } }
    } as never)
    eventSpy.mockResolvedValue({
      body: {
        items: [
          {
            type: 'Normal',
            reason: 'Scheduled',
            message: 'assigned',
            lastTimestamp: new Date('2026-01-01T00:00:00Z')
          },
          {
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/1 nodes are available',
            count: 3,
            lastTimestamp: new Date('2026-01-01T00:01:00Z')
          }
        ]
      }
    } as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain(
      'Event [Warning] FailedScheduling (x3): 0/1 nodes are available'
    )
    expect(description).not.toContain('Scheduled')
  })

  it('degrades gracefully when listing events is forbidden', async () => {
    readSpy.mockResolvedValue({
      body: { status: { phase: PodPhase.PENDING } }
    } as never)
    eventSpy.mockRejectedValue(new Error('events is forbidden') as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Phase: Pending')
    expect(description).not.toContain('Event [Warning]')
  })

  it('never throws when the pod cannot be read', async () => {
    readSpy.mockRejectedValue(new Error('pod not found') as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Could not read pod my-pod for diagnostics')
  })

  it('formats waiting container with ✗ marker', async () => {
    readSpy.mockResolvedValue({
      body: {
        status: {
          phase: PodPhase.PENDING,
          containerStatuses: [
            {
              name: 'job',
              state: {
                waiting: {
                  reason: 'ErrImagePull',
                  message: 'image not found'
                }
              }
            }
          ]
        }
      }
    } as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('✗ container "job": ErrImagePull')
    expect(description).toContain('    image not found')
  })
})
