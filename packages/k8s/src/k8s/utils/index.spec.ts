import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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
} from './index'

// Minimal temp dir helper for tests that write files
function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `k8s-utils-test-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('generateContainerName', () => {
  it('extracts name from image with registry and tag', () => {
    expect(generateContainerName('public.ecr.aws/localstack/localstack')).toBe(
      'localstack'
    )
    expect(generateContainerName('postgres:latest')).toBe('postgres')
    expect(generateContainerName('postgres')).toBe('postgres')
    expect(
      generateContainerName(
        'public.ecr.aws/url/with/multiple/slashes/postgres:latest'
      )
    ).toBe('postgres')
  })

  it('throws on invalid image string', () => {
    expect(() => generateContainerName(':latest')).toThrow()
    expect(() =>
      generateContainerName('localstack/localstack/:latest')
    ).toThrow()
  })
})

describe('fixArgs', () => {
  it('splits quoted arguments', () => {
    expect(fixArgs(['"Hello', 'World"'])).toStrictEqual(['Hello World'])
  })

  it('handles single-quoted shell args', () => {
    expect(fixArgs(['sh', '-c', "'echo hello'"])).toStrictEqual([
      'sh',
      '-c',
      'echo hello'
    ])
  })

  it('returns plain args unchanged', () => {
    expect(fixArgs(['ls', '-la', '/tmp'])).toStrictEqual(['ls', '-la', '/tmp'])
  })
})

describe('sleep', () => {
  it('resolves after given ms', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

describe('listDirAllCommand', () => {
  it('returns find command containing the dir', () => {
    const cmd = listDirAllCommand('/some/path')
    expect(cmd).toContain('/some/path')
    expect(cmd).toContain('find')
    expect(cmd).toContain('-type f')
  })

  it('shell-quotes paths with spaces', () => {
    const cmd = listDirAllCommand('/path with spaces')
    expect(cmd).toContain("'")
  })
})

describe('useKubeScheduler', () => {
  afterEach(() => {
    delete process.env[ENV_USE_KUBE_SCHEDULER]
  })

  it('returns true when env is "true"', () => {
    process.env[ENV_USE_KUBE_SCHEDULER] = 'true'
    expect(useKubeScheduler()).toBe(true)
  })

  it('returns false when env is unset', () => {
    expect(useKubeScheduler()).toBe(false)
  })

  it('returns false when env is "false"', () => {
    process.env[ENV_USE_KUBE_SCHEDULER] = 'false'
    expect(useKubeScheduler()).toBe(false)
  })
})

describe('mergeObjectMeta', () => {
  it('merges labels and annotations', () => {
    const base = {
      metadata: { labels: { existing: 'val' }, annotations: { ann: 'orig' } }
    }
    mergeObjectMeta(base, {
      labels: { newLabel: 'newVal' },
      annotations: { newAnn: 'newAnnotation' }
    })
    expect(base.metadata.labels['newLabel']).toBe('newVal')
    expect(base.metadata.labels['existing']).toBe('val')
    expect(base.metadata.annotations['newAnn']).toBe('newAnnotation')
  })

  it('throws if metadata is undefined', () => {
    expect(() =>
      mergeObjectMeta({ metadata: undefined }, { labels: {} })
    ).toThrow()
  })

  it('throws if annotations are undefined', () => {
    expect(() =>
      mergeObjectMeta({ metadata: { labels: { a: 'b' } } }, { labels: {} })
    ).toThrow()
  })
})

describe('writeRunScript', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
    process.env.RUNNER_TEMP = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.RUNNER_TEMP
  })

  it('returns containerPath and runnerPath', () => {
    const { containerPath, runnerPath } = writeRunScript('/work', 'sh', [
      '-e',
      'script.sh'
    ])
    expect(containerPath).toMatch(/\/__w\/_temp\/.*\.sh/)
    expect(runnerPath).toContain(tmpDir)
    expect(fs.existsSync(runnerPath)).toBe(true)
  })

  it('escapes double-quote, dollar, backslash in env values', () => {
    const { runnerPath } = writeRunScript('/work', 'sh', [], [], {
      DQUOTE: '"',
      DOLLAR: '$',
      BACK_SLASH: '\\'
    })
    const content = fs.readFileSync(runnerPath, 'utf8')
    expect(content).toContain('\\"')
    expect(content).toContain('\\$')
    expect(content).toContain('\\\\')
  })

  it('throws if RUNNER_TEMP is not set', () => {
    delete process.env.RUNNER_TEMP
    expect(() => writeRunScript('/work', 'sh')).toThrow()
  })

  it('throws if env key contains "="', () => {
    expect(() =>
      writeRunScript('/work', 'sh', [], [], { 'BAD=KEY': 'val' })
    ).toThrow()
  })

  it('throws if env key contains "$"', () => {
    expect(() =>
      writeRunScript('/work', 'sh', [], [], { BAD$KEY: 'val' })
    ).toThrow()
  })
})

describe('writeContainerStepScript', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
    process.env.RUNNER_TEMP = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.RUNNER_TEMP
  })

  it('returns containerPath and runnerPath', () => {
    const { containerPath, runnerPath } = writeContainerStepScript(
      tmpDir,
      '/__w/repo/repo',
      'sh',
      ['-e', 'script.sh']
    )
    expect(containerPath).toMatch(/\/__w\/_temp\/.*\.sh/)
    expect(fs.existsSync(runnerPath)).toBe(true)
  })

  it('throws on invalid working directory', () => {
    expect(() => writeContainerStepScript(tmpDir, 'tooshort', 'sh')).toThrow(
      'Invalid working directory'
    )
  })

  it('throws if env key contains invalid chars', () => {
    expect(() =>
      writeContainerStepScript(tmpDir, '/__w/repo/repo', 'sh', [], {
        'BAD=KEY': 'val'
      })
    ).toThrow()
  })
})

describe('prepareJobScript', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
    process.env.RUNNER_TEMP = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.RUNNER_TEMP
  })

  it('returns paths and file exists', () => {
    const { containerPath, runnerPath } = prepareJobScript([
      {
        sourceVolumePath: '/src',
        targetVolumePath: '/mnt/data',
        readOnly: false
      }
    ])
    expect(containerPath).toMatch(/\/__w\/_temp\/.*\.sh/)
    expect(fs.existsSync(runnerPath)).toBe(true)
  })

  it('includes mkdir for each mount target', () => {
    const { runnerPath } = prepareJobScript([
      {
        sourceVolumePath: '/s1',
        targetVolumePath: '/mnt/vol1',
        readOnly: false
      },
      {
        sourceVolumePath: '/s2',
        targetVolumePath: '/mnt/vol2',
        readOnly: false
      }
    ])
    const content = fs.readFileSync(runnerPath, 'utf8')
    expect(content).toContain('/mnt/vol1')
    expect(content).toContain('/mnt/vol2')
    expect(content).toContain('mkdir -p')
  })

  it('works with empty mounts', () => {
    const { runnerPath } = prepareJobScript([])
    expect(fs.existsSync(runnerPath)).toBe(true)
  })
})

describe('readExtensionFromFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env[ENV_HOOK_TEMPLATE_PATH]
  })

  it('returns undefined when env var not set', () => {
    expect(readExtensionFromFile()).toBeUndefined()
  })

  it('throws if file does not exist', () => {
    process.env[ENV_HOOK_TEMPLATE_PATH] = '/nonexistent/path/data.yaml'
    expect(() => readExtensionFromFile()).toThrow()
  })

  it('throws if file is empty', () => {
    const f = path.join(tmpDir, 'empty.yaml')
    fs.writeFileSync(f, '')
    process.env[ENV_HOOK_TEMPLATE_PATH] = f
    expect(() => readExtensionFromFile()).toThrow()
  })

  it('returns object for valid yaml', () => {
    const f = path.join(tmpDir, 'valid.yaml')
    fs.writeFileSync(
      f,
      `metadata:\n  labels:\n    label-name: label-value\nspec:\n  containers:\n    - name: test\n      image: node:22\n`
    )
    process.env[ENV_HOOK_TEMPLATE_PATH] = f
    expect(readExtensionFromFile()).toBeDefined()
  })
})

describe('mergeContainerWithOptions', () => {
  it('merges env and ports, keeps base name and image', () => {
    const base = {
      image: 'node:22',
      name: 'test',
      env: [{ name: 'A', value: '1' }],
      ports: [{ containerPort: 8080, protocol: 'TCP' }]
    }
    const from = {
      image: 'ubuntu:latest',
      name: '$test',
      env: [{ name: 'B', value: '2' }],
      ports: [{ containerPort: 9090, protocol: 'TCP' }]
    }
    mergeContainerWithOptions(base as any, from as any)
    expect(base.name).toBe('test')
    expect(base.image).toBe('node:22')
    expect(base.env).toHaveLength(2)
    expect(base.ports).toHaveLength(2)
  })
})

describe('mergePodSpecWithOptions', () => {
  it('merges volumes and non-extension containers, overwrites scalar fields', () => {
    const base = {
      containers: [{ image: 'node:22', name: 'test' }],
      restartPolicy: 'Never'
    }
    const from = {
      restartPolicy: 'Always',
      volumes: [{ name: 'work', emptyDir: {} }],
      containers: [{ image: 'ubuntu:latest', name: 'side-car' }]
    }
    mergePodSpecWithOptions(base as any, from as any)
    expect(base.restartPolicy).toBe('Always')
    expect((base as any).volumes).toHaveLength(1)
    expect(base.containers).toHaveLength(2)
  })
})
