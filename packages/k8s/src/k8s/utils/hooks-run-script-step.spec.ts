import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('../index', () => ({
  execPodStep: vi.fn().mockResolvedValue(0),
  execCpToPod: vi.fn().mockResolvedValue(undefined),
  execCpFromPod: vi.fn().mockResolvedValue(undefined),
  execPodStepWithOutput: vi.fn().mockResolvedValue({ code: 0, output: '' })
}))

import { runScriptStep } from '../../hooks/run-script-step'
import * as k8sMod from '../index'

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `rss-spec-${Date.now()}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    entryPoint: 'sh',
    entryPointArgs: ['-c', 'echo hi'],
    environmentVariables: { VAR: 'val' },
    workingDirectory: '/__w',
    prependPath: [],
    ...overrides
  }
}

describe('runScriptStep', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    process.env.RUNNER_TEMP = tmpDir
    process.env.RUNNER_WORKSPACE = '/__w/repo'
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    vi.mocked(k8sMod.execPodStep).mockResolvedValue(0)
    vi.mocked(k8sMod.execCpToPod).mockResolvedValue(undefined)
    vi.mocked(k8sMod.execCpFromPod).mockResolvedValue(undefined)
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 0,
      output: ''
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.RUNNER_TEMP
    delete process.env.RUNNER_WORKSPACE
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    vi.clearAllMocks()
  })

  it('throws when jobPod is null', async () => {
    await expect(
      runScriptStep(makeArgs() as any, { jobPod: null })
    ).rejects.toThrow('jobPod must be set')
  })

  it('throws when jobPod is undefined', async () => {
    await expect(runScriptStep(makeArgs() as any, {})).rejects.toThrow(
      'jobPod must be set'
    )
  })

  it('completes without throwing when script exits 0', async () => {
    await expect(
      runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    ).resolves.toBeUndefined()
    expect(k8sMod.execPodStepWithOutput).toHaveBeenCalled()
  })

  it('throws structured error on non-zero exit', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: 'script output line'
    })
    await expect(
      runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    ).rejects.toThrow('failed to run script step')
  })

  it('includes last output and separator in error message', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockResolvedValue({
      code: 1,
      output: 'my error output'
    })
    let err: Error | undefined
    try {
      await runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain('my error output')
    expect(err?.message).toContain('Last output:')
    expect(err?.message).toContain('---')
  })

  it('throws generic error when execPodStepWithOutput rejects', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockRejectedValue(
      new Error('websocket dropped')
    )
    await expect(
      runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    ).rejects.toThrow('failed to run script step')
  })

  it('re-throws already-classified errors verbatim', async () => {
    vi.mocked(k8sMod.execPodStepWithOutput).mockRejectedValue(
      new Error('failed to run script step: OOMKilled')
    )
    let err: Error | undefined
    try {
      await runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toBe('failed to run script step: OOMKilled')
  })

  it('swallows execPodStep (GitHub dir setup) failure without throwing', async () => {
    // The GitHub-dir copy step is best-effort: a failure is logged via
    // core.debug and must not fail the run.
    vi.mocked(k8sMod.execPodStep).mockRejectedValueOnce(
      new Error('mkdir failed')
    )
    await expect(
      runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    ).resolves.toBeUndefined()
  })

  it('copies files from pod after success', async () => {
    await runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    expect(k8sMod.execCpFromPod).toHaveBeenCalled()
  })

  // Covers run-script-step.ts line 145: catch block when copying temp dir fails
  it('warns when copying _runner_file_commands fails', async () => {
    const core = await import('@actions/core')
    const warnSpy = vi.spyOn(core, 'warning')
    vi.mocked(k8sMod.execCpFromPod).mockRejectedValueOnce(
      new Error('cp failed')
    )
    // Should NOT throw — the error is swallowed with a warning
    await expect(
      runScriptStep(makeArgs() as any, { jobPod: 'job-pod' })
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith('Failed to copy _temp from pod')
  })
})
