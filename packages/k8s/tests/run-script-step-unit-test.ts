import * as core from '@actions/core'
import { runScriptStep } from '../src/hooks'
import * as k8sModule from '../src/k8s'
import * as utils from '../src/k8s/utils'
import { RunScriptStepArgs } from 'hooklib'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

function makeArgs(): RunScriptStepArgs {
  return {
    entryPoint: 'sh',
    entryPointArgs: ['-e', '/__w/_temp/script.sh'],
    workingDirectory: '/__w/repo/repo',
    environmentVariables: {}
  } as RunScriptStepArgs
}

const state = { jobPod: 'test-job-pod' }

describe('runScriptStep error classification', () => {
  let execPodStepSpy: jest.SpyInstance
  let execPodStepWithOutputSpy: jest.SpyInstance
  let execCpToPodSpy: jest.SpyInstance
  let execCpFromPodSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    process.env['RUNNER_WORKSPACE'] = '/tmp/runner/_work/repo'
    process.env['RUNNER_TEMP'] = '/tmp/runner/_work/_temp'

    // Mock writeRunScript so tests don't need a real filesystem
    jest.spyOn(utils, 'writeRunScript').mockReturnValue({
      containerPath: '/__w/_temp/test-script.sh',
      runnerPath: '/tmp/test-script.sh'
    })

    execPodStepSpy = jest
      .spyOn(k8sModule, 'execPodStep')
      .mockResolvedValue(0)

    execCpToPodSpy = jest
      .spyOn(k8sModule, 'execCpToPod')
      .mockResolvedValue(undefined)

    execCpFromPodSpy = jest
      .spyOn(k8sModule, 'execCpFromPod')
      .mockResolvedValue(undefined)

    execPodStepWithOutputSpy = jest
      .spyOn(k8sModule, 'execPodStepWithOutput')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['RUNNER_WORKSPACE']
    delete process.env['RUNNER_TEMP']
  })

  it('completes without throwing when script exits 0', async () => {
    execPodStepWithOutputSpy.mockResolvedValue({ code: 0, output: '' })
    await expect(runScriptStep(makeArgs(), state)).resolves.toBeUndefined()
  })

  it('throws structured error on non-zero exit with last output', async () => {
    execPodStepWithOutputSpy.mockResolvedValue({
      code: 154,
      output: 'line one\nline two\nexit line'
    })
    await expect(runScriptStep(makeArgs(), state)).rejects.toThrow(
      /failed to run script step/
    )
    await expect(runScriptStep(makeArgs(), state)).rejects.toThrow(
      /exit code: 154/
    )
  })

  it('includes last output in error message', async () => {
    execPodStepWithOutputSpy.mockResolvedValue({
      code: 1,
      output: 'script output line'
    })
    let caughtErr: Error | undefined
    try {
      await runScriptStep(makeArgs(), state)
    } catch (e) {
      caughtErr = e as Error
    }
    expect(caughtErr).toBeDefined()
    expect(caughtErr?.message).toContain('script output line')
    expect(caughtErr?.message).toContain('Last output:')
    expect(caughtErr?.message).toContain('─')
  })

  it('throws generic error when execPodStepWithOutput rejects with non-exit error', async () => {
    execPodStepWithOutputSpy.mockRejectedValue(
      new Error('websocket connection dropped')
    )
    await expect(runScriptStep(makeArgs(), state)).rejects.toThrow(
      /failed to run script step.*websocket connection dropped/
    )
  })
})
