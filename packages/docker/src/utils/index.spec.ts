import {
  optionsWithDockerEnvs,
  sanitize,
  fixArgs,
  checkEnvironment
} from './index'

describe('sanitize', () => {
  it('strips non-alphanumeric chars except underscore', () => {
    expect(sanitize('ubuntu:latest')).toBe('ubuntulatest')
  })

  it('returns same string for valid identifier', () => {
    expect(sanitize('teststr8_one')).toBe('teststr8_one')
  })

  it('returns empty string for empty input', () => {
    expect(sanitize('')).toBe('')
  })

  it('strips leading non-alpha chars', () => {
    expect(sanitize('123abc')).toBe('abc')
  })
})

describe('fixArgs', () => {
  it('splits quoted arguments', () => {
    expect(fixArgs(['"Hello', 'World"'])).toStrictEqual(['Hello World'])
  })

  it('handles complex shell quoting', () => {
    expect(
      fixArgs([
        'sh',
        '-c',
        `'[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1'`
      ])
    ).toStrictEqual([
      'sh',
      '-c',
      `[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1`
    ])
  })

  it('returns plain args unchanged', () => {
    expect(fixArgs(['ls', '-la'])).toStrictEqual(['ls', '-la'])
  })
})

describe('optionsWithDockerEnvs', () => {
  afterEach(() => {
    delete process.env.DOCKER_HOST
    delete process.env.DOCKER_NOTEXIST
  })

  it('injects known docker env vars into options', () => {
    process.env.DOCKER_HOST = 'unix:///run/user/1001/docker.sock'
    process.env.DOCKER_NOTEXIST = 'should-not-appear'

    for (const opt of [undefined, {}, { env: {} }]) {
      const options = optionsWithDockerEnvs(opt as any)
      expect(options?.env?.DOCKER_HOST).toBe(process.env.DOCKER_HOST)
      expect(options?.env?.DOCKER_NOTEXIST).toBeUndefined()
    }
  })

  it('preserves workingDir and input from original options', () => {
    process.env.DOCKER_HOST = 'unix:///run/user/1001/docker.sock'
    const opt = { workingDir: 'test', input: Buffer.from('test') }
    const options = optionsWithDockerEnvs(opt)
    expect(options?.workingDir).toBe('test')
    expect(options?.input).toBe(opt.input)
  })

  it('overwrites DOCKER_HOST in provided env with process env value', () => {
    process.env.DOCKER_HOST = 'unix:///run/user/1001/docker.sock'
    const opt = { env: { DOCKER_HOST: 'unix://var/run/docker.sock' } }
    const options = optionsWithDockerEnvs(opt)
    expect(options?.env?.DOCKER_HOST).toBe(process.env.DOCKER_HOST)
  })
})

describe('checkEnvironment', () => {
  const original = process.env.GITHUB_WORKSPACE

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GITHUB_WORKSPACE
    } else {
      process.env.GITHUB_WORKSPACE = original
    }
  })

  it('does not throw when GITHUB_WORKSPACE is set', () => {
    process.env.GITHUB_WORKSPACE = '/home/runner/work/repo'
    expect(() => checkEnvironment()).not.toThrow()
  })

  it('throws when GITHUB_WORKSPACE is not set', () => {
    delete process.env.GITHUB_WORKSPACE
    expect(() => checkEnvironment()).toThrow('GITHUB_WORKSPACE is not set')
  })
})
