import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('../utils', () => ({
  runDockerCommand: vi.fn().mockResolvedValue('container-id-abc'),
  RunDockerCommandOptions: {}
}))

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))

import { createContainer } from './container'
import { runDockerCommand } from '../utils'

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `docker-spec-${Date.now()}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

describe('createContainer mount volumes', () => {
  const tmpDir = makeTmpDir()

  beforeEach(() => {
    process.env.RUNNER_NAME = 'test-runner'
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.RUNNER_NAME
  })

  it('appends :ro suffix for readOnly user mount volumes (lines 62-64)', async () => {
    await createContainer(
      {
        image: 'ubuntu:latest',
        userMountVolumes: [
          {
            sourceVolumePath: '/src/ro',
            targetVolumePath: '/mnt/ro',
            readOnly: true
          }
        ],
        systemMountVolumes: [
          {
            sourceVolumePath: '/src/rw',
            targetVolumePath: '/mnt/rw',
            readOnly: false
          }
        ]
      } as any,
      'test-container',
      'test-network'
    )

    const call = (runDockerCommand as any).mock.calls[0]
    const dockerArgs: string[] = call[0]
    expect(dockerArgs).toContain('-v=/src/ro:/mnt/ro:ro')
    expect(dockerArgs).toContain('-v=/src/rw:/mnt/rw')
  })
})
