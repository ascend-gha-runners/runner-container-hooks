import * as k8s from '@kubernetes/client-node'
import {
  describePodFailure,
  getContainerErrors,
  getUnrecoverableWaitingReasons,
  parsePodPhase,
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

describe('waitForPodPhases', () => {
  let readSpy: jest.SpyInstance
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod')
    // waitForPodPhases now calls describePodFailure on its failure paths, which
    // lists events. Stub it out so the tests never hit a real cluster.
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
    readSpy.mockResolvedValue({ body: buildPod(PodPhase.FAILED) } as never)

    // The message is no longer double-wrapped: it states the phase once and is
    // followed by the diagnostic block from describePodFailure.
    await expect(
      waitForPodPhases(
        'my-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow('Pod my-pod is unhealthy with phase status Failed')
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
})

describe('describePodFailure', () => {
  let readSpy: jest.SpyInstance
  let eventSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    readSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'readNamespacedPod')
    eventSpy = jest.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedEvent')
    // Default: no events. Individual tests override this.
    eventSpy.mockResolvedValue({ body: { items: [] } } as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('reports phase, failing conditions and terminated containers', async () => {
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
    expect(description).toContain(
      'Message: The node was low on resource: memory'
    )
    expect(description).toContain(
      'Condition PodScheduled=False (reason: Unschedulable): no nodes available'
    )
    expect(description).toContain(
      'Container "job" terminated: OOMKilled (exit code 137)'
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
    // No throw, and no event lines.
    expect(description).not.toContain('Event [Warning]')
  })

  it('never throws when the pod cannot be read', async () => {
    readSpy.mockRejectedValue(new Error('pod not found') as never)

    const description = await describePodFailure('my-pod')
    expect(description).toContain('Could not read pod my-pod for diagnostics')
  })
})
