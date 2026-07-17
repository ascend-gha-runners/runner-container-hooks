import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as k8s from '@kubernetes/client-node'

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('../index', () => ({
  containerPorts: vi.fn().mockReturnValue([]),
  createJobPod: vi.fn(),
  execCpToPod: vi.fn().mockResolvedValue(undefined),
  execPodStep: vi.fn().mockResolvedValue(0),
  isPodContainerAlpine: vi.fn().mockResolvedValue(false),
  prunePods: vi.fn().mockResolvedValue(undefined),
  waitForPodPhases: vi.fn().mockResolvedValue(undefined),
  getPrepareJobTimeoutSeconds: vi.fn().mockReturnValue(60)
}))

import { createContainerSpec, prepareJob } from '../../hooks/prepare-job'
import * as k8sMod from '../index'
import { JOB_CONTAINER_NAME } from '../../hooks/constants'
import { CONTAINER_VOLUMES } from './index'

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `pj-spec-${Date.now()}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    container: {
      image: 'ubuntu:latest',
      entryPoint: 'sh',
      entryPointArgs: ['-c', 'sleep 1'],
      environmentVariables: {},
      portMappings: [],
      userMountVolumes: []
    },
    services: [],
    ...overrides
  }
}

function makePod(name = 'job-pod'): k8s.V1Pod {
  return {
    metadata: { name },
    spec: {
      containers: [
        { name: JOB_CONTAINER_NAME, image: 'ubuntu:latest', ports: [] }
      ]
    },
    status: {}
  } as k8s.V1Pod
}

// ── createContainerSpec ────────────────────────────────────────────────────────

describe('createContainerSpec', () => {
  it('sets image and name', () => {
    const c = createContainerSpec(
      { image: 'node:22', entryPoint: 'node' } as any,
      'c'
    )
    expect(c.image).toBe('node:22')
    expect(c.name).toBe('c')
  })

  it('sets default entryPoint for job container when none given', () => {
    const c = createContainerSpec(
      { image: 'ubuntu:latest' } as any,
      JOB_CONTAINER_NAME,
      true
    )
    expect(c.command).toEqual(['tail'])
    expect(c.args).toEqual(['-f', '/dev/null'])
  })

  it('does not set default entryPoint for service container', () => {
    const c = createContainerSpec(
      { image: 'redis:latest' } as any,
      'redis',
      false
    )
    expect(c.command).toBeUndefined()
    expect(c.args).toBeUndefined()
  })

  it('sets command and args when entryPoint given', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        entryPoint: 'sh',
        entryPointArgs: ['--']
      } as any,
      'c'
    )
    expect(c.command).toEqual(['sh'])
    expect(c.args).toBeDefined()
  })

  it('sets workingDir', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        workingDirectory: '/app',
        entryPoint: 'sh'
      } as any,
      'c'
    )
    expect(c.workingDir).toBe('/app')
  })

  it('injects GITHUB_ACTIONS=true', () => {
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

  it('preserves existing CI env', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        entryPoint: 'sh',
        environmentVariables: { CI: 'false' }
      } as any,
      'c'
    )
    const ci = (c.env || []).filter(e => e.name === 'CI')
    expect(ci).toHaveLength(1)
    expect(ci[0].value).toBe('false')
  })

  it('skips HOME env var', () => {
    const c = createContainerSpec(
      {
        image: 'ubuntu:latest',
        entryPoint: 'sh',
        environmentVariables: { HOME: '/root' }
      } as any,
      'c'
    )
    expect((c.env || []).some(e => e.name === 'HOME')).toBe(false)
  })

  it('attaches CONTAINER_VOLUMES as volumeMounts', () => {
    const c = createContainerSpec(
      { image: 'ubuntu:latest', entryPoint: 'sh' } as any,
      'c'
    )
    expect(c.volumeMounts).toEqual(CONTAINER_VOLUMES)
  })

  it('applies extension overrides', () => {
    const ext: k8s.V1PodTemplateSpec = {
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
      ext
    )
    expect(c.resources?.requests?.cpu).toBe('500m')
  })
})

// ── prepareJob ────────────────────────────────────────────────────────────────

describe('prepareJob', () => {
  let tmpDir: string
  let responseFile: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    responseFile = path.join(tmpDir, 'response.json')
    fs.writeFileSync(responseFile, '')
    process.env.RUNNER_WORKSPACE = '/__w/repo'
    process.env.RUNNER_TEMP = tmpDir
    process.env.GITHUB_WORKSPACE = '/__w/repo/repo'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-pod'
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'default'
    vi.mocked(k8sMod.createJobPod).mockResolvedValue(makePod())
    vi.mocked(k8sMod.waitForPodPhases).mockResolvedValue(undefined)
    vi.mocked(k8sMod.isPodContainerAlpine).mockResolvedValue(false)
    vi.mocked(k8sMod.execCpToPod).mockResolvedValue(undefined)
    vi.mocked(k8sMod.prunePods).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.RUNNER_WORKSPACE
    delete process.env.RUNNER_TEMP
    delete process.env.GITHUB_WORKSPACE
    delete process.env.ACTIONS_RUNNER_POD_NAME
    delete process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE
  })

  it('throws when container is missing', async () => {
    const args = makeArgs()
    ;(args as any).container = undefined
    await expect(prepareJob(args as any, responseFile)).rejects.toThrow(
      'Job Container is required'
    )
  })

  it('throws when no container image and no services', async () => {
    const args = makeArgs()
    ;(args as any).container = { image: '' }
    args.services = []
    await expect(prepareJob(args as any, responseFile)).rejects.toThrow()
  })

  it('throws with structured message when createJobPod fails', async () => {
    vi.mocked(k8sMod.createJobPod).mockRejectedValue(
      new Error(
        'HTTP-Code: 422\nMessage: Unprocessable\nBody: "{\\"kind\\":\\"Status\\",\\"message\\":\\"Duplicate value\\"}"' +
          '\nHeaders: {}'
      )
    )
    await expect(prepareJob(makeArgs() as any, responseFile)).rejects.toThrow(
      'failed to create job pod'
    )
    expect(k8sMod.prunePods).toHaveBeenCalledTimes(2)
  })

  it('throws when createJobPod fails with generic error', async () => {
    vi.mocked(k8sMod.createJobPod).mockRejectedValue(new Error('timeout'))
    await expect(prepareJob(makeArgs() as any, responseFile)).rejects.toThrow(
      'failed to create job pod'
    )
  })

  it('throws pod failed message when waitForPodPhases rejects', async () => {
    vi.mocked(k8sMod.waitForPodPhases).mockRejectedValue(new Error('pod stuck'))
    await expect(prepareJob(makeArgs() as any, responseFile)).rejects.toThrow(
      'pod failed to come online'
    )
    expect(k8sMod.prunePods).toHaveBeenCalledTimes(2)
  })

  it('throws when RUNNER_WORKSPACE is not set', async () => {
    delete process.env.RUNNER_WORKSPACE
    await expect(prepareJob(makeArgs() as any, responseFile)).rejects.toThrow(
      'RUNNER_WORKSPACE'
    )
  })

  it('throws when isPodContainerAlpine rejects', async () => {
    vi.mocked(k8sMod.isPodContainerAlpine).mockRejectedValue(
      new Error('exec failed')
    )
    await expect(prepareJob(makeArgs() as any, responseFile)).rejects.toThrow(
      'failed to determine if the pod is alpine'
    )
  })

  it('writes response file with jobPod and isAlpine=false on success', async () => {
    await prepareJob(makeArgs() as any, responseFile)
    const content = JSON.parse(fs.readFileSync(responseFile, 'utf8'))
    expect(content.state.jobPod).toBe('job-pod')
    expect(content.isAlpine).toBe(false)
  })

  it('sets isAlpine=true when alpine detected', async () => {
    vi.mocked(k8sMod.isPodContainerAlpine).mockResolvedValue(true)
    await prepareJob(makeArgs() as any, responseFile)
    const content = JSON.parse(fs.readFileSync(responseFile, 'utf8'))
    expect(content.isAlpine).toBe(true)
  })

  it('deduplicates colliding service names', async () => {
    const args = makeArgs() as any
    args.services = [
      { image: 'redis:latest', portMappings: [], environmentVariables: {} },
      { image: 'redis:latest', portMappings: [], environmentVariables: {} }
    ]
    vi.mocked(k8sMod.createJobPod).mockImplementation(
      (_name, _container, services) =>
        Promise.resolve({
          metadata: { name: 'job-pod' },
          spec: {
            containers: [
              { name: JOB_CONTAINER_NAME, image: 'ubuntu:latest', ports: [] },
              ...((services || []) as k8s.V1Container[]).map(s => ({
                name: s.name,
                image: s.image,
                ports: []
              }))
            ]
          },
          status: {}
        } as k8s.V1Pod)
    )
    await prepareJob(args, responseFile)
    const content = JSON.parse(fs.readFileSync(responseFile, 'utf8'))
    expect(content.context.services).toHaveLength(2)
  })
})
