import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import {
  JobContainerInfo,
  ContextPorts,
  PrepareJobArgs,
  writeToResponseFile,
  ServiceContainerInfo
} from 'hooklib'
import {
  containerPorts,
  createJobPod,
  isPodContainerAlpine,
  prunePods,
  waitForPodPhases,
  getPrepareJobTimeoutSeconds,
  execCpToPod,
  execPodStep
} from '../k8s'
import {
  CONTAINER_VOLUMES,
  DEFAULT_CONTAINER_ENTRY_POINT,
  DEFAULT_CONTAINER_ENTRY_POINT_ARGS,
  generateContainerName,
  mergeContainerWithOptions,
  readExtensionFromFile,
  PodPhase,
  fixArgs,
  prepareJobScript
} from '../k8s/utils'
import {
  CONTAINER_EXTENSION_PREFIX,
  getJobPodName,
  JOB_CONTAINER_NAME
} from './constants'
import { dirname } from 'path'

export async function prepareJob(
  args: PrepareJobArgs,
  responseFile
): Promise<void> {
  core.debug('[prepareJob] Step 1: validating args.container')
  if (!args.container) {
    throw new Error('Job Container is required.')
  }
  core.debug(
    `[prepareJob] container image: ${args.container.image}, services: ${args.services?.length ?? 0}`
  )

  core.debug('[prepareJob] Step 2: pruning stale pods')
  await prunePods()
  core.debug('[prepareJob] Step 2: prunePods done')

  core.debug('[prepareJob] Step 3: reading extension from file')
  const extension = readExtensionFromFile()
  core.debug(
    `[prepareJob] Step 3: extension loaded: ${extension ? 'yes' : 'none'}`
  )

  core.debug('[prepareJob] Step 4: building main container spec')
  let container: k8s.V1Container | undefined = undefined
  if (args.container?.image) {
    container = createContainerSpec(
      args.container,
      JOB_CONTAINER_NAME,
      true,
      extension
    )
    core.debug(`[prepareJob] Step 4: main container spec built: ${container.name}, image: ${container.image}`)
  } else {
    core.debug('[prepareJob] Step 4: no image specified, skipping main container')
  }

  core.debug('[prepareJob] Step 5: building service container specs')
  let services: k8s.V1Container[] = []
  if (args.services?.length) {
    services = args.services.map(service => {
      const spec = createContainerSpec(
        service,
        generateContainerName(service.image),
        false,
        extension
      )
      core.debug(`[prepareJob] Step 5: service container spec built: ${spec.name}, image: ${spec.image}`)
      return spec
    })
  } else {
    core.debug('[prepareJob] Step 5: no services')
  }

  if (!container && !services?.length) {
    throw new Error('No containers exist, skipping hook invocation')
  }

  core.debug(`[prepareJob] Step 6: creating job pod (name: ${getJobPodName()})`)
  let createdPod: k8s.V1Pod | undefined = undefined
  try {
    createdPod = await createJobPod(
      getJobPodName(),
      container,
      services,
      args.container.registry,
      extension
    )
    core.debug(`[prepareJob] Step 6: job pod created: ${createdPod?.metadata?.name}`)
  } catch (err) {
    await prunePods()
    core.debug(`[prepareJob] Step 6 FAILED — createPod error: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to create job pod: ${message}`)
  }

  if (!createdPod?.metadata?.name) {
    throw new Error('created pod should have metadata.name')
  }

  const podName = createdPod.metadata.name
  const timeoutSecs = getPrepareJobTimeoutSeconds()
  core.debug(
    `[prepareJob] Step 7: waiting for pod "${podName}" to reach RUNNING phase (timeout: ${timeoutSecs}s)`
  )
  try {
    await waitForPodPhases(
      podName,
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      timeoutSecs
    )
    core.debug(`[prepareJob] Step 7: pod "${podName}" is RUNNING`)
  } catch (err) {
    await prunePods()
    throw new Error(`pod failed to come online with error: ${err}`)
  }

  const runnerWorkspace = dirname(process.env.RUNNER_WORKSPACE as string)
  core.debug(
    `[prepareJob] Step 8: copying runnerWorkspace "${runnerWorkspace}" to pod "${podName}" at /__w`
  )
  try {
    await execCpToPod(podName, runnerWorkspace, '/__w')
    core.debug('[prepareJob] Step 8: copy to /__w done')
  } catch (err) {
    core.debug(`[prepareJob] Step 8 FAILED — execCpToPod error: ${JSON.stringify(err)}`)
    throw new Error(`failed to copy runner workspace to pod: ${err}`)
  }

  let prepareScript: { containerPath: string; runnerPath: string } | undefined
  if (args.container?.userMountVolumes?.length) {
    core.debug(
      `[prepareJob] Step 9: generating prepareJobScript for ${args.container.userMountVolumes.length} userMountVolumes`
    )
    prepareScript = prepareJobScript(args.container.userMountVolumes || [])
    core.debug(
      `[prepareJob] Step 9: prepareScript containerPath: ${prepareScript.containerPath}`
    )
  } else {
    core.debug('[prepareJob] Step 9: no userMountVolumes, skipping prepareScript')
  }

  if (prepareScript) {
    core.debug(
      `[prepareJob] Step 10: executing prepareScript in pod "${podName}" container "${JOB_CONTAINER_NAME}"`
    )
    try {
      await execPodStep(
        ['sh', '-e', prepareScript.containerPath],
        podName,
        JOB_CONTAINER_NAME
      )
      core.debug('[prepareJob] Step 10: prepareScript execution done')
    } catch (err) {
      core.debug(`[prepareJob] Step 10 FAILED — execPodStep error: ${JSON.stringify(err)}`)
      throw new Error(`failed to execute prepareScript in pod: ${err}`)
    }

    core.debug('[prepareJob] Step 11: copying userMountVolumes to pod')
    const promises: Promise<void>[] = []
    for (const vol of args?.container?.userMountVolumes || []) {
      core.debug(
        `[prepareJob] Step 11: copying "${vol.sourceVolumePath}" -> "${vol.targetVolumePath}"`
      )
      promises.push(
        execCpToPod(
          podName,
          vol.sourceVolumePath,
          vol.targetVolumePath
        ).catch(err => {
          core.debug(
            `[prepareJob] Step 11 FAILED — copy "${vol.sourceVolumePath}" -> "${vol.targetVolumePath}": ${JSON.stringify(err)}`
          )
          throw new Error(
            `failed to copy volume "${vol.sourceVolumePath}" to pod: ${err}`
          )
        })
      )
    }
    await Promise.all(promises)
    core.debug('[prepareJob] Step 11: all userMountVolumes copied')
  }

  core.debug('[prepareJob] Step 12: pod is ready for traffic')

  core.debug(
    `[prepareJob] Step 13: checking if container "${JOB_CONTAINER_NAME}" in pod "${podName}" is Alpine`
  )
  let isAlpine = false
  try {
    isAlpine = await isPodContainerAlpine(podName, JOB_CONTAINER_NAME)
    core.debug(`[prepareJob] Step 13: isAlpine = ${isAlpine}`)
  } catch (err) {
    core.debug(
      `[prepareJob] Step 13 FAILED — isPodContainerAlpine error: ${JSON.stringify(err)}`
    )
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to determine if the pod is alpine: ${message}`)
  }

  core.debug(`[prepareJob] Step 14: writing response file "${responseFile}"`)
  generateResponseFile(responseFile, args, createdPod, isAlpine)
  core.debug('[prepareJob] Step 14: response file written — prepareJob complete')
}

function generateResponseFile(
  responseFile: string,
  args: PrepareJobArgs,
  appPod: k8s.V1Pod,
  isAlpine: boolean
): void {
  if (!appPod.metadata?.name) {
    throw new Error('app pod must have metadata.name specified')
  }
  const response = {
    state: {
      jobPod: appPod.metadata.name
    },
    context: {},
    isAlpine
  }

  const mainContainer = appPod.spec?.containers?.find(
    c => c.name === JOB_CONTAINER_NAME
  )
  if (mainContainer) {
    const mainContainerContextPorts: ContextPorts = {}
    if (mainContainer?.ports) {
      for (const port of mainContainer.ports) {
        mainContainerContextPorts[port.containerPort] =
          mainContainerContextPorts.hostPort
      }
    }

    response.context['container'] = {
      image: mainContainer.image,
      ports: mainContainerContextPorts
    }
  }

  if (args.services?.length) {
    const serviceContainerNames =
      args.services?.map(s => generateContainerName(s.image)) || []

    response.context['services'] = appPod?.spec?.containers
      ?.filter(c => serviceContainerNames.includes(c.name))
      .map(c => {
        const ctxPorts: ContextPorts = {}
        if (c.ports?.length) {
          for (const port of c.ports) {
            if (port.containerPort && port.hostPort) {
              ctxPorts[port.containerPort.toString()] = port.hostPort.toString()
            }
          }
        }

        return {
          image: c.image,
          ports: ctxPorts
        }
      })
  }

  writeToResponseFile(responseFile, JSON.stringify(response))
}

export function createContainerSpec(
  container: JobContainerInfo | ServiceContainerInfo,
  name: string,
  jobContainer = false,
  extension?: k8s.V1PodTemplateSpec
): k8s.V1Container {
  if (!container.entryPoint && jobContainer) {
    container.entryPoint = DEFAULT_CONTAINER_ENTRY_POINT
    container.entryPointArgs = DEFAULT_CONTAINER_ENTRY_POINT_ARGS
  }

  const podContainer = {
    name,
    image: container.image,
    ports: containerPorts(container)
  } as k8s.V1Container
  if (container['workingDirectory']) {
    podContainer.workingDir = container['workingDirectory']
  }

  if (container.entryPoint) {
    podContainer.command = [container.entryPoint]
  }

  if (container.entryPointArgs && container.entryPointArgs.length > 0) {
    podContainer.args = fixArgs(container.entryPointArgs)
  }

  podContainer.env = []
  for (const [key, value] of Object.entries(
    container['environmentVariables'] || {}
  )) {
    if (value && key !== 'HOME') {
      podContainer.env.push({ name: key, value })
    }
  }

  podContainer.env.push({
    name: 'GITHUB_ACTIONS',
    value: 'true'
  })

  if (!('CI' in (container['environmentVariables'] || {}))) {
    podContainer.env.push({
      name: 'CI',
      value: 'true'
    })
  }

  podContainer.volumeMounts = CONTAINER_VOLUMES

  if (!extension) {
    return podContainer
  }

  const from = extension.spec?.containers?.find(
    c => c.name === CONTAINER_EXTENSION_PREFIX + name
  )

  if (from) {
    mergeContainerWithOptions(podContainer, from)
  }

  return podContainer
}
