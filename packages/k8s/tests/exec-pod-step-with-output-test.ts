import * as k8s from '@kubernetes/client-node'
import * as core from '@actions/core'
import { execPodStepWithOutput } from '../src/k8s'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

describe('execPodStepWithOutput', () => {
  let execSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = jest.spyOn(k8s.Exec.prototype, 'exec')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves with code 0 and captured stdout on success', async () => {
    execSpy.mockImplementation(
      (
        _ns,
        _pod,
        _container,
        _cmd,
        stdout,
        _stderr,
        _stdin,
        _tty,
        callback
      ) => {
        stdout.write('hello from script\n')
        stdout.write('second line\n')
        callback({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'echo hello'],
      'test-pod',
      'job'
    )
    expect(code).toBe(0)
    expect(output).toContain('hello from script')
    expect(output).toContain('second line')
  })

  it('resolves with exit code when exec() promise rejects with non-zero exit message', async () => {
    // This is the k8s client v1.x path: exec() rejects directly, callback never fires.
    execSpy.mockImplementation((_ns, _pod, _container, _cmd, stdout) => {
      stdout.write('some output before fail\n')
      return Promise.reject(
        new Error(
          'command terminated with non-zero exit code: command terminated with exit code 154'
        )
      )
    })
    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'exit 154'],
      'test-pod',
      'job'
    )
    expect(code).toBe(154)
    expect(output).toContain('some output before fail')
  })

  it('resolves with exit code from Failure status callback', async () => {
    execSpy.mockImplementation(
      (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        stderr,
        _stdin,
        _tty,
        callback
      ) => {
        stderr.write('error output\n')
        callback({
          status: 'Failure',
          message: 'command terminated with exit code 1'
        })
        return Promise.resolve()
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'exit 1'],
      'test-pod',
      'job'
    )
    expect(code).toBe(1)
    expect(output).toContain('error output')
  })

  it('rejects on genuine exec failure (no exit code in error message)', async () => {
    execSpy.mockReturnValue(
      Promise.reject(new Error('websocket: connection refused'))
    )
    await expect(
      execPodStepWithOutput(['echo', 'hi'], 'test-pod', 'job')
    ).rejects.toThrow('websocket: connection refused')
  })

  it('rejects on Failure callback with no exit code in message', async () => {
    execSpy.mockImplementation(
      (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        _stderr,
        _stdin,
        _tty,
        callback
      ) => {
        callback({ status: 'Failure', message: 'container not found' })
        return Promise.resolve()
      }
    )
    await expect(
      execPodStepWithOutput(['echo'], 'test-pod', 'job')
    ).rejects.toThrow('container not found')
  })

  it('retains only the last tailLines lines in the output buffer', async () => {
    execSpy.mockImplementation(
      (
        _ns,
        _pod,
        _container,
        _cmd,
        stdout,
        _stderr,
        _stdin,
        _tty,
        callback
      ) => {
        for (let i = 0; i < 30; i++) {
          stdout.write(`line ${i}\n`)
        }
        callback({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['cmd'],
      'test-pod',
      'job',
      5 // tailLines = 5
    )
    expect(code).toBe(0)
    const lines = output.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(output).toContain('line 29')
    expect(output).not.toContain('line 0')
  })

  it('keeps stdout and stderr pending buffers independent (no interleaving)', async () => {
    execSpy.mockImplementation(
      (_ns, _pod, _container, _cmd, stdout, stderr, _stdin, _tty, callback) => {
        // Write partial lines to both streams without a newline delimiter.
        // If the pending buffers were shared, "out partial" and "err partial"
        // would be concatenated into one corrupted line.
        stdout.write('out partial')
        stderr.write('err partial')
        stdout.write(' continued\n') // completes the stdout line
        stderr.write(' done\n') // completes the stderr line
        callback({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    const { output } = await execPodStepWithOutput(['cmd'], 'test-pod', 'job')
    expect(output).toContain('out partial continued')
    expect(output).toContain('err partial done')
    // The two partial writes must NOT be merged into a single corrupted line
    expect(output).not.toContain('out partialerr partial')
    expect(output).not.toContain('err partialout partial')
  })
})
