import * as k8s from '@kubernetes/client-node'
import * as core from '@actions/core'
import { runContainerStep } from '../src/hooks'
import * as k8sModule from '../src/k8s'
import { RunContainerStepArgs } from 'hooklib'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

function terminatedContainer(
  name: string,
  reason: string,
  exitCode: number,
  message?: string
): k8s.V1ContainerStatus {
  return {
    name,
    state: { terminated: { reason, exitCode, message } }
  } as k8s.V1ContainerStatus
}

function buildPodWithTerminated(
  containerStatuses: k8s.V1ContainerStatus[]
): k8s.V1Pod {
  return {
    metadata: { name: 'test-step-pod' },
    status: {
      phase: 'Failed',
      containerStatuses
    }
  } as k8s.V1Pod
}

function makeMinimalArgs(): RunContainerStepArgs {
  return {
    image: 'ubuntu:latest',
    entryPoint: 'sh',
    entryPointArgs: ['-c', 'echo test']
  } as RunContainerStepArgs
}

describe('runContainerStep terminated error detection', () => {
  let _createStepPodSpy: jest.SpyInstance
  let _waitForPodPhasesSpy: jest.SpyInstance
  let getPodByNameSpy: jest.SpyInstance
  let getContainerTerminatedErrorsSpy: jest.SpyInstance
  let describePodFailureSpy: jest.SpyInstance
  let _deletePodSpy: jest.SpyInstance
  let coreErrorSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['RUNNER_WORKSPACE'] = '/tmp/runner/_work/repo'
    process.env['GITHUB_WORKSPACE'] = '/tmp/runner/_work/repo/repo'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'test-runner-pod'

    _createStepPodSpy = jest
      .spyOn(k8sModule, 'createContainerStepPod')
      .mockResolvedValue({
        metadata: { name: 'test-step-pod' }
      } as k8s.V1Pod)

    _waitForPodPhasesSpy = jest
      .spyOn(k8sModule, 'waitForPodPhases')
      .mockRejectedValue(
        new Error('Pod test-step-pod has unrecoverable errors')
      )

    getPodByNameSpy = jest.spyOn(k8sModule, 'getPodByName')

    getContainerTerminatedErrorsSpy = jest.spyOn(
      k8sModule,
      'getContainerTerminatedErrors'
    )

    describePodFailureSpy = jest
      .spyOn(k8sModule, 'describePodFailure')
      .mockResolvedValue(
        'Pod status: Failed\nContainer details:\n  ✗ container "job" terminated: OOMKilled (exit code 137)'
      )

    _deletePodSpy = jest
      .spyOn(k8sModule, 'deletePod')
      .mockResolvedValue(undefined)

    coreErrorSpy = jest.spyOn(core, 'error')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['RUNNER_WORKSPACE']
    delete process.env['GITHUB_WORKSPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('detects OOMKilled and logs describePodFailure output', async () => {
    getPodByNameSpy.mockResolvedValue(
      buildPodWithTerminated([
        terminatedContainer(
          'job',
          'OOMKilled',
          137,
          'The node was low on resource: memory'
        )
      ])
    )
    getContainerTerminatedErrorsSpy.mockReturnValue([
      '  ✗ container "job": OOMKilled (exit code 137)\n    The node was low on resource: memory'
    ])

    await expect(runContainerStep(makeMinimalArgs())).rejects.toThrow()

    expect(getPodByNameSpy).toHaveBeenCalledWith('test-step-pod')
    expect(getContainerTerminatedErrorsSpy).toHaveBeenCalled()
    expect(describePodFailureSpy).toHaveBeenCalledWith('test-step-pod')
    expect(coreErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('OOMKilled')
    )
  })

  it('detects Error (exit non-zero) and logs describePodFailure output', async () => {
    getPodByNameSpy.mockResolvedValue(
      buildPodWithTerminated([terminatedContainer('job', 'Error', 1)])
    )
    getContainerTerminatedErrorsSpy.mockReturnValue([
      '  ✗ container "job": Error (exit code 1)'
    ])

    await expect(runContainerStep(makeMinimalArgs())).rejects.toThrow()

    expect(getPodByNameSpy).toHaveBeenCalledWith('test-step-pod')
    expect(getContainerTerminatedErrorsSpy).toHaveBeenCalled()
    expect(describePodFailureSpy).toHaveBeenCalledWith('test-step-pod')
    expect(coreErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error (exit code 1)')
    )
  })

  it('detects FailedPostStartHookError and logs describePodFailure output', async () => {
    getPodByNameSpy.mockResolvedValue(
      buildPodWithTerminated([
        terminatedContainer(
          'job',
          'FailedPostStartHookError',
          137,
          'postStart hook failed'
        )
      ])
    )
    getContainerTerminatedErrorsSpy.mockReturnValue([
      '  ✗ container "job": FailedPostStartHookError (exit code 137)\n    postStart hook failed'
    ])

    await expect(runContainerStep(makeMinimalArgs())).rejects.toThrow()

    expect(getPodByNameSpy).toHaveBeenCalledWith('test-step-pod')
    expect(getContainerTerminatedErrorsSpy).toHaveBeenCalled()
    expect(describePodFailureSpy).toHaveBeenCalledWith('test-step-pod')
    expect(coreErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FailedPostStartHookError')
    )
  })

  it('does not log terminated errors when pod has none', async () => {
    getPodByNameSpy.mockResolvedValue(buildPodWithTerminated([]))
    getContainerTerminatedErrorsSpy.mockReturnValue([])

    await expect(runContainerStep(makeMinimalArgs())).rejects.toThrow()

    expect(getPodByNameSpy).toHaveBeenCalledWith('test-step-pod')
    expect(getContainerTerminatedErrorsSpy).toHaveBeenCalled()
    expect(describePodFailureSpy).not.toHaveBeenCalled()
  })

  it('gracefully handles getPodByName failure', async () => {
    getPodByNameSpy.mockRejectedValue(new Error('pod not found'))

    await expect(runContainerStep(makeMinimalArgs())).rejects.toThrow()

    expect(getPodByNameSpy).toHaveBeenCalledWith('test-step-pod')
    expect(coreErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to run container step')
    )
  })
})
