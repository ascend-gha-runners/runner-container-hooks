vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('../k8s', () => ({
  prunePods: vi.fn().mockResolvedValue(undefined),
  pruneSecrets: vi.fn().mockResolvedValue(undefined)
}))

const collectAndPushNpuMetrics = vi.fn().mockResolvedValue(undefined)
const npuMetricsEnabled = vi.fn().mockReturnValue(true)

vi.mock('../k8s/utils/npu-metrics', () => ({
  collectAndPushNpuMetrics: (...args: unknown[]) =>
    collectAndPushNpuMetrics(...args),
  npuMetricsEnabled: () => npuMetricsEnabled(),
  withTimeout: async (promise: Promise<unknown>) => promise,
  NPU_COLLECT_TIMEOUT_MS: 10000
}))

import { cleanupJob } from './cleanup-job'
import * as k8sMod from '../k8s'

describe('cleanupJob', () => {
  afterEach(() => {
    vi.clearAllMocks()
    npuMetricsEnabled.mockReturnValue(true)
    collectAndPushNpuMetrics.mockResolvedValue(undefined)
  })

  it('always prunes pods and secrets', async () => {
    await cleanupJob()
    expect(k8sMod.prunePods).toHaveBeenCalledTimes(1)
    expect(k8sMod.pruneSecrets).toHaveBeenCalledTimes(1)
  })

  it('collects npu metrics before pruning', async () => {
    const order: string[] = []
    collectAndPushNpuMetrics.mockImplementation(async () => {
      order.push('collect')
    })
    vi.mocked(k8sMod.prunePods).mockImplementation(async () => {
      order.push('prunePods')
    })
    vi.mocked(k8sMod.pruneSecrets).mockImplementation(async () => {
      order.push('pruneSecrets')
    })
    await cleanupJob()
    expect(order[0]).toBe('collect')
    expect(order.slice(1).sort()).toEqual(['prunePods', 'pruneSecrets'])
  })

  it('keeps pruning when collection fails', async () => {
    collectAndPushNpuMetrics.mockRejectedValue(new Error('collect exploded'))
    await expect(cleanupJob()).resolves.toBeUndefined()
    expect(k8sMod.prunePods).toHaveBeenCalledTimes(1)
    expect(k8sMod.pruneSecrets).toHaveBeenCalledTimes(1)
  })

  it('skips collection when the feature flag is disabled', async () => {
    npuMetricsEnabled.mockReturnValue(false)
    await cleanupJob()
    expect(collectAndPushNpuMetrics).not.toHaveBeenCalled()
    expect(k8sMod.prunePods).toHaveBeenCalledTimes(1)
  })
})
