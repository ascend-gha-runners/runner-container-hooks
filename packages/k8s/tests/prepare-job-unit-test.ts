/**
 * Pure unit tests for prepare-job.ts — no k8s cluster required.
 * All k8s API calls are mocked.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as k8s from '@kubernetes/client-node'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

import * as k8sModule from '../src/k8s'
import { createContainerSpec, prepareJob } from '../src/hooks/prepare-job'
import { JOB_CONTAINER_NAME } from '../src/hooks/constants'
import { CONTAINER_VOLUMES } from '../src/k8s/utils'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `prepare-job-unit-${Date.now()}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function makeMinimalArgs() {
  return {
    container: {
      image: 'ubuntu:latest',
      entryPoint: 'sh',
      entryPointArgs: ['-c', 'sleep 1'],
      environmentVariables: {},
      portMappings: [],
      userMountVolumes: []
    },
    services: []
  }
}

// ── createContainerSpec ───────────────────────────────────────────────────────

describe('createContainerSpec', () => {
  it('sets image and name', () => {
    const c = createContainerSpec(
      { image: 'node:22', entryPoint: 'node' } as any,
      'my-container'
    )
    expect(c.image).toBe('node:22')
    expect(c.name).toBe('my-container')
  })

  it('sets default entryPoint for job containers when none given', () => {
    const c = createContainerSpec(
      { image: 'ubuntu:latest' } as any,
      JOB_CONTAINER_NAME,
      true
    )
    expect(c.command).toEqual(['tail'])
    expect(c.args).toEqual(['-f', '/dev/null'])
  })

  it('does NOT set default entryPoint for service containers', () => {
    const c = createContainerSpec(
      { image: 'redis:latest' } as any,
      'redis',
      false
    )
    expect(c.command).toBeUndefined()
    expect(c.args).toBeUndefined()
  })

  it('sets command and args when entryPoint/entryPointArgs given', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        entryPoint: 'sh',
        entryPointArgs: ['-c', 'echo hi']
      } as any,
      'my-container'
    )
    expect(c.command).toEqual(['sh'])
    // fixArgs preserves 'sh -c' scripts as a single arg
    expect(c.args).toEqual(expect.arrayContaining(['-c']))
  })

  it('sets workingDir from workingDirectory', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        workingDirectory: '/app',
        entryPoint: 'sh'
      } as any,
      'my-container'
    )
    expect(c.workingDir).toBe('/app')
  })

  it('injects GITHUB_ACTIONS=true env', () => {
    const c = createContainerSpec(
      { image: 'ubuntu:latest', entryPoint: 'sh' } as any,
      'c'
    )
    expect(c.env).toEqual(
      expect.arrayContaining([{ name: 'GITHUB_ACTIONS', value: 'true' }])
    )
  })

  it('injects CI=true when not set', () => {
    const c = createContainerSpec(
      { image: 'ubuntu:latest', entryPoint: 'sh' } as any,
      'c'
    )
    expect(c.env).toEqual(
      expect.arrayContaining([{ name: 'CI', value: 'true' }])
    )
  })

  it('does NOT inject CI when already set in environmentVariables', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        entryPoint: 'sh',
        environmentVariables: { CI: 'false' }
      } as any,
      'c'
    )
    const ciEntries = (c.env || []).filter(e => e.name === 'CI')
    expect(ciEntries).toHaveLength(1)
    expect(ciEntries[0].value).toBe('false')
  })

  it('skips HOME from environmentVariables', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        entryPoint: 'sh',
        environmentVariables: { HOME: '/root', FOO: 'bar' }
      } as any,
      'c'
    )
    expect((c.env || []).some(e => e.name === 'HOME')).toBe(false)
    expect((c.env || []).some(e => e.name === 'FOO')).toBe(true)
  })

  it('attaches CONTAINER_VOLUMES as volumeMounts', () => {
    const c = createContainerSpec(
      { image: 'ubuntu:latest', entryPoint: 'sh' } as any,
      'c'
    )
    expect(c.volumeMounts).toEqual(CONTAINER_VOLUMES)
  })

  it('applies extension overrides via mergeContainerWithOptions', () => {
    const extension: k8s.V1PodTemplateSpec = {
      spec: {
        containers: [
          {
            name: '$c',
            resources: { requests: { cpu: '500m' } }
          } as k8s.V1Container
        ]
      }
    }
    const c = createContainerSpec(
      { image: 'ubuntu:latest', entryPoint: 'sh' } as any,
      'c',
      false,
      extension
    )
    expect(c.resources?.requests?.cpu).toBe('500m')
  })
})

// ── prepareJob error paths ────────────────────────────────────────────────────

describe('prepareJob error paths', () => {
  let tmpDir: string
  let responseFile: string
  let prunePodsSpy: jest.SpyInstance
  let createJobPodSpy: jest.SpyInstance
  let waitForPodPhasesSpy: jest.SpyInstance
  let isPodContainerAlpineSpy: jest.SpyInstance

  beforeEach(() => {
    tmpDir = makeTmpDir()
    responseFile = path.join(tmpDir, 'response.json')
    // writeToResponseFile requires the file to already exist
    fs.writeFileSync(responseFile, '')
    process.env.RUNNER_WORKSPACE = path.join(tmpDir, 'runner/_work/repo')
    process.env.RUNNER_TEMP = path.join(tmpDir, 'tmp')
    process.env.GITHUB_WORKSPACE = path.join(tmpDir, 'runner/_work/repo/repo')
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    fs.mkdirSync(process.env.RUNNER_TEMP, { recursive: true })
    fs.mkdirSync(path.dirname(process.env.RUNNER_WORKSPACE), {
      recursive: true
    })

    prunePodsSpy = jest
      .spyOn(k8sModule, 'prunePods')
      .mockResolvedValue(undefined)
    createJobPodSpy = jest.spyOn(k8sModule, 'createJobPod').mockResolvedValue({
      metadata: { name: 'job-pod-xyz' }
    } as k8s.V1Pod)
    waitForPodPhasesSpy = jest
      .spyOn(k8sModule, 'waitForPodPhases')
      .mockResolvedValue(undefined)
    isPodContainerAlpineSpy = jest
      .spyOn(k8sModule, 'isPodContainerAlpine')
      .mockResolvedValue(false)
    jest.spyOn(k8sModule, 'execCpToPod').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.RUNNER_WORKSPACE
    delete process.env.RUNNER_TEMP
    delete process.env.GITHUB_WORKSPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
  })

  it('throws when container is missing', async () => {
    const args = makeMinimalArgs()
    args.container = undefined as any
    await expect(prepareJob(args as any, responseFile)).rejects.toThrow(
      'Job Container is required'
    )
  })

  it('throws when no container image and no services', async () => {
    const args = makeMinimalArgs()
    args.container = { image: '' } as any
    args.services = []
    await expect(prepareJob(args as any, responseFile)).rejects.toThrow()
  })

  it('throws with structured message when createJobPod fails with k8s error', async () => {
    const k8sError = new Error(
      'HTTP-Code: 422\nMessage: Unprocessable\nBody: "{\\"kind\\":\\"Status\\",\\"message\\":\\"spec.volumes[0].name: Duplicate value\\"}"' +
        '\nHeaders: {}'
    )
    createJobPodSpy.mockRejectedValue(k8sError)

    await expect(
      prepareJob(makeMinimalArgs() as any, responseFile)
    ).rejects.toThrow('failed to create job pod')
    expect(prunePodsSpy).toHaveBeenCalledTimes(2) // initial prune + error prune
  })

  it('throws wrapped error when createJobPod fails with generic error', async () => {
    createJobPodSpy.mockRejectedValue(new Error('network timeout'))
    await expect(
      prepareJob(makeMinimalArgs() as any, responseFile)
    ).rejects.toThrow('failed to create job pod')
  })

  it('throws pod failed message when waitForPodPhases rejects', async () => {
    waitForPodPhasesSpy.mockRejectedValue(new Error('pod stuck in Pending'))
    await expect(
      prepareJob(makeMinimalArgs() as any, responseFile)
    ).rejects.toThrow('pod failed to come online')
    expect(prunePodsSpy).toHaveBeenCalledTimes(2) // initial + cleanup
  })

  it('throws when isPodContainerAlpine rejects', async () => {
    isPodContainerAlpineSpy.mockRejectedValue(new Error('exec failed'))
    await expect(
      prepareJob(makeMinimalArgs() as any, responseFile)
    ).rejects.toThrow('failed to determine if the pod is alpine')
  })

  it('throws when RUNNER_WORKSPACE is not set', async () => {
    delete process.env.RUNNER_WORKSPACE
    await expect(
      prepareJob(makeMinimalArgs() as any, responseFile)
    ).rejects.toThrow('RUNNER_WORKSPACE')
  })

  it('writes response file on success', async () => {
    await prepareJob(makeMinimalArgs() as any, responseFile)
    expect(fs.existsSync(responseFile)).toBe(true)
    const content = JSON.parse(fs.readFileSync(responseFile, 'utf8'))
    expect(content.state.jobPod).toBe('job-pod-xyz')
    expect(content.isAlpine).toBe(false)
  })

  it('sets isAlpine=true in response when alpine detected', async () => {
    isPodContainerAlpineSpy.mockResolvedValue(true)
    await prepareJob(makeMinimalArgs() as any, responseFile)
    const content = JSON.parse(fs.readFileSync(responseFile, 'utf8'))
    expect(content.isAlpine).toBe(true)
  })

  it('deduplicates service names when images collide', async () => {
    const args = makeMinimalArgs() as any
    args.services = [
      { image: 'redis:latest', portMappings: [], environmentVariables: {} },
      { image: 'redis:latest', portMappings: [], environmentVariables: {} }
    ]
    createJobPodSpy.mockImplementation(async (_name, _container, services) => {
      // Return a pod with the service containers echoed back
      return Promise.resolve({
        metadata: { name: 'job-pod-xyz' },
        spec: {
          containers: [
            { name: JOB_CONTAINER_NAME, image: 'ubuntu:latest', ports: [] },
            ...(services || []).map((s: k8s.V1Container) => ({
              name: s.name,
              image: s.image,
              ports: []
            }))
          ]
        }
      } as k8s.V1Pod)
    })

    await prepareJob(args, responseFile)
    const content = JSON.parse(fs.readFileSync(responseFile, 'utf8'))
    // Two services with colliding names → redis-0, redis-1
    expect(content.context.services).toHaveLength(2)
  })
})
