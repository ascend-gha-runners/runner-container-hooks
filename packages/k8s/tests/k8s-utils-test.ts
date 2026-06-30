import * as fs from 'fs'
import { containerPorts } from '../src/k8s'
import {
  generateContainerName,
  writeRunScript,
  writeContainerStepScript,
  prepareJobScript,
  mergePodSpecWithOptions,
  mergeContainerWithOptions,
  mergeObjectMeta,
  readExtensionFromFile,
  fixArgs,
  sleep,
  listDirAllCommand,
  useKubeScheduler,
  ENV_HOOK_TEMPLATE_PATH,
  ENV_USE_KUBE_SCHEDULER
} from '../src/k8s/utils'
import * as k8s from '@kubernetes/client-node'
import { TestHelper } from './test-setup'

let testHelper: TestHelper

describe('k8s utils', () => {
  describe('write entrypoint', () => {
    beforeEach(async () => {
      testHelper = new TestHelper()
      await testHelper.initialize()
    })

    afterEach(async () => {
      await testHelper.cleanup()
    })

    it('should not throw', () => {
      expect(() =>
        writeRunScript('/test', 'sh', ['-e', 'script.sh'], ['/prepend/path'], {
          SOME_ENV: 'SOME_VALUE'
        })
      ).not.toThrow()
    })

    it('should throw if RUNNER_TEMP is not set', () => {
      delete process.env.RUNNER_TEMP
      expect(() =>
        writeRunScript('/test', 'sh', ['-e', 'script.sh'], ['/prepend/path'], {
          SOME_ENV: 'SOME_VALUE'
        })
      ).toThrow()
    })

    it('should throw if environment variable name contains double quote', () => {
      expect(() =>
        writeRunScript('/test', 'sh', ['-e', 'script.sh'], ['/prepend/path'], {
          'SOME"_ENV': 'SOME_VALUE'
        })
      ).toThrow()
    })

    it('should throw if environment variable name contains =', () => {
      expect(() =>
        writeRunScript('/test', 'sh', ['-e', 'script.sh'], ['/prepend/path'], {
          'SOME=ENV': 'SOME_VALUE'
        })
      ).toThrow()
    })

    it('should throw if environment variable name contains single quote', () => {
      expect(() =>
        writeRunScript('/test', 'sh', ['-e', 'script.sh'], ['/prepend/path'], {
          "SOME'_ENV": 'SOME_VALUE'
        })
      ).toThrow()
    })

    it('should throw if environment variable name contains dollar', () => {
      expect(() =>
        writeRunScript('/test', 'sh', ['-e', 'script.sh'], ['/prepend/path'], {
          SOME_$_ENV: 'SOME_VALUE'
        })
      ).toThrow()
    })

    it('should escape double quote, dollar and backslash in environment variable values', () => {
      const { runnerPath } = writeRunScript(
        '/test',
        'sh',
        ['-e', 'script.sh'],
        ['/prepend/path'],
        {
          DQUOTE: '"',
          BACK_SLASH: '\\',
          DOLLAR: '$'
        }
      )
      expect(fs.existsSync(runnerPath)).toBe(true)
      const script = fs.readFileSync(runnerPath, 'utf8')
      expect(script).toContain('"DQUOTE=\\"')
      expect(script).toContain('"BACK_SLASH=\\\\"')
      expect(script).toContain('"DOLLAR=\\$"')
    })

    it('should return object with containerPath and runnerPath', () => {
      const { containerPath, runnerPath } = writeRunScript(
        '/test',
        'sh',
        ['-e', 'script.sh'],
        ['/prepend/path'],
        {
          SOME_ENV: 'SOME_VALUE'
        }
      )
      expect(containerPath).toMatch(/\/__w\/_temp\/.*\.sh/)
      const re = new RegExp(`${process.env.RUNNER_TEMP}/.*\\.sh`)
      expect(runnerPath).toMatch(re)
    })

    it('should write entrypoint path and the file should exist', () => {
      const { runnerPath } = writeRunScript(
        '/test',
        'sh',
        ['-e', 'script.sh'],
        ['/prepend/path'],
        {
          SOME_ENV: 'SOME_VALUE'
        }
      )
      expect(fs.existsSync(runnerPath)).toBe(true)
    })
  })

  describe('container volumes', () => {
    beforeEach(async () => {
      testHelper = new TestHelper()
      await testHelper.initialize()
    })

    afterEach(async () => {
      await testHelper.cleanup()
    })

    it('should parse container ports', () => {
      const tt = [
        {
          spec: '8080:80',
          want: {
            containerPort: 80,
            hostPort: 8080,
            protocol: 'TCP'
          }
        },
        {
          spec: '8080:80/udp',
          want: {
            containerPort: 80,
            hostPort: 8080,
            protocol: 'UDP'
          }
        },
        {
          spec: '8080/udp',
          want: {
            containerPort: 8080,
            hostPort: undefined,
            protocol: 'UDP'
          }
        },
        {
          spec: '8080',
          want: {
            containerPort: 8080,
            hostPort: undefined,
            protocol: 'TCP'
          }
        }
      ]

      for (const tc of tt) {
        const got = containerPorts({ portMappings: [tc.spec] })
        for (const [key, value] of Object.entries(tc.want)) {
          expect(got[0][key]).toBe(value)
        }
      }
    })

    it('should throw when ports are out of range (0, 65536)', () => {
      expect(() => containerPorts({ portMappings: ['65536'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['0'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['65536/udp'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['0/udp'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['1:65536'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['65536:1'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['1:65536/tcp'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['65536:1/tcp'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['1:'] })).toThrow()
      expect(() => containerPorts({ portMappings: [':1'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['1:/tcp'] })).toThrow()
      expect(() => containerPorts({ portMappings: [':1/tcp'] })).toThrow()
    })

    it('should throw on multi ":" splits', () => {
      expect(() => containerPorts({ portMappings: ['1:1:1'] })).toThrow()
    })

    it('should throw on multi "/" splits', () => {
      expect(() => containerPorts({ portMappings: ['1:1/tcp/udp'] })).toThrow()
      expect(() => containerPorts({ portMappings: ['1/tcp/udp'] })).toThrow()
    })
  })

  describe('generate container name', () => {
    it('should return the container name from image string', () => {
      expect(
        generateContainerName('public.ecr.aws/localstack/localstack')
      ).toEqual('localstack')
      expect(
        generateContainerName(
          'public.ecr.aws/url/with/multiple/slashes/postgres:latest'
        )
      ).toEqual('postgres')
      expect(generateContainerName('postgres')).toEqual('postgres')
      expect(generateContainerName('postgres:latest')).toEqual('postgres')
      expect(generateContainerName('localstack/localstack')).toEqual(
        'localstack'
      )
      expect(generateContainerName('localstack/localstack:latest')).toEqual(
        'localstack'
      )
    })

    it('should throw on invalid image string', () => {
      expect(() =>
        generateContainerName('localstack/localstack/:latest')
      ).toThrow()
      expect(() => generateContainerName(':latest')).toThrow()
    })
  })

  describe('read extension', () => {
    beforeEach(async () => {
      testHelper = new TestHelper()
      await testHelper.initialize()
    })

    afterEach(async () => {
      await testHelper.cleanup()
    })

    it('should throw if env variable is set but file does not exist', () => {
      process.env[ENV_HOOK_TEMPLATE_PATH] =
        '/path/that/does/not/exist/data.yaml'
      expect(() => readExtensionFromFile()).toThrow()
    })

    it('should return undefined if env variable is not set', () => {
      delete process.env[ENV_HOOK_TEMPLATE_PATH]
      expect(readExtensionFromFile()).toBeUndefined()
    })

    it('should throw if file is empty', () => {
      let filePath = testHelper.createFile('data.yaml')
      process.env[ENV_HOOK_TEMPLATE_PATH] = filePath
      expect(() => readExtensionFromFile()).toThrow()
    })

    it('should throw if file is not valid yaml', () => {
      let filePath = testHelper.createFile('data.yaml')
      fs.writeFileSync(filePath, 'invalid yaml')
      process.env[ENV_HOOK_TEMPLATE_PATH] = filePath
      expect(() => readExtensionFromFile()).toThrow()
    })

    it('should return object if file is valid', () => {
      let filePath = testHelper.createFile('data.yaml')
      fs.writeFileSync(
        filePath,
        `
metadata:
  labels:
    label-name: label-value
  annotations:
    annotation-name: annotation-value
spec:
  containers:
    - name: test
      image: node:22
    - name: job
      image: ubuntu:latest`
      )

      process.env[ENV_HOOK_TEMPLATE_PATH] = filePath
      const extension = readExtensionFromFile()
      expect(extension).toBeDefined()
    })
  })

  it('should merge container spec', () => {
    const base = {
      image: 'node:22',
      name: 'test',
      env: [
        {
          name: 'TEST',
          value: 'TEST'
        }
      ],
      ports: [
        {
          containerPort: 8080,
          hostPort: 8080,
          protocol: 'TCP'
        }
      ]
    } as k8s.V1Container

    const from = {
      ports: [
        {
          containerPort: 9090,
          hostPort: 9090,
          protocol: 'TCP'
        }
      ],
      env: [
        {
          name: 'TEST_TWO',
          value: 'TEST_TWO'
        }
      ],
      image: 'ubuntu:latest',
      name: 'overwrite'
    } as k8s.V1Container

    const expectContainer = {
      name: base.name,
      image: base.image,
      ports: [
        ...(base.ports as k8s.V1ContainerPort[]),
        ...(from.ports as k8s.V1ContainerPort[])
      ],
      env: [...(base.env as k8s.V1EnvVar[]), ...(from.env as k8s.V1EnvVar[])]
    }

    const expectJobContainer = JSON.parse(JSON.stringify(expectContainer))
    expectJobContainer.name = base.name
    mergeContainerWithOptions(base, from)
    expect(base).toStrictEqual(expectContainer)
  })

  it('should merge pod spec', () => {
    const base = {
      containers: [
        {
          image: 'node:22',
          name: 'test',
          env: [
            {
              name: 'TEST',
              value: 'TEST'
            }
          ],
          ports: [
            {
              containerPort: 8080,
              hostPort: 8080,
              protocol: 'TCP'
            }
          ]
        }
      ],
      restartPolicy: 'Never'
    } as k8s.V1PodSpec

    const from = {
      securityContext: {
        runAsUser: 1000,
        fsGroup: 2000
      },
      restartPolicy: 'Always',
      volumes: [
        {
          name: 'work',
          emptyDir: {}
        }
      ],
      containers: [
        {
          image: 'ubuntu:latest',
          name: 'side-car',
          env: [
            {
              name: 'TEST',
              value: 'TEST'
            }
          ],
          ports: [
            {
              containerPort: 8080,
              hostPort: 8080,
              protocol: 'TCP'
            }
          ]
        }
      ]
    } as k8s.V1PodSpec

    const expected = JSON.parse(JSON.stringify(base))
    expected.securityContext = from.securityContext
    expected.restartPolicy = from.restartPolicy
    expected.volumes = from.volumes
    expected.containers.push(from.containers[0])

    mergePodSpecWithOptions(base, from)

    expect(base).toStrictEqual(expected)
  })
})

describe('writeContainerStepScript', () => {
  let testHelper: TestHelper

  beforeEach(async () => {
    testHelper = new TestHelper()
    await testHelper.initialize()
  })

  afterEach(async () => {
    await testHelper.cleanup()
  })

  it('should write script and return containerPath and runnerPath', () => {
    const dst = process.env.RUNNER_TEMP as string
    const { containerPath, runnerPath } = writeContainerStepScript(
      dst,
      '/__w/repo/repo',
      'sh',
      ['-e', 'script.sh']
    )
    expect(containerPath).toMatch(/\/__w\/_temp\/.*\.sh/)
    expect(runnerPath).toMatch(new RegExp(`${dst}/.*\\.sh`))
    expect(fs.existsSync(runnerPath)).toBe(true)
  })

  it('should include env vars escaped in script', () => {
    const dst = process.env.RUNNER_TEMP as string
    const { runnerPath } = writeContainerStepScript(
      dst,
      '/__w/repo/repo',
      'sh',
      [],
      { MY_VAR: 'value with "quotes" and $dollar' }
    )
    const content = fs.readFileSync(runnerPath, 'utf8')
    expect(content).toContain('MY_VAR=')
    expect(content).toContain('\\"')
    expect(content).toContain('\\$')
  })

  it('should throw on invalid working directory', () => {
    const dst = process.env.RUNNER_TEMP as string
    expect(() =>
      writeContainerStepScript(dst, '/too-short', 'sh')
    ).toThrow('Invalid working directory')
  })

  it('should throw if env key contains invalid chars', () => {
    const dst = process.env.RUNNER_TEMP as string
    expect(() =>
      writeContainerStepScript(dst, '/__w/repo/repo', 'sh', [], {
        'BAD=KEY': 'val'
      })
    ).toThrow()
  })
})

describe('prepareJobScript', () => {
  let testHelper: TestHelper

  beforeEach(async () => {
    testHelper = new TestHelper()
    await testHelper.initialize()
  })

  afterEach(async () => {
    await testHelper.cleanup()
  })

  it('should write script and return paths', () => {
    const { containerPath, runnerPath } = prepareJobScript([
      { sourceVolumePath: '/src', targetVolumePath: '/mnt/data', readOnly: false }
    ])
    expect(containerPath).toMatch(/\/__w\/_temp\/.*\.sh/)
    expect(fs.existsSync(runnerPath)).toBe(true)
  })

  it('should include mkdir for each mount target in script', () => {
    const { runnerPath } = prepareJobScript([
      { sourceVolumePath: '/src1', targetVolumePath: '/mnt/vol1', readOnly: false },
      { sourceVolumePath: '/src2', targetVolumePath: '/mnt/vol2', readOnly: false }
    ])
    const content = fs.readFileSync(runnerPath, 'utf8')
    expect(content).toContain('/mnt/vol1')
    expect(content).toContain('/mnt/vol2')
    expect(content).toContain('mkdir -p')
  })

  it('should work with empty mounts', () => {
    const { runnerPath } = prepareJobScript([])
    expect(fs.existsSync(runnerPath)).toBe(true)
  })
})

describe('fixArgs', () => {
  it('should split quoted arguments correctly', () => {
    expect(fixArgs(['"Hello', 'World"'])).toStrictEqual(['Hello World'])
  })

  it('should handle single-quoted shell args', () => {
    expect(fixArgs(['sh', '-c', "'echo hello'"])).toStrictEqual([
      'sh',
      '-c',
      'echo hello'
    ])
  })

  it('should return unchanged args with no quoting', () => {
    expect(fixArgs(['ls', '-la', '/tmp'])).toStrictEqual(['ls', '-la', '/tmp'])
  })
})

describe('sleep', () => {
  it('should resolve after given ms', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

describe('listDirAllCommand', () => {
  it('should return find command for given dir', () => {
    const cmd = listDirAllCommand('/some/path')
    expect(cmd).toContain('cd')
    expect(cmd).toContain('/some/path')
    expect(cmd).toContain('find')
    expect(cmd).toContain('-type f')
  })

  it('should shell-quote the path', () => {
    const cmd = listDirAllCommand('/path with spaces')
    expect(cmd).toContain("'")
  })
})

describe('mergeObjectMeta', () => {
  it('should merge labels and annotations', () => {
    const base = {
      metadata: {
        labels: { existing: 'val' },
        annotations: { ann: 'orig' }
      }
    }
    mergeObjectMeta(base, {
      labels: { newLabel: 'newVal' },
      annotations: { newAnn: 'newAnnotation' }
    })
    expect(base.metadata.labels['newLabel']).toBe('newVal')
    expect(base.metadata.labels['existing']).toBe('val')
    expect(base.metadata.annotations['newAnn']).toBe('newAnnotation')
    expect(base.metadata.annotations['ann']).toBe('orig')
  })

  it('should throw if metadata or annotations undefined', () => {
    expect(() =>
      mergeObjectMeta({ metadata: undefined }, { labels: {} })
    ).toThrow()
    expect(() =>
      mergeObjectMeta(
        { metadata: { labels: { a: 'b' } } },
        { labels: {} }
      )
    ).toThrow()
  })
})

describe('useKubeScheduler', () => {
  afterEach(() => {
    delete process.env[ENV_USE_KUBE_SCHEDULER]
  })

  it('should return true when env var is "true"', () => {
    process.env[ENV_USE_KUBE_SCHEDULER] = 'true'
    expect(useKubeScheduler()).toBe(true)
  })

  it('should return false when env var is not set', () => {
    expect(useKubeScheduler()).toBe(false)
  })

  it('should return false when env var is "false"', () => {
    process.env[ENV_USE_KUBE_SCHEDULER] = 'false'
    expect(useKubeScheduler()).toBe(false)
  })
})
