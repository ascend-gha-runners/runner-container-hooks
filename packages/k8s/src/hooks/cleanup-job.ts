import * as core from '@actions/core'
import { formatError } from '../k8s/utils'
import { prunePods, pruneSecrets } from '../k8s'
import {
  collectAndPushNpuMetrics,
  NPU_COLLECT_TIMEOUT_MS,
  npuMetricsEnabled,
  withTimeout
} from '../k8s/utils/npu-metrics'

export async function cleanupJob(): Promise<void> {
  if (npuMetricsEnabled()) {
    try {
      await withTimeout(collectAndPushNpuMetrics(), NPU_COLLECT_TIMEOUT_MS)
    } catch (err) {
      core.debug(`npu-metrics: collection failed: ${formatError(err)}`)
    }
  }
  await Promise.all([prunePods(), pruneSecrets()])
}
