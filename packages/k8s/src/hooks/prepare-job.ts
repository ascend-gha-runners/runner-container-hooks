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
  if (!args.container) {
    throw new Error('Job Container is required.')
  }

  await prunePods()

  const extension = readExtensionFromFile()

  let container: k8s.V1Container | undefined = undefined
  if (args.container?.image) {
    container = createContainerSpec(
      args.container,
      JOB_CONTAINER_NAME,
      true,
      extension
    )
  }

  let services: k8s.V1Container[] = []
  if (args.services?.length) {
    services = args.services.map(service => {
      return createContainerSpec(
        service,
        generateContainerName(service.image),
        false,
        extension
      )
    })
  }

  if (!container && !services?.length) {
    throw new Error('No containers exist, skipping hook invocation')
  }

  let createdPod: k8s.V1Pod | undefined = undefined
  try {
    createdPod = await createJobPod(
      getJobPodName(),
      container,
      services,
      args.container.registry,
      extension
    )
  } catch (err) {
    await prunePods()
    core.debug(`createPod failed: ${JSON.stringify(err)}`)
    // The k8s client throws HttpException whose message is a multi-line string
    // containing the raw HTTP dump. Extract the human-readable "message" field
    // from the embedded JSON body so the log shows something like:
    //   failed to create job pod:
    //     spec.volumes[5].name: Duplicate value: "bad-hostpath"
    // instead of the full HTTP dump.
    const raw = err instanceof Error ? err.message : String(err)
    let detail = raw
    // The k8s HttpException message is a multi-line dump:
    //   HTTP-Code: 422
    //   Message: Unknown API Status Code!
    //   Body: "{\"kind\":\"Status\",\"message\":\"...\\n\"}"
    //   Headers: {...}
    // Extract the Body JSON string, unescape it, and pull out "message".
    try {
      const bodyStart = raw.indexOf('Body: "')
      // The boundary may be '"\nHeaders:' (real newline) or the literal
      // string ends before Headers — use the last '"' before 'Headers:' as fallback
      const headersIdx = raw.indexOf('Headers:')
      const bodyEnd = headersIdx !== -1
        ? raw.lastIndexOf('"', headersIdx)   // last " before Headers:
        : raw.indexOf('"\nHeaders:')
      if (bodyStart !== -1 && bodyEnd !== -1 && bodyEnd > bodyStart) {
        // Body content is a JSON string literal (without surrounding quotes).
        // Wrap it in quotes and JSON.parse to properly unescape \" \\ \n \t etc.
        const escaped = raw.substring(bodyStart + 7, bodyEnd)
        const bodyStr = JSON.parse('"' + escaped + '"')
        // bodyStr may be plain text (e.g. 502 Bad Gateway) instead of JSON.
        // Parse separately so a non-JSON body still yields a friendly message.
        try {
          const parsed = JSON.parse(bodyStr)
          if (typeof parsed?.message === 'string') {
            detail = parsed.message
          }
        } catch {
          detail = bodyStr
        }
      }
    } catch {
      // Parsing failed — fall through and show the raw string
    }
    throw new Error(
      `failed to create job pod:\n  ✗ ${detail}\n${'─'.repeat(60)}\n  → Pod spec was rejected by the k8s API. Check:\n    - resources.requests does not exceed resources.limits\n    - volumeMounts reference a volume defined in spec.volumes\n    - envFrom / valueFrom reference existing Secrets / ConfigMaps\n    - Field types match the k8s schema (kubectl explain pod.spec.containers)`
    )
  }

  if (!createdPod?.metadata?.name) {
    throw new Error('created pod should have metadata.name')
  }
  core.debug(
    `Job pod created, waiting for it to come online ${createdPod?.metadata?.name}`
  )

  const runnerWorkspace = dirname(process.env.RUNNER_WORKSPACE as string)

  let prepareScript: { containerPath: string; runnerPath: string } | undefined
  if (args.container?.userMountVolumes?.length) {
    prepareScript = prepareJobScript(args.container.userMountVolumes || [])
  }

  try {
    await waitForPodPhases(
      createdPod.metadata.name,
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      getPrepareJobTimeoutSeconds()
    )
  } catch (err) {
    await prunePods()
    // Unwrap nested "Error: " prefix so the message renders as:
    //   pod failed to come online:
    //   <detail from waitForPodPhases, already formatted with sections>
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`pod failed to come online:\n${detail}`)
  }

  await execCpToPod(createdPod.metadata.name, runnerWorkspace, '/__w')

  if (prepareScript) {
    await execPodStep(
      ['sh', '-e', prepareScript.containerPath],
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )

    const promises: Promise<void>[] = []
    for (const vol of args?.container?.userMountVolumes || []) {
      promises.push(
        execCpToPod(
          createdPod.metadata.name,
          vol.sourceVolumePath,
          vol.targetVolumePath
        )
      )
    }
    await Promise.all(promises)
  }

  core.debug('Job pod is ready for traffic')

  let isAlpine = false
  try {
    isAlpine = await isPodContainerAlpine(
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    core.debug(
      `Failed to determine if the pod is alpine: ${JSON.stringify(err)}`
    )
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to determine if the pod is alpine: ${message}`)
  }
  core.debug(`Setting isAlpine to ${isAlpine}`)
  generateResponseFile(responseFile, args, createdPod, isAlpine)
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
