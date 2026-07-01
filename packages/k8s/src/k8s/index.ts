import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import { ContainerInfo, Registry } from 'hooklib'
import * as stream from 'stream'
import {
  getJobPodName,
  getRunnerPodName,
  getSecretName,
  getStepPodName,
  getVolumeClaimName,
  RunnerInstanceLabel
} from '../hooks/constants'
import {
  PodPhase,
  mergePodSpecWithOptions,
  mergeObjectMeta,
  useKubeScheduler,
  fixArgs
} from './utils'

const kc = new k8s.KubeConfig()

kc.loadFromDefault()

const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
const k8sBatchV1Api = kc.makeApiClient(k8s.BatchV1Api)
const k8sAuthorizationV1Api = kc.makeApiClient(k8s.AuthorizationV1Api)

const DEFAULT_WAIT_FOR_POD_TIME_SECONDS = 10 * 60 // 10 min

export const POD_VOLUME_NAME = 'work'

export const requiredPermissions = [
  {
    group: '',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'pods',
    subresource: ''
  },
  {
    group: '',
    verbs: ['get', 'create'],
    resource: 'pods',
    subresource: 'exec'
  },
  {
    group: '',
    verbs: ['get', 'list', 'watch'],
    resource: 'pods',
    subresource: 'log'
  },
  {
    group: 'batch',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'jobs',
    subresource: ''
  },
  {
    group: '',
    verbs: ['create', 'delete', 'get', 'list'],
    resource: 'secrets',
    subresource: ''
  }
]

export async function createPod(
  jobContainer?: k8s.V1Container,
  services?: k8s.V1Container[],
  registry?: Registry,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const containers: k8s.V1Container[] = []
  if (jobContainer) {
    containers.push(jobContainer)
  }
  if (services?.length) {
    containers.push(...services)
  }

  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = getJobPodName()

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = containers
  appPod.spec.restartPolicy = 'Never'

  const nodeName = await getCurrentNodeName()
  if (useKubeScheduler()) {
    appPod.spec.affinity = await getPodAffinity(nodeName)
  } else {
    appPod.spec.affinity = await getPreferredPodAffinity(nodeName)
  }
  const claimName = getVolumeClaimName()
  appPod.spec.volumes = [
    {
      name: 'work',
      persistentVolumeClaim: { claimName }
    }
  ]

  if (registry) {
    const secret = await createDockerSecret(registry)
    if (!secret?.metadata?.name) {
      throw new Error(`created secret does not have secret.metadata.name`)
    }
    const secretReference = new k8s.V1LocalObjectReference()
    secretReference.name = secret.metadata.name
    appPod.spec.imagePullSecrets = [secretReference]
  }

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  const { body } = await k8sApi.createNamespacedPod(namespace(), appPod)
  return body
}

export async function createJob(
  container: k8s.V1Container,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Job> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const job = new k8s.V1Job()
  job.apiVersion = 'batch/v1'
  job.kind = 'Job'
  job.metadata = new k8s.V1ObjectMeta()
  job.metadata.name = getStepPodName()
  job.metadata.labels = { [runnerInstanceLabel.key]: runnerInstanceLabel.value }
  job.metadata.annotations = {}

  job.spec = new k8s.V1JobSpec()
  job.spec.ttlSecondsAfterFinished = 300
  job.spec.backoffLimit = 0
  job.spec.template = new k8s.V1PodTemplateSpec()

  job.spec.template.spec = new k8s.V1PodSpec()
  job.spec.template.metadata = new k8s.V1ObjectMeta()
  job.spec.template.metadata.labels = {}
  job.spec.template.metadata.annotations = {}
  job.spec.template.spec.containers = [container]
  job.spec.template.spec.restartPolicy = 'Never'

  const nodeName = await getCurrentNodeName()
  if (useKubeScheduler()) {
    job.spec.template.spec.affinity = await getPodAffinity(nodeName)
  } else {
    job.spec.template.spec.affinity = await getPreferredPodAffinity(nodeName)
  }

  const claimName = getVolumeClaimName()
  job.spec.template.spec.volumes = [
    {
      name: 'work',
      persistentVolumeClaim: { claimName }
    }
  ]

  if (extension) {
    if (extension.metadata) {
      // apply metadata both to the job and the pod created by the job
      mergeObjectMeta(job, extension.metadata)
      mergeObjectMeta(job.spec.template, extension.metadata)
    }
    if (extension.spec) {
      mergePodSpecWithOptions(job.spec.template.spec, extension.spec)
    }
  }

  const { body } = await k8sBatchV1Api.createNamespacedJob(namespace(), job)
  return body
}

export async function getContainerJobPodName(jobName: string): Promise<string> {
  const selector = `job-name=${jobName}`
  const backOffManager = new BackOffManager(60)
  while (true) {
    const podList = await k8sApi.listNamespacedPod(
      namespace(),
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
      1
    )

    if (!podList.body.items?.length) {
      await backOffManager.backOff()
      continue
    }

    if (!podList.body.items[0].metadata?.name) {
      throw new Error(
        `Failed to determine the name of the pod for job ${jobName}`
      )
    }
    return podList.body.items[0].metadata.name
  }
}

export async function deletePod(podName: string): Promise<void> {
  await k8sApi.deleteNamespacedPod(
    podName,
    namespace(),
    undefined,
    undefined,
    0
  )
}

export async function execPodStep(
  command: string[],
  podName: string,
  containerName: string,
  stdin?: stream.Readable
): Promise<void> {
  const exec = new k8s.Exec(kc)
  command = fixArgs(command)
  // Exec returns a websocket. If websocket fails, we should reject the promise. Otherwise, websocket will call a callback. Since at that point, websocket is not failing, we can safely resolve or reject the promise.
  await new Promise(function (resolve, reject) {
    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        process.stdout,
        process.stderr,
        stdin ?? null,
        false /* tty */,
        resp => {
          // kube.exec returns an error if exit code is not 0, but we can't actually get the exit code
          if (resp.status === 'Success') {
            resolve(resp.code)
          } else {
            core.debug(
              JSON.stringify({
                message: resp?.message,
                details: resp?.details
              })
            )
            reject(resp?.message)
          }
        }
      )
      // If exec.exec fails, explicitly reject the outer promise
      // eslint-disable-next-line github/no-then
      .catch(e => reject(e))
  })
}

export async function waitForJobToComplete(jobName: string): Promise<void> {
  const backOffManager = new BackOffManager()
  while (true) {
    try {
      if (await isJobSucceeded(jobName)) {
        return
      }
    } catch (error) {
      throw new Error(`job ${jobName} has failed`)
    }
    await backOffManager.backOff()
  }
}

export async function createDockerSecret(
  registry: Registry
): Promise<k8s.V1Secret> {
  const authContent = {
    auths: {
      [registry.serverUrl || 'https://index.docker.io/v1/']: {
        username: registry.username,
        password: registry.password,
        auth: Buffer.from(`${registry.username}:${registry.password}`).toString(
          'base64'
        )
      }
    }
  }

  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secretName = getSecretName()
  const secret = new k8s.V1Secret()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName
  secret.metadata.namespace = namespace()
  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.type = 'kubernetes.io/dockerconfigjson'
  secret.kind = 'Secret'
  secret.data = {
    '.dockerconfigjson': Buffer.from(JSON.stringify(authContent)).toString(
      'base64'
    )
  }

  const { body } = await k8sApi.createNamespacedSecret(namespace(), secret)
  return body
}

export async function createSecretForEnvs(envs: {
  [key: string]: string
}): Promise<string> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secret = new k8s.V1Secret()
  const secretName = getSecretName()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName

  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.kind = 'Secret'
  secret.data = {}
  for (const [key, value] of Object.entries(envs)) {
    secret.data[key] = Buffer.from(value).toString('base64')
  }

  await k8sApi.createNamespacedSecret(namespace(), secret)
  return secretName
}

export async function deleteSecret(secretName: string): Promise<void> {
  await k8sApi.deleteNamespacedSecret(secretName, namespace())
}

export async function pruneSecrets(): Promise<void> {
  const secretList = await k8sApi.listNamespacedSecret(
    namespace(),
    undefined,
    undefined,
    undefined,
    undefined,
    new RunnerInstanceLabel().toString()
  )
  if (!secretList.body.items.length) {
    return
  }

  await Promise.all(
    secretList.body.items.map(
      secret => secret.metadata?.name && deleteSecret(secret.metadata.name)
    )
  )
}

export const UNRECOVERABLE_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'FailedMount'
])

export const UNRECOVERABLE_EVENT_REASONS = new Set([
  'FailedScheduling',
  'FailedBinding',
  'FailedMount'
])

export const UNRECOVERABLE_TERMINATED_REASONS = new Set([
  'OOMKilled',
  'Error',
  'FailedPostStartHookError'
])

const MAX_DIAGNOSTIC_EVENTS = 10

export function getUnrecoverableWaitingReasons(): Set<string> {
  const extra = process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS']
  if (!extra) {
    return UNRECOVERABLE_WAITING_REASONS
  }
  const reasons = new Set(UNRECOVERABLE_WAITING_REASONS)
  for (const reason of extra.split(',')) {
    const trimmed = reason.trim()
    if (trimmed) {
      reasons.add(trimmed)
    }
  }
  return reasons
}

export function getUnrecoverableEventReasons(): Set<string> {
  const extra = process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_EVENT_REASONS']
  if (!extra) {
    return UNRECOVERABLE_EVENT_REASONS
  }
  const reasons = new Set(UNRECOVERABLE_EVENT_REASONS)
  for (const reason of extra.split(',')) {
    const trimmed = reason.trim()
    if (trimmed) {
      reasons.add(trimmed)
    }
  }
  return reasons
}

export function getUnrecoverableTerminatedReasons(): Set<string> {
  const extra =
    process.env['ACTIONS_RUNNER_K8S_UNRECOVERABLE_TERMINATED_REASONS']
  if (!extra) {
    return UNRECOVERABLE_TERMINATED_REASONS
  }
  const reasons = new Set(UNRECOVERABLE_TERMINATED_REASONS)
  for (const reason of extra.split(',')) {
    const trimmed = reason.trim()
    if (trimmed) {
      reasons.add(trimmed)
    }
  }
  return reasons
}

export function getContainerErrors(pod: k8s.V1Pod): string[] {
  const errors: string[] = []
  const unrecoverableReasons = getUnrecoverableWaitingReasons()
  const allStatuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? [])
  ]
  for (const cs of allStatuses) {
    const waiting = cs.state?.waiting
    if (waiting?.reason && unrecoverableReasons.has(waiting.reason)) {
      errors.push(
        `container "${cs.name}": ${waiting.reason}${
          waiting.message ? ` - ${waiting.message}` : ''
        }`
      )
    }
  }
  return errors
}

export async function getPodEventErrors(podName: string): Promise<string[]> {
  const unrecoverableReasons = getUnrecoverableEventReasons()
  let items: k8s.CoreV1Event[]
  try {
    const { body } = await k8sApi.listNamespacedEvent(
      namespace(),
      undefined,
      undefined,
      undefined,
      `involvedObject.name=${podName}`
    )
    items = body.items
  } catch (err) {
    core.debug(
      `Could not list events for pod ${podName} (the 'events' permission may be missing): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return []
  }

  const errors: string[] = []
  for (const e of items) {
    if (
      e.type === 'Warning' &&
      e.reason &&
      unrecoverableReasons.has(e.reason)
    ) {
      errors.push(`Event [Warning] ${e.reason}: ${e.message ?? ''}`)
    }
  }
  return errors
}

export function getPodConditionErrors(pod: k8s.V1Pod): string[] {
  const errors: string[] = []
  for (const cond of pod.status?.conditions ?? []) {
    if (cond.status === 'False') {
      errors.push(
        `Condition ${cond.type}=False (reason: ${cond.reason ?? ''}): ${
          cond.message ?? ''
        }`
      )
    }
  }
  return errors
}

export function getContainerTerminatedErrors(pod: k8s.V1Pod): string[] {
  const errors: string[] = []
  const unrecoverableReasons = getUnrecoverableTerminatedReasons()
  const allStatuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? [])
  ]
  for (const cs of allStatuses) {
    const terminated = cs.state?.terminated
    if (terminated?.reason && unrecoverableReasons.has(terminated.reason)) {
      errors.push(
        `container "${cs.name}": ${terminated.reason} (exit code ${terminated.exitCode}) - ${
          terminated.message ?? ''
        }`
      )
    }
  }
  return errors
}

export async function describePodFailure(podName: string): Promise<string> {
  let pod: k8s.V1Pod
  try {
    pod = await readPod(podName)
  } catch (err) {
    return `Could not read pod ${podName} for diagnostics: ${
      err instanceof Error ? err.message : String(err)
    }`
  }

  const lines: string[] = []
  const status = pod.status

  if (status?.phase) {
    lines.push(
      `Phase: ${status.phase}${
        status.reason ? ` (reason: ${status.reason})` : ''
      }`
    )
  }
  if (status?.message) {
    lines.push(`Message: ${status.message}`)
  }

  const separator = '────────────────────────────────────────────────────────────'
  lines.push(separator)

  for (const cond of status?.conditions ?? []) {
    if (cond.status === 'False') {
      lines.push(
        `  ✗ ${cond.type}=False${
          cond.reason ? ` (${cond.reason})` : ''
        }${cond.message ? `: ${cond.message}` : ''}`
      )
    }
  }

  const allStatuses = [
    ...(status?.initContainerStatuses ?? []),
    ...(status?.containerStatuses ?? [])
  ]
  for (const cs of allStatuses) {
    const waiting = cs.state?.waiting
    if (waiting?.reason) {
      lines.push(
        `  ✗ container "${cs.name}": ${waiting.reason}${
          waiting.message ? `\n    ${waiting.message}` : ''
        }`
      )
    }
    const terminated = cs.state?.terminated
    if (terminated) {
      lines.push(
        `  ✗ container "${cs.name}": ${
          terminated.reason ?? 'Unknown'
        } (exit code ${terminated.exitCode})${
          terminated.message ? `\n    ${terminated.message}` : ''
        }`
      )
    }
  }

  lines.push(...(await describePodWarningEvents(podName)))

  if (!lines.length) {
    return `No additional diagnostic information available for pod ${podName}`
  }
  return lines.join('\n')
}

async function describePodWarningEvents(podName: string): Promise<string[]> {
  let items: k8s.CoreV1Event[]
  try {
    const { body } = await k8sApi.listNamespacedEvent(
      namespace(),
      undefined,
      undefined,
      undefined,
      `involvedObject.name=${podName}`
    )
    items = body.items
  } catch (err) {
    core.debug(
      `Could not list events for pod ${podName} (the 'events' permission may be missing): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return []
  }

  const warnings = items.filter(e => e.type === 'Warning')
  if (!warnings.length) {
    return []
  }

  const eventTime = (e: k8s.CoreV1Event): number => {
    const t = e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp
    return t ? new Date(t).getTime() : 0
  }
  warnings.sort((a, b) => eventTime(a) - eventTime(b))

  const recent = warnings.slice(-MAX_DIAGNOSTIC_EVENTS)
  const lines = recent.map(e => {
    const count = e.count && e.count > 1 ? ` (x${e.count})` : ''
    return `Event [Warning] ${e.reason ?? ''}${count}: ${
      e.message ?? ''
    }`.trim()
  })
  if (warnings.length > recent.length) {
    lines.unshift(
      `(showing ${recent.length} of ${warnings.length} warning events)`
    )
  }
  return lines
}

export async function waitForPodPhases(
  podName: string,
  awaitingPhases: Set<PodPhase>,
  backOffPhases: Set<PodPhase>,
  maxTimeSeconds = DEFAULT_WAIT_FOR_POD_TIME_SECONDS
): Promise<void> {
  const backOffManager = new BackOffManager(maxTimeSeconds)
  let phase: PodPhase = PodPhase.UNKNOWN
  while (true) {
    const pod = await readPod(podName)
    phase = parsePodPhase(pod)
    if (awaitingPhases.has(phase)) {
      return
    }

    if (!backOffPhases.has(phase)) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} is unhealthy with phase status ${phase}\n${details}`
      )
    }

    const containerErrors = getContainerErrors(pod)
    if (containerErrors.length > 0) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} has unrecoverable container errors: ${containerErrors.join(
          '; '
        )}\n${details}`
      )
    }

    const conditionErrors = getPodConditionErrors(pod)
    if (conditionErrors.length > 0) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} has unrecoverable condition errors: ${conditionErrors.join(
          '; '
        )}\n${details}`
      )
    }

    const eventErrors = await getPodEventErrors(podName)
    if (eventErrors.length > 0) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} has unrecoverable event errors: ${eventErrors.join(
          '; '
        )}\n${details}`
      )
    }

    try {
      await backOffManager.backOff()
    } catch (error) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} is unhealthy: timed out after ${maxTimeSeconds}s in phase ${phase}\n${details}`
      )
    }
  }
}

export function getPrepareJobTimeoutSeconds(): number {
  const envTimeoutSeconds =
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS']

  if (!envTimeoutSeconds) {
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  const timeoutSeconds = parseInt(envTimeoutSeconds, 10)
  if (!timeoutSeconds || timeoutSeconds <= 0) {
    core.warning(
      `Prepare job timeout is invalid ("${timeoutSeconds}"): use an int > 0`
    )
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  return timeoutSeconds
}

async function readPod(podName: string): Promise<k8s.V1Pod> {
  const { body } = await k8sApi.readNamespacedPod(podName, namespace())
  return body
}

const podPhaseLookup = new Set<string>([
  PodPhase.PENDING,
  PodPhase.RUNNING,
  PodPhase.SUCCEEDED,
  PodPhase.FAILED,
  PodPhase.UNKNOWN
])

export function parsePodPhase(pod: k8s.V1Pod): PodPhase {
  if (!pod.status?.phase || !podPhaseLookup.has(pod.status.phase)) {
    return PodPhase.UNKNOWN
  }
  return pod.status.phase as PodPhase
}

async function isJobSucceeded(jobName: string): Promise<boolean> {
  const { body } = await k8sBatchV1Api.readNamespacedJob(jobName, namespace())
  const job = body
  if (job.status?.failed) {
    throw new Error(`job ${jobName} has failed`)
  }
  return !!job.status?.succeeded
}

export async function getPodLogs(
  podName: string,
  containerName: string
): Promise<void> {
  const log = new k8s.Log(kc)
  const logStream = new stream.PassThrough()
  logStream.on('data', chunk => {
    // use write rather than console.log to prevent double line feed
    process.stdout.write(chunk)
  })

  logStream.on('error', err => {
    process.stderr.write(err.message)
  })

  const r = await log.log(namespace(), podName, containerName, logStream, {
    follow: true,
    pretty: false,
    timestamps: false
  })
  await new Promise(resolve => r.on('close', () => resolve(null)))
}

export async function prunePods(): Promise<void> {
  const podList = await k8sApi.listNamespacedPod(
    namespace(),
    undefined,
    undefined,
    undefined,
    undefined,
    new RunnerInstanceLabel().toString()
  )
  if (!podList.body.items.length) {
    return
  }

  await Promise.all(
    podList.body.items.map(
      pod => pod.metadata?.name && deletePod(pod.metadata.name)
    )
  )
}

export async function getPodStatus(
  name: string
): Promise<k8s.V1PodStatus | undefined> {
  const { body } = await k8sApi.readNamespacedPod(name, namespace())
  return body.status
}

export async function isAuthPermissionsOK(): Promise<boolean> {
  const sar = new k8s.V1SelfSubjectAccessReview()
  const asyncs: Promise<{
    response: unknown
    body: k8s.V1SelfSubjectAccessReview
  }>[] = []
  for (const resource of requiredPermissions) {
    for (const verb of resource.verbs) {
      sar.spec = new k8s.V1SelfSubjectAccessReviewSpec()
      sar.spec.resourceAttributes = new k8s.V1ResourceAttributes()
      sar.spec.resourceAttributes.verb = verb
      sar.spec.resourceAttributes.namespace = namespace()
      sar.spec.resourceAttributes.group = resource.group
      sar.spec.resourceAttributes.resource = resource.resource
      sar.spec.resourceAttributes.subresource = resource.subresource
      asyncs.push(k8sAuthorizationV1Api.createSelfSubjectAccessReview(sar))
    }
  }
  const responses = await Promise.all(asyncs)
  return responses.every(resp => resp.body.status?.allowed)
}

export async function isPodContainerAlpine(
  podName: string,
  containerName: string
): Promise<boolean> {
  let isAlpine = true
  try {
    await execPodStep(
      [
        'sh',
        '-c',
        `'[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1'`
      ],
      podName,
      containerName
    )
  } catch (err) {
    isAlpine = false
  }

  return isAlpine
}

async function getCurrentNodeName(): Promise<string> {
  const resp = await k8sApi.readNamespacedPod(getRunnerPodName(), namespace())

  const nodeName = resp.body.spec?.nodeName
  if (!nodeName) {
    throw new Error('Failed to determine node name')
  }
  return nodeName
}

async function getPodAffinity(nodeName: string): Promise<k8s.V1Affinity> {
  const affinity = new k8s.V1Affinity()
  affinity.nodeAffinity = new k8s.V1NodeAffinity()
  affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution =
    new k8s.V1NodeSelector()
  affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms =
    [
      {
        matchExpressions: [
          {
            key: 'kubernetes.io/hostname',
            operator: 'In',
            values: [nodeName]
          }
        ]
      }
    ]
  return affinity
}

async function getPreferredPodAffinity(
  nodeName: string
): Promise<k8s.V1Affinity> {
  const affinity = new k8s.V1Affinity()
  affinity.nodeAffinity = new k8s.V1NodeAffinity()

  // 创建 PreferredSchedulingTerm 对象
  const preferredTerm = new k8s.V1PreferredSchedulingTerm()
  preferredTerm.weight = 1 // 设置权重（1-100）

  // 创建 NodeSelectorTerm
  preferredTerm.preference = new k8s.V1NodeSelectorTerm()
  preferredTerm.preference.matchExpressions = [
    {
      key: 'kubernetes.io/hostname',
      operator: 'In',
      values: [nodeName]
    }
  ]

  // 将 PreferredSchedulingTerm 添加到数组中
  affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution = [
    preferredTerm
  ]

  return affinity
}

export function namespace(): string {
  if (process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']) {
    return process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  }

  const context = kc.getContexts().find(ctx => ctx.namespace)
  if (!context?.namespace) {
    throw new Error(
      'Failed to determine namespace, falling back to `default`. Namespace should be set in context, or in env variable "ACTIONS_RUNNER_KUBERNETES_NAMESPACE"'
    )
  }
  return context.namespace
}

class BackOffManager {
  private backOffSeconds = 1
  totalTime = 0
  constructor(private throwAfterSeconds?: number) {
    if (!throwAfterSeconds || throwAfterSeconds < 0) {
      this.throwAfterSeconds = undefined
    }
  }

  async backOff(): Promise<void> {
    await new Promise(resolve =>
      setTimeout(resolve, this.backOffSeconds * 1000)
    )
    this.totalTime += this.backOffSeconds
    if (this.throwAfterSeconds && this.throwAfterSeconds < this.totalTime) {
      throw new Error('backoff timeout')
    }
    if (this.backOffSeconds < 20) {
      this.backOffSeconds *= 2
    }
    if (this.backOffSeconds > 20) {
      this.backOffSeconds = 20
    }
  }
}

export function containerPorts(
  container: ContainerInfo
): k8s.V1ContainerPort[] {
  const ports: k8s.V1ContainerPort[] = []
  if (!container.portMappings?.length) {
    return ports
  }
  for (const portDefinition of container.portMappings) {
    const portProtoSplit = portDefinition.split('/')
    if (portProtoSplit.length > 2) {
      throw new Error(`Unexpected port format: ${portDefinition}`)
    }

    const port = new k8s.V1ContainerPort()
    port.protocol =
      portProtoSplit.length === 2 ? portProtoSplit[1].toUpperCase() : 'TCP'

    const portSplit = portProtoSplit[0].split(':')
    if (portSplit.length > 2) {
      throw new Error('ports should have at most one ":" separator')
    }

    const parsePort = (p: string): number => {
      const num = Number(p)
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`invalid container port: ${p}`)
      }
      return num
    }

    if (portSplit.length === 1) {
      port.containerPort = parsePort(portSplit[0])
    } else {
      port.hostPort = parsePort(portSplit[0])
      port.containerPort = parsePort(portSplit[1])
    }

    ports.push(port)
  }
  return ports
}

export async function getPodByName(name): Promise<k8s.V1Pod> {
  const { body } = await k8sApi.readNamespacedPod(name, namespace())
  return body
}
