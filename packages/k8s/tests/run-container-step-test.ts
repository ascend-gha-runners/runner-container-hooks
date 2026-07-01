import { runContainerStep } from '../src/hooks'
import { TestHelper } from './test-setup'
import { ENV_HOOK_TEMPLATE_PATH } from '../src/k8s/utils'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { JOB_CONTAINER_EXTENSION_NAME } from '../src/hooks/constants'
import * as k8s from '@kubernetes/client-node'
import {
  getContainerTerminatedErrors,
  getUnrecoverableTerminatedReasons,
  UNRECOVERABLE_TERMINATED_REASONS
} from '../src/k8s'
import * as k8sModule from '../src/k8s'
import * as coreModule from '@actions/core'
import { RunContainerStepArgs } from 'hooklib'

import { PodPhase } from '../src/k8s/utils'

jest.useRealTimers()

let testHelper: TestHelper

let runContainerStepData: any

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

describe('Run container step', () => {
  beforeEach(async () => {
    testHelper = new TestHelper()
    await testHelper.initialize()
    runContainerStepData = testHelper.getRunContainerStepDefinition()
  })

  afterEach(async () => {
    await testHelper.cleanup()
  })

  it('should not throw', async () => {
    const exitCode = await runContainerStep(runContainerStepData.args)
    expect(exitCode).toBe(0)
  })

  it('should run pod with extensions applied', async () => {
    const extension = {
      metadata: {
        annotations: {
          foo: 'bar'
        },
        labels: {
          bar: 'baz'
        }
      },
      spec: {
        containers: [
          {
            name: JOB_CONTAINER_EXTENSION_NAME,
            command: ['sh'],
            args: ['-c', 'echo test']
          },
          {
            name: 'side-container',
            image: 'ubuntu:latest',
            command: ['sh'],
            args: ['-c', 'echo test']
          }
        ],
        restartPolicy: 'Never',
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 3000
        }
      }
    }

    let filePath = testHelper.createFile()
    fs.writeFileSync(filePath, yaml.dump(extension))
    process.env[ENV_HOOK_TEMPLATE_PATH] = filePath
    await expect(
      runContainerStep(runContainerStepData.args)
    ).resolves.not.toThrow()
    delete process.env[ENV_HOOK_TEMPLATE_PATH]
  })

  it('should shold have env variables available', async () => {
    runContainerStepData.args.entryPoint = 'bash'
    runContainerStepData.args.entryPointArgs = [
      '-c',
      "'if [[ -z $NODE_ENV ]]; then exit 1; fi'"
    ]
    await expect(
      runContainerStep(runContainerStepData.args)
    ).resolves.not.toThrow()
  })

  it('should run container step with envs CI and GITHUB_ACTIONS', async () => {
    runContainerStepData.args.entryPoint = 'bash'
    runContainerStepData.args.entryPointArgs = [
      '-c',
      "'if [[ -z $GITHUB_ACTIONS  ]] || [[ -z $CI ]]; then exit 1; fi'"
    ]
    await expect(
      runContainerStep(runContainerStepData.args)
    ).resolves.not.toThrow()
  })
})

describe('getContainerTerminatedErrors', () => {
  it('returns no errors when there are no container statuses', () => {
    expect(getContainerTerminatedErrors(buildPod(PodPhase.FAILED))).toEqual(
      []
    )
    expect(getContainerTerminatedErrors({} as k8s.V1Pod)).toEqual([])
  })

  it('returns no errors when containers have running state', () => {
    const pod = buildPod(PodPhase.RUNNING, {
      containerStatuses: [
        { name: 'job', state: { running: {} } } as k8s.V1ContainerStatus
      ]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('returns no errors for Completed terminated reason', () => {
    const pod = buildPod(PodPhase.SUCCEEDED, {
      containerStatuses: [terminatedContainer('job', 'Completed', 0)]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
  })

  it('detects every unrecoverable terminated reason', () => {
    for (const reason of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      const pod = buildPod(PodPhase.FAILED, {
        containerStatuses: [terminatedContainer('job', reason, 1)]
      })
      const errors = getContainerTerminatedErrors(pod)
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain(reason)
      expect(errors[0]).toContain('exit code 1')
    }
  })

  it('detects OOMKilled with message', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'OOMKilled', 137, 'Memory limit exceeded')
      ]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toEqual([
      'container "job": OOMKilled (exit code 137) - Memory limit exceeded'
    ])
  })

  it('detects Error with non-zero exit code', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'Error', 1, 'container crashed')
      ]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toEqual([
      'container "job": Error (exit code 1) - container crashed'
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
    const errors = getContainerTerminatedErrors(pod)
    expect(errors).toEqual([
      'container "job": FailedPostStartHookError (exit code 137) - postStart hook failed'
    ])
  })

  it('inspects init containers as well as regular containers', () => {
    const pod = buildPod(PodPhase.FAILED, {
      initContainerStatuses: [terminatedContainer('init', 'OOMKilled', 137)],
      containerStatuses: [terminatedContainer('job', 'Error', 1)]
    })
    const errors = getContainerTerminatedErrors(pod)
    expect(errors.length).toBe(2)
    expect(errors[0]).toContain('init')
    expect(errors[1]).toContain('job')
  })

  it('returns empty for terminated reason not in the set', () => {
    const pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [terminatedContainer('job', 'SomeOtherReason', 1)]
    })
    expect(getContainerTerminatedErrors(pod)).toEqual([])
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
      'CustomReason, AnotherReason'
    const reasons = getUnrecoverableTerminatedReasons()
    for (const builtin of Array.from(UNRECOVERABLE_TERMINATED_REASONS)) {
      expect(reasons.has(builtin)).toBe(true)
    }
    expect(reasons.has('CustomReason')).toBe(true)
    expect(reasons.has('AnotherReason')).toBe(true)
  })

  it('filters empty strings from env var', () => {
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS'] =
      ', CrashLoopBackOff, '
    const reasons = getUnrecoverableTerminatedReasons()
    expect(reasons.has('CrashLoopBackOff')).toBe(true)
    expect(reasons.has('')).toBe(false)
  })
})

describe('runContainerStep includes describePodFailure output for terminated errors', () => {
  let coreErrorSpy: jest.SpyInstance
  let createJobSpy: jest.SpyInstance
  let getContainerJobPodNameSpy: jest.SpyInstance
  let waitForPodPhasesSpy: jest.SpyInstance
  let getPodLogsSpy: jest.SpyInstance
  let waitForJobToCompleteSpy: jest.SpyInstance
  let getPodStatusSpy: jest.SpyInstance
  let getPodByNameSpy: jest.SpyInstance
  let describePodFailureSpy: jest.SpyInstance

  const podName = 'test-pod-abc123'
  const jobName = 'test-job-xyz789'

  const diagnosticOutput = [
    'Phase: Failed',
    '────────────────────────────────────────────────────────────',
    '  ✗ Ready=False (ContainersNotReady): containers with unready status: [job]',
    '  ✗ container "job": OOMKilled (exit code 137)',
    '    Memory limit exceeded'
  ].join('\n')

  function makeMinimalArgs(): RunContainerStepArgs {
    return {
      image: 'test-image:latest',
      workingDirectory: '/__w/repo/repo',
      entryPoint: 'bash',
      entryPointArgs: ['-c', 'echo test'],
      systemMountVolumes: []
    } as RunContainerStepArgs
  }

  function podStatusWithTerminated(
    reason: string,
    exitCode: number,
    message?: string
  ): k8s.V1PodStatus {
    return {
      phase: 'Failed',
      containerStatuses: [
        {
          name: 'job',
          image: 'test-image:latest',
          imageID: '',
          ready: false,
          restartCount: 0,
          state: {
            terminated: { exitCode, reason, message }
          }
        } as k8s.V1ContainerStatus
      ]
    }
  }

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    delete process.env[ENV_HOOK_TEMPLATE_PATH]

    coreErrorSpy = jest.spyOn(coreModule, 'error').mockImplementation(() => {})

    createJobSpy = jest.spyOn(k8sModule, 'createJob').mockResolvedValue({
      metadata: { name: jobName }
    } as k8s.V1Job)

    getContainerJobPodNameSpy = jest
      .spyOn(k8sModule, 'getContainerJobPodName')
      .mockResolvedValue(podName)

    waitForPodPhasesSpy = jest
      .spyOn(k8sModule, 'waitForPodPhases')
      .mockResolvedValue(undefined)

    getPodLogsSpy = jest
      .spyOn(k8sModule, 'getPodLogs')
      .mockResolvedValue(undefined)

    waitForJobToCompleteSpy = jest
      .spyOn(k8sModule, 'waitForJobToComplete')
      .mockResolvedValue(undefined)

    describePodFailureSpy = jest
      .spyOn(k8sModule, 'describePodFailure')
      .mockResolvedValue(diagnosticOutput)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('includes describePodFailure output in core.error for OOMKilled container', async () => {
    const pod: k8s.V1Pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'OOMKilled', 137, 'Memory limit exceeded')
      ]
    })
    getPodStatusSpy = jest
      .spyOn(k8sModule, 'getPodStatus')
      .mockResolvedValue(podStatusWithTerminated('OOMKilled', 137, 'Memory limit exceeded'))
    getPodByNameSpy = jest
      .spyOn(k8sModule, 'getPodByName')
      .mockResolvedValue(pod)

    await runContainerStep(makeMinimalArgs())

    expect(describePodFailureSpy).toHaveBeenCalledWith(podName)
    expect(coreErrorSpy).toHaveBeenCalledTimes(1)
    const errorMessage = coreErrorSpy.mock.calls[0][0]
    expect(errorMessage).toContain('OOMKilled')
    expect(errorMessage).toContain(diagnosticOutput)
  })

  it('includes describePodFailure output in core.error for Error (exit non-zero) container', async () => {
    const pod: k8s.V1Pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'Error', 1, 'container crashed')
      ]
    })
    getPodStatusSpy = jest
      .spyOn(k8sModule, 'getPodStatus')
      .mockResolvedValue(podStatusWithTerminated('Error', 1, 'container crashed'))
    getPodByNameSpy = jest
      .spyOn(k8sModule, 'getPodByName')
      .mockResolvedValue(pod)

    await runContainerStep(makeMinimalArgs())

    expect(describePodFailureSpy).toHaveBeenCalledWith(podName)
    expect(coreErrorSpy).toHaveBeenCalledTimes(1)
    const errorMessage = coreErrorSpy.mock.calls[0][0]
    expect(errorMessage).toContain('Error')
    expect(errorMessage).toContain(diagnosticOutput)
  })

  it('includes describePodFailure output in core.error for FailedPostStartHookError container', async () => {
    const pod: k8s.V1Pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer(
          'job',
          'FailedPostStartHookError',
          137,
          'postStart hook failed'
        )
      ]
    })
    getPodStatusSpy = jest
      .spyOn(k8sModule, 'getPodStatus')
      .mockResolvedValue(
        podStatusWithTerminated('FailedPostStartHookError', 137, 'postStart hook failed')
      )
    getPodByNameSpy = jest
      .spyOn(k8sModule, 'getPodByName')
      .mockResolvedValue(pod)

    await runContainerStep(makeMinimalArgs())

    expect(describePodFailureSpy).toHaveBeenCalledWith(podName)
    expect(coreErrorSpy).toHaveBeenCalledTimes(1)
    const errorMessage = coreErrorSpy.mock.calls[0][0]
    expect(errorMessage).toContain('FailedPostStartHookError')
    expect(errorMessage).toContain(diagnosticOutput)
  })

  it('returns 1 when terminatedErrors are detected regardless of exitCode', async () => {
    const pod: k8s.V1Pod = buildPod(PodPhase.FAILED, {
      containerStatuses: [
        terminatedContainer('job', 'OOMKilled', 137, 'Memory limit exceeded')
      ]
    })
    getPodStatusSpy = jest
      .spyOn(k8sModule, 'getPodStatus')
      .mockResolvedValue(podStatusWithTerminated('OOMKilled', 137, 'Memory limit exceeded'))
    getPodByNameSpy = jest
      .spyOn(k8sModule, 'getPodByName')
      .mockResolvedValue(pod)

    const exitCode = await runContainerStep(makeMinimalArgs())
    expect(exitCode).toBe(1)
  })

  it('returns 1 when init container has terminated error and main container exitCode is undefined', async () => {
    const pod: k8s.V1Pod = {
      status: {
        phase: 'Failed',
        initContainerStatuses: [
          terminatedContainer('init', 'OOMKilled', 137)
        ],
        containerStatuses: [
          { name: 'job', state: { running: {} } } as k8s.V1ContainerStatus
        ]
      }
    } as k8s.V1Pod
    const podStatus: k8s.V1PodStatus = {
      phase: 'Failed',
      containerStatuses: [
        {
          name: 'job',
          image: 'test-image:latest',
          imageID: '',
          ready: false,
          restartCount: 0,
          state: { running: {} }
        } as k8s.V1ContainerStatus
      ]
    }
    getPodStatusSpy = jest
      .spyOn(k8sModule, 'getPodStatus')
      .mockResolvedValue(podStatus)
    getPodByNameSpy = jest
      .spyOn(k8sModule, 'getPodByName')
      .mockResolvedValue(pod)

    const exitCode = await runContainerStep(makeMinimalArgs())
    expect(exitCode).toBe(1)
  })
})
