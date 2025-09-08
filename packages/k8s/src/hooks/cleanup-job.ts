import { prunePods, pruneSecrets } from '../k8s'
import * as core from '@actions/core'

export async function cleanupJob(): Promise<void> {
  core.info('HOOK: cleanupJob')
  await Promise.all([prunePods(), pruneSecrets()])
}
