/**
 * Pure unit tests for run-container-step.ts — no k8s cluster required.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as k8s from '@kubernetes/client-node'
import * as core from '@actions/core'
import { RunContainerStepArgs } from 'hooklib'
import { runContainerStep } from '../src/hooks/run-container-step'
import * as k8sModule from '../src/k8s'
import * as utils from '../src/k8s/utils'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `rcs-unit-${Date.now()}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function makeArgs(
  overrides: Partial<RunContainerStepArgs> = {}
): RunContainerStepArgs {
  return {
    image: 'ubuntu:latest',
    entryPoint: 'sh',
    entryPointArgs: ['-c', 'echo hi'],
    environmentVariables: {},
    ...overrides
  } as RunContainerStepArgs
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runContainerStep — argument validation', () => {
  it('throws when dockerfile is set (not supported)', async () => {
    await expect(
      runContainerStep(makeArgs({ dockerfile: 'Dockerfile' } as any))
    ).rejects.toThrow('Building container actions is not currently supported')
  })

  it('throws when entryPoint is missing', async () => {
    await expect(
      runContainerStep(makeArgs({ entryPoint: '' }))
    ).rejects.toThrow(
      'failed to start the container since the entrypoint is overwritten'
    )
  })
})

describe('runContainerStep — createContainerStepPod failure', () => {
  let tmpDir: string
  let createStepPodSpy: jest.SpyInstance

  beforeEach(() => {
    tmpDir = makeTmpDir()
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    process.env.RUNNER_WORKSPACE = path.join(tmpDir, 'runner/_work/repo')
    process.env.GITHUB_WORKSPACE = path.join(tmpDir, 'runner/_work/repo/repo')
    process.env.RUNNER_TEMP = path.join(tmpDir, 'tmp')
    fs.mkdirSync(process.env.RUNNER_TEMP, { recursive: true })
    fs.mkdirSync(path.dirname(process.env.RUNNER_WORKSPACE), {
      recursive: true
    })

    createStepPodSpy = jest
      .spyOn(k8sModule, 'createContainerStepPod')
      .mockRejectedValue(new Error('pod quota exceeded'))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.RUNNER_WORKSPACE
    delete process.env.GITHUB_WORKSPACE
    delete process.env.RUNNER_TEMP
  })

  it('wraps createContainerStepPod error', async () => {
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run container step: pod quota exceeded'
    )
  })

  it('wraps k8s body message when available', async () => {
    createStepPodSpy.mockRejectedValue({
      response: { body: { message: 'namespace limit reached' } }
    })
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run container step: namespace limit reached'
    )
  })
})

describe('runContainerStep — pod missing metadata.name', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    process.env.RUNNER_WORKSPACE = path.join(tmpDir, 'runner/_work/repo')
    process.env.GITHUB_WORKSPACE = path.join(tmpDir, 'runner/_work/repo/repo')
    process.env.RUNNER_TEMP = path.join(tmpDir, 'tmp')
    fs.mkdirSync(process.env.RUNNER_TEMP, { recursive: true })
    fs.mkdirSync(path.dirname(process.env.RUNNER_WORKSPACE), {
      recursive: true
    })

    jest
      .spyOn(k8sModule, 'createContainerStepPod')
      .mockResolvedValue({} as k8s.V1Pod)
    jest.spyOn(k8sModule, 'deletePod').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.RUNNER_WORKSPACE
    delete process.env.GITHUB_WORKSPACE
    delete process.env.RUNNER_TEMP
  })

  it('throws when pod has no metadata.name', async () => {
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'to have correctly set the metadata.name'
    )
  })
})

describe('runContainerStep — script execution paths', () => {
  let tmpDir: string
  let execPodStepWithOutputSpy: jest.SpyInstance
  let getPodByNameSpy: jest.SpyInstance
  let getContainerTerminatedErrorsSpy: jest.SpyInstance
  let describePodFailureSpy: jest.SpyInstance
  let deletePodSpy: jest.SpyInstance

  beforeEach(() => {
    tmpDir = makeTmpDir()
    const runnerTemp = path.join(tmpDir, 'tmp')
    fs.mkdirSync(runnerTemp, { recursive: true })
    // Use forward-slash paths so the '/__w/repo/repo'.split('/') logic works on Windows
    const runnerWork = '/__w/repo'
    const githubWork = '/__w/repo/repo'

    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    process.env.RUNNER_WORKSPACE = runnerWork
    process.env.GITHUB_WORKSPACE = githubWork
    process.env.RUNNER_TEMP = runnerTemp

    jest.spyOn(k8sModule, 'createContainerStepPod').mockResolvedValue({
      metadata: { name: 'step-pod-abc' }
    } as k8s.V1Pod)

    jest.spyOn(k8sModule, 'waitForPodPhases').mockResolvedValue(undefined)
    jest.spyOn(k8sModule, 'execCpFromPod').mockResolvedValue(undefined)
    jest.spyOn(k8sModule, 'execCpToPod').mockResolvedValue(undefined)
    // createTempDir for /__w/_temp
    const wDir = path.join(tmpDir, 'runner/__w/_temp')
    fs.mkdirSync(wDir, { recursive: true })

    // Mock writeContainerStepScript so no real FS write to /__w/...
    jest.spyOn(utils, 'writeContainerStepScript').mockReturnValue({
      containerPath: '/__w/_temp/script.sh',
      runnerPath: path.join(tmpDir, 'script.sh')
    })

    execPodStepWithOutputSpy = jest
      .spyOn(k8sModule, 'execPodStepWithOutput')
      .mockResolvedValue({ code: 0, output: '' })

    getPodByNameSpy = jest.spyOn(k8sModule, 'getPodByName').mockResolvedValue({
      metadata: { name: 'step-pod-abc' },
      status: {}
    } as k8s.V1Pod)

    getContainerTerminatedErrorsSpy = jest
      .spyOn(k8sModule, 'getContainerTerminatedErrors')
      .mockReturnValue([])

    describePodFailureSpy = jest
      .spyOn(k8sModule, 'describePodFailure')
      .mockResolvedValue('pod details')

    deletePodSpy = jest
      .spyOn(k8sModule, 'deletePod')
      .mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.RUNNER_WORKSPACE
    delete process.env.GITHUB_WORKSPACE
    delete process.env.RUNNER_TEMP
  })

  it('returns 0 on success', async () => {
    const result = await runContainerStep(makeArgs())
    expect(result).toBe(0)
    expect(deletePodSpy).toHaveBeenCalledWith('step-pod-abc')
  })

  it('re-throws classified errors verbatim (Step failed: prefix)', async () => {
    execPodStepWithOutputSpy.mockResolvedValue({
      code: 1,
      output: 'bad output'
    })
    getPodByNameSpy.mockResolvedValue({
      metadata: { name: 'step-pod-abc' },
      status: {
        containerStatuses: [
          {
            name: 'job',
            state: { terminated: { reason: 'Completed', exitCode: 1 } }
          }
        ]
      }
    } as any)

    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
    expect(deletePodSpy).toHaveBeenCalled()
  })

  it('deletes pod on failure', async () => {
    execPodStepWithOutputSpy.mockRejectedValue(new Error('websocket dropped'))
    await expect(runContainerStep(makeArgs())).rejects.toThrow()
    expect(deletePodSpy).toHaveBeenCalledWith('step-pod-abc')
  })

  it('throws when RUNNER_WORKSPACE env not set', async () => {
    delete process.env.RUNNER_WORKSPACE
    // writeContainerStepScript is called before the workspace check in some paths —
    // either way the pod should be deleted and an error thrown
    await expect(runContainerStep(makeArgs())).rejects.toThrow()
    expect(deletePodSpy).toHaveBeenCalled()
  })

  it('injects GITHUB_ACTIONS and CI into envs', async () => {
    const args = makeArgs({ environmentVariables: {} })
    await runContainerStep(args)
    // env injection happens before pod creation — check envs on the args object
    expect(args.environmentVariables?.['GITHUB_ACTIONS']).toBe('true')
    expect(args.environmentVariables?.['CI']).toBe('true')
  })

  it('does not overwrite existing CI env', async () => {
    const args = makeArgs({ environmentVariables: { CI: 'false' } })
    await runContainerStep(args)
    expect(args.environmentVariables?.['CI']).toBe('false')
  })
})
