import * as core from '@actions/core'
import * as fs from 'fs'
import * as k8s from '@kubernetes/client-node'
import { RunContainerStepArgs } from 'hooklib'
import { dirname } from 'path'
import {
  createContainerStepPod,
  deletePod,
  describePodFailure,
  execCpFromPod,
  execCpToPod,
  execPodStepWithOutput,
  getContainerTerminatedErrors,
  getPodByName,
  getPrepareJobTimeoutSeconds,
  waitForPodPhases
} from '../k8s'
import {
  CONTAINER_VOLUMES,
  mergeContainerWithOptions,
  PodPhase,
  readExtensionFromFile,
  DEFAULT_CONTAINER_ENTRY_POINT_ARGS,
  writeContainerStepScript
} from '../k8s/utils'
import {
  getJobPodName,
  getStepPodName,
  JOB_CONTAINER_EXTENSION_NAME,
  JOB_CONTAINER_NAME
} from './constants'

export async function runContainerStep(
  stepContainer: RunContainerStepArgs
): Promise<number> {
  if (stepContainer.dockerfile) {
    throw new Error('Building container actions is not currently supported')
  }

  if (!stepContainer.entryPoint) {
    throw new Error(
      'failed to start the container since the entrypoint is overwritten'
    )
  }

  const envs = stepContainer.environmentVariables || {}
  envs['GITHUB_ACTIONS'] = 'true'
  if (!('CI' in envs)) {
    envs.CI = 'true'
  }

  const extension = readExtensionFromFile()

  const container = createContainerSpec(stepContainer, extension)

  let pod: k8s.V1Pod
  try {
    pod = await createContainerStepPod(getStepPodName(), container, extension)
  } catch (err) {
    core.debug(`createJob failed: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to run script step: ${message}`)
  }

  if (!pod.metadata?.name) {
    throw new Error(
      `Expected job ${JSON.stringify(
        pod
      )} to have correctly set the metadata.name`
    )
  }
  const podName = pod.metadata.name

  try {
    await waitForPodPhases(
      podName,
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING, PodPhase.UNKNOWN]),
      getPrepareJobTimeoutSeconds()
    )

    const runnerWorkspace = dirname(process.env.RUNNER_WORKSPACE as string)
    const githubWorkspace = process.env.GITHUB_WORKSPACE as string
    const parts = githubWorkspace.split('/').slice(-2)
    if (parts.length !== 2) {
      throw new Error(`Invalid github workspace directory: ${githubWorkspace}`)
    }
    const relativeWorkspace = parts.join('/')

    core.debug(
      `Copying files from pod ${getJobPodName()} to ${runnerWorkspace}/${relativeWorkspace}`
    )
    await execCpFromPod(getJobPodName(), `/__w`, `${runnerWorkspace}`)

    const { containerPath, runnerPath } = writeContainerStepScript(
      `${runnerWorkspace}/__w/_temp`,
      githubWorkspace,
      stepContainer.entryPoint,
      stepContainer.entryPointArgs,
      envs
    )

    await execCpToPod(podName, `${runnerWorkspace}/__w`, '/__w')

    fs.rmSync(`${runnerWorkspace}/__w`, { recursive: true, force: true })

    try {
      core.debug(`Executing container step script in pod ${podName}`)
      const { code, output } = await execPodStepWithOutput(
        ['sh', '-e', containerPath],
        pod.metadata.name,
        JOB_CONTAINER_NAME
      )
      if (code === 0) {
        return 0
      }
      // Non-zero exit: surface a structured error so the user can tell whether
      // it was their script or the container that failed. Read container
      // status BEFORE deletePod runs (in the outer finally) to inspect the
      // terminated reason, if it is already available.
      const classification = await classifyScriptError(
        pod.metadata.name,
        code,
        stepContainer.entryPoint,
        output
      )
      throw new Error(classification)
    } catch (err) {
      core.debug(`execPodStep failed: ${JSON.stringify(err)}`)
      // Re-throw our own classified errors verbatim; wrap anything else.
      if (
        err instanceof Error &&
        (err.message.startsWith('Step failed:') ||
          err.message.startsWith('failed to run script step'))
      ) {
        throw err
      }
      const message = (err as any)?.response?.body?.message || err
      throw new Error(`failed to run script step: ${message}`)
    } finally {
      fs.rmSync(runnerPath, { force: true })
    }
  } catch (error) {
    try {
      const pod = await getPodByName(podName)
      const terminatedErrors = getContainerTerminatedErrors(pod)
      if (terminatedErrors.length > 0) {
        const details = await describePodFailure(podName)
        core.error(
          `Pod ${podName} has unrecoverable container errors:\n${terminatedErrors.join('\n')}\n${details}`
        )
      }
    } catch {
      // Best-effort: pod may already be deleted or unreachable
    }
    core.error(`Failed to run container step: ${error}`)
    throw error
  } finally {
    await deletePod(podName).catch(err => {
      core.error(`Failed to delete step pod ${podName}: ${err}`)
    })
  }
}

// Inspect the pod's container status to determine whether a non-zero exit
// code came from the user's script (container terminated cleanly with
// reason=Completed) or from a container-level failure (OOMKilled, segfault,
// etc.). The container state may not yet be 'terminated' when this is called
// (k8s updates it asynchronously after the process exits), so we treat any
// state where we cannot positively confirm a container-level failure as a
// script issue and let the user re-check their script first.
async function classifyScriptError(
  podName: string,
  exitCode: number,
  entryPoint: string,
  tailOutput: string
): Promise<string> {
  const lines: string[] = [
    `Step failed: script execution (exit code ${exitCode})`,
    `  entryPoint: ${entryPoint}`
  ]

  let containerHint = '  container: state unavailable — likely a script issue'
  try {
    const pod = await getPodByName(podName)
    const cs = pod.status?.containerStatuses?.find(
      s => s.name === JOB_CONTAINER_NAME
    )
    const term = cs?.state?.terminated
    if (term) {
      const reason = term.reason ?? 'Completed'
      const isContainerFault =
        reason === 'OOMKilled' ||
        reason === 'Error' ||
        reason === 'FailedPostStartHookError' ||
        (term.exitCode === 137 && reason !== 'Completed')
      if (isContainerFault) {
        containerHint = `  container: terminated: ${reason} (exit code ${term.exitCode}) — container-level failure, not your script`
      } else {
        containerHint = `  container: terminated: ${reason} (exit code ${term.exitCode}) — container exited cleanly, your script returned a non-zero code`
      }
    } else if (cs?.state?.waiting) {
      containerHint = `  container: waiting: ${cs.state.waiting.reason ?? 'unknown'} — container-level issue`
    } else if (cs?.state?.running) {
      containerHint =
        '  container: still running — script may have backgrounded a process; check your script'
    }
  } catch {
    // pod already gone or API error; keep the default hint
  }
  lines.push(containerHint)

  if (tailOutput) {
    lines.push('  last output:')
    for (const outLine of tailOutput.split('\n')) {
      lines.push(`    ${outLine}`)
    }
  }
  return lines.join('\n')
}

function createContainerSpec(
  container: RunContainerStepArgs,
  extension?: k8s.V1PodTemplateSpec
): k8s.V1Container {
  const podContainer = new k8s.V1Container()
  podContainer.name = JOB_CONTAINER_NAME
  podContainer.image = container.image
  podContainer.workingDir = '/__w'
  podContainer.command = ['tail']
  podContainer.args = DEFAULT_CONTAINER_ENTRY_POINT_ARGS

  podContainer.volumeMounts = CONTAINER_VOLUMES

  if (!extension) {
    return podContainer
  }

  const from = extension.spec?.containers?.find(
    c => c.name === JOB_CONTAINER_EXTENSION_NAME
  )
  if (from) {
    mergeContainerWithOptions(podContainer, from)
  }

  return podContainer
}
