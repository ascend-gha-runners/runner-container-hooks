import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as k8s from '@kubernetes/client-node'
import { RunContainerStepArgs } from 'hooklib'

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('../index', () => ({
  createContainerStepPod: vi.fn(),
  deletePod: vi.fn().mockResolvedValue(undefined),
  describePodFailure: vi.fn().mockResolvedValue(''),
  execCpFromPod: vi.fn().mockResolvedValue(undefined),
  execCpToPod: vi.fn().mockResolvedValue(undefined),
  execPodStepWithOutput: vi.fn().mockResolvedValue({ code: 0, output: '' }),
  getContainerTerminatedErrors: vi.fn().mockReturnValue([]),
  getPodByName: vi.fn(),
  getPrepareJobTimeoutSeconds: vi.fn().mockReturnValue(60),
  getTerminatedReasonHint: vi.fn().mockReturnValue('  → hint'),
  waitForPodPhases: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./index', async importOriginal => {
  const real = await importOriginal<typeof import('./index')>()
  return {
    ...real,
    writeContainerStepScript: vi.fn().mockReturnValue({
      containerPath: '/__w/_temp/script.sh',
      runnerPath: '/tmp/script.sh'
    })
  }
})

import { runContainerStep } from '../../hooks/run-container-step'
import * as k8sMod from '../index'

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `rcs-spec-${Date.now()}`)
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

function makePod(
  name = 'step-pod',
  containerStatuses?: k8s.V1ContainerStatus[]
): k8s.V1Pod {
  return {
    metadata: { name },
    status: { containerStatuses }
  } as k8s.V1Pod
}

describe('runContainerStep — argument validation', () => {
  it('throws when dockerfile is set', async () => {
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
  beforeEach(() => {
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
  })
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
  })

  it('wraps error with failed to run container step', async () => {
    vi.mocked(k8sMod.createContainerStepPod).mockRejectedValue(
      new Error('quota exceeded')
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run container step: quota exceeded'
    )
  })

  it('extracts k8s body message when available', async () => {
    vi.mocked(k8sMod.createContainerStepPod).mockRejectedValue({
      response: { body: { message: 'limit reached' } }
    })
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run container step: limit reached'
    )
  })
})

describe('runContainerStep — pod missing metadata.name', () => {
  beforeEach(() => {
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    vi.mocked(k8sMod.createContainerStepPod).mockResolvedValue({} as k8s.V1Pod)
  })
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
  })

  it('throws when pod has no metadata.name', async () => {
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'to have correctly set the metadata.name'
    )
  })
})

describe('runContainerStep — execution paths', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    process.env.RUNNER_WORKSPACE = '/__w/repo'
    process.env.GITHUB_WORKSPACE = '/__w/repo/repo'
    process.env.RUNNER_TEMP = tmpDir
    vi.mocked(k8sMod.createContainerStepPod).mockResolvedValue(makePod())
    vi.mocked(k8sMod.waitForPodPhases).mockResolvedValue(undefined)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 0,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(makePod())
    vi.mocked(k8sMod.getContainerTerminatedErrors).mockReturnValue([])
    vi.mocked(k8sMod.describePodFailure).mockResolvedValue('')
  })

  afterEach(() => {
    vi.clearAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.RUNNER_WORKSPACE
    delete process.env.GITHUB_WORKSPACE
    delete process.env.RUNNER_TEMP
  })

  it('returns 0 on success', async () => {
    expect(await runContainerStep(makeArgs())).toBe(0)
    expect(k8sMod.deletePod).toHaveBeenCalledWith('step-pod')
  })

  it('deletes pod even on failure', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockRejectedValue(
      new Error('crash')
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow()
    expect(k8sMod.deletePod).toHaveBeenCalledWith('step-pod')
  })

  it('re-throws classified error verbatim (failed to run script step prefix)', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(
      makePod('step-pod', [
        {
          name: 'job',
          state: { terminated: { reason: 'Completed', exitCode: 1 } }
        } as k8s.V1ContainerStatus
      ])
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
  })

  it('wraps k8s exec errors with failed to run container step', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockRejectedValue(
      new Error('websocket error')
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run container step'
    )
  })

  it('classifies OOMKilled as container fault', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 137,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(
      makePod('step-pod', [
        {
          name: 'job',
          state: { terminated: { reason: 'OOMKilled', exitCode: 137 } }
        } as k8s.V1ContainerStatus
      ])
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
  })

  it('injects GITHUB_ACTIONS and CI into envs', async () => {
    const args = makeArgs({ environmentVariables: {} })
    await runContainerStep(args)
    expect(args.environmentVariables?.['GITHUB_ACTIONS']).toBe('true')
    expect(args.environmentVariables?.['CI']).toBe('true')
  })

  it('does not overwrite existing CI env', async () => {
    const args = makeArgs({ environmentVariables: { CI: 'false' } })
    await runContainerStep(args)
    expect(args.environmentVariables?.['CI']).toBe('false')
  })

  it('throws when RUNNER_WORKSPACE is not set', async () => {
    delete process.env.RUNNER_WORKSPACE
    await expect(runContainerStep(makeArgs())).rejects.toThrow()
    expect(k8sMod.deletePod).toHaveBeenCalled()
  })

  it('logs terminated errors via describePodFailure', async () => {
    vi.mocked(k8sMod.waitForPodPhases).mockRejectedValue(
      new Error('pod failed')
    )
    vi.mocked(k8sMod.getContainerTerminatedErrors).mockReturnValue([
      '  ✗ OOMKilled'
    ])
    vi.mocked(k8sMod.describePodFailure).mockResolvedValue('pod details')
    await expect(runContainerStep(makeArgs())).rejects.toThrow()
    expect(k8sMod.describePodFailure).toHaveBeenCalledWith('step-pod')
  })

  it('throws when GITHUB_WORKSPACE has fewer than 2 path segments', async () => {
    // Covers run-container-step.ts lines 95-96 (invalid github workspace)
    // split('/').slice(-2) needs exactly 2 parts; 'noSlash' → ['noSlash'] → length 1
    process.env.GITHUB_WORKSPACE = 'noSlash'
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      /Invalid github workspace directory/
    )
    delete process.env.GITHUB_WORKSPACE
  })

  it('classifies script error with terminated state and completed reason', async () => {
    // Covers run-container-step.ts line 163 (reason === 'Completed' branch)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(
      makePod('step-pod', [
        {
          name: 'job',
          state: { terminated: { reason: 'Completed', exitCode: 1 } }
        } as k8s.V1ContainerStatus
      ])
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
  })

  it('classifies script error when containerStatuses is missing', async () => {
    // Covers run-container-step.ts line 168 (state unavailable branch)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(makePod('step-pod', []))
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
  })

  it('classifies script error when pod fetch throws', async () => {
    // Covers run-container-step.ts lines 217-218, 220-223 (catch fallback)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockRejectedValue(new Error('pod gone'))
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
  })

  it('classifies script error when container is in waiting state', async () => {
    // Covers run-container-step.ts lines 226-227 (waiting state branch)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: ''
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(
      makePod('step-pod', [
        {
          name: 'job',
          state: { waiting: { reason: 'ImagePullBackOff' } }
        } as k8s.V1ContainerStatus
      ])
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(
      'failed to run script step'
    )
  })

  it('includes tail output in classify error when output is present', async () => {
    // Covers run-container-step.ts lines 230-234 (tailOutput branch)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: 'Error: something went wrong\n  at line 42'
    })
    vi.mocked(k8sMod.getPodByName).mockResolvedValue(
      makePod('step-pod', [
        {
          name: 'job',
          state: { terminated: { reason: 'Completed', exitCode: 1 } }
        } as k8s.V1ContainerStatus
      ])
    )
    await expect(runContainerStep(makeArgs())).rejects.toThrow(/Last output:/)
  })
})
