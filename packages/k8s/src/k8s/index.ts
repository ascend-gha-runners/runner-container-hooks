import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import * as k8s from '@kubernetes/client-node'
import tar from 'tar-fs'
import * as stream from 'stream'
import { WritableStreamBuffer } from 'stream-buffers'
import { createHash } from 'crypto'
import type { ContainerInfo, Registry } from 'hooklib'
import {
  getSecretName,
  JOB_CONTAINER_NAME,
  RunnerInstanceLabel
} from '../hooks/constants'
import {
  PodPhase,
  mergePodSpecWithOptions,
  mergeObjectMeta,
  fixArgs,
  listDirAllCommand,
  sleep,
  EXTERNALS_VOLUME_NAME,
  GITHUB_VOLUME_NAME,
  WORK_VOLUME
} from './utils'
import * as shlex from 'shlex'

const kc = new k8s.KubeConfig()

kc.loadFromDefault()

const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
const k8sBatchV1Api = kc.makeApiClient(k8s.BatchV1Api)
const k8sAuthorizationV1Api = kc.makeApiClient(k8s.AuthorizationV1Api)

const DEFAULT_WAIT_FOR_POD_TIME_SECONDS = 10 * 60 // 10 min

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
    group: '',
    verbs: ['create', 'delete', 'get', 'list'],
    resource: 'secrets',
    subresource: ''
  }
]

export async function createJobPod(
  name: string,
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
  appPod.metadata.name = name

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = containers
  appPod.spec.securityContext = {
    fsGroup: 1001
  }

  // Extract working directory from GITHUB_WORKSPACE
  // GITHUB_WORKSPACE is like /__w/repo-name/repo-name
  const githubWorkspace = process.env.GITHUB_WORKSPACE
  const workingDirPath = githubWorkspace?.split('/').slice(-2).join('/') ?? ''

  const initCommands = [
    'mkdir -p /mnt/externals',
    'mkdir -p /mnt/work',
    'mkdir -p /mnt/github',
    'mv /home/runner/externals/* /mnt/externals/'
  ]

  if (workingDirPath) {
    initCommands.push(`mkdir -p /mnt/work/${workingDirPath}`)
  }

  appPod.spec.initContainers = [
    {
      name: 'fs-init',
      image:
        process.env.ACTIONS_RUNNER_IMAGE ||
        'ghcr.io/actions/actions-runner:latest',
      command: ['sh', '-c', initCommands.join(' && ')],
      securityContext: {
        runAsGroup: 1001,
        runAsUser: 1001
      },
      volumeMounts: [
        {
          name: EXTERNALS_VOLUME_NAME,
          mountPath: '/mnt/externals'
        },
        {
          name: WORK_VOLUME,
          mountPath: '/mnt/work'
        },
        {
          name: GITHUB_VOLUME_NAME,
          mountPath: '/mnt/github'
        }
      ]
    }
  ]

  appPod.spec.restartPolicy = 'Never'

  appPod.spec.volumes = [
    {
      name: EXTERNALS_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: GITHUB_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: WORK_VOLUME,
      emptyDir: {}
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

  return await k8sApi.createNamespacedPod({
    namespace: namespace(),
    body: appPod
  })
}

export async function createContainerStepPod(
  name: string,
  container: k8s.V1Container,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = name

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = [container]

  appPod.spec.restartPolicy = 'Never'

  appPod.spec.volumes = [
    {
      name: EXTERNALS_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: GITHUB_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: WORK_VOLUME,
      emptyDir: {}
    }
  ]

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  return await k8sApi.createNamespacedPod({
    namespace: namespace(),
    body: appPod
  })
}

export async function deletePod(name: string): Promise<void> {
  await k8sApi.deleteNamespacedPod({
    name,
    namespace: namespace(),
    gracePeriodSeconds: 0
  })
}

export async function execPodStep(
  command: string[],
  podName: string,
  containerName: string,
  stdin?: stream.Readable
): Promise<number> {
  const exec = new k8s.Exec(kc)

  command = fixArgs(command)
  return await new Promise(function (resolve, reject) {
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
          core.debug(`execPodStep response: ${JSON.stringify(resp)}`)
          if (resp.status === 'Success') {
            resolve(resp.code || 0)
          } else {
            core.debug(
              JSON.stringify({
                message: resp?.message,
                details: resp?.details
              })
            )
            reject(new Error(resp?.message || 'execPodStep failed'))
          }
        }
      )
      .catch(e => reject(e))
  })
}

export async function execCalculateOutputHashSorted(
  podName: string,
  containerName: string,
  command: string[]
): Promise<string> {
  const exec = new k8s.Exec(kc)

  let output = ''
  const outputWriter = new stream.Writable({
    write(chunk, _enc, cb) {
      try {
        output += chunk.toString('utf8')
        cb()
      } catch (e) {
        cb(e as Error)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        outputWriter, // capture stdout
        process.stderr,
        null,
        false /* tty */,
        resp => {
          core.debug(`internalExecOutput response: ${JSON.stringify(resp)}`)
          if (resp.status === 'Success') {
            resolve()
          } else {
            core.debug(
              JSON.stringify({
                message: resp?.message,
                details: resp?.details
              })
            )
            reject(new Error(resp?.message || 'internalExecOutput failed'))
          }
        }
      )
      .catch(e => reject(e))
  })

  outputWriter.end()

  // Sort lines for consistent ordering across platforms
  const sortedOutput =
    output
      .split('\n')
      .filter(line => line.length > 0)
      .sort()
      .join('\n') + '\n'

  const hash = createHash('sha256')
  hash.update(sortedOutput)
  return hash.digest('hex')
}

export async function localCalculateOutputHashSorted(
  commands: string[]
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(commands[0], commands.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code: number) => {
      if (code === 0) {
        // Sort lines for consistent ordering across distributions/platforms
        const sortedOutput =
          output
            .split('\n')
            .filter(line => line.length > 0)
            .sort()
            .join('\n') + '\n'

        const hash = createHash('sha256')
        hash.update(sortedOutput)
        resolve(hash.digest('hex'))
      } else {
        reject(new Error(`child process exited with code ${code}`))
      }
    })
  })
}

export async function execCpToPod(
  podName: string,
  runnerPath: string,
  containerPath: string
): Promise<void> {
  core.debug(`Copying ${runnerPath} to pod ${podName} at ${containerPath}`)

  let attempt = 0
  while (true) {
    try {
      const exec = new k8s.Exec(kc)
      // Use tar to extract with --no-same-owner to avoid ownership issues.
      // Then use find to fix permissions. The -m flag helps but we also need to fix permissions after.
      const command = [
        'sh',
        '-c',
        `tar xf - --no-same-owner -C ${shlex.quote(containerPath)} 2>/dev/null; ` +
          `find ${shlex.quote(containerPath)} -type f -exec chmod u+rw {} \\; 2>/dev/null; ` +
          `find ${shlex.quote(containerPath)} -type d -exec chmod u+rwx {} \\; 2>/dev/null`
      ]
      const readStream = tar.pack(runnerPath)
      const errStream = new WritableStreamBuffer()
      await new Promise((resolve, reject) => {
        exec
          .exec(
            namespace(),
            podName,
            JOB_CONTAINER_NAME,
            command,
            null,
            errStream,
            readStream,
            false,
            async status => {
              if (errStream.size()) {
                reject(
                  new Error(
                    `Error from execCpToPod - status: ${status.status}, details: \n ${errStream.getContentsAsString()}`
                  )
                )
              }
              resolve(status)
            }
          )
          .catch(e => reject(e))
      })
      break
    } catch (error) {
      core.debug(`cpToPod: Attempt ${attempt + 1} failed: ${error}`)
      attempt++
      if (attempt >= 30) {
        throw new Error(
          `cpToPod failed after ${attempt} attempts: ${JSON.stringify(error)}`
        )
      }
      await sleep(1000)
    }
  }

  let attempts = 15
  const delay = 1000
  for (let i = 0; i < attempts; i++) {
    try {
      const want = await localCalculateOutputHashSorted([
        'sh',
        '-c',
        listDirAllCommand(runnerPath)
      ])

      const got = await execCalculateOutputHashSorted(
        podName,
        JOB_CONTAINER_NAME,
        ['sh', '-c', listDirAllCommand(containerPath)]
      )

      if (got !== want) {
        core.debug(
          `The hash of the directory does not match the expected value; want='${want}' got='${got}'`
        )
        await sleep(delay)
        continue
      }

      break
    } catch (error) {
      core.debug(`Attempt ${i + 1} failed: ${error}`)
      await sleep(delay)
    }
  }
}

export async function execCpFromPod(
  podName: string,
  containerPath: string,
  parentRunnerPath: string
): Promise<void> {
  const targetRunnerPath = `${parentRunnerPath}/${path.basename(containerPath)}`
  core.debug(
    `Copying from pod ${podName} ${containerPath} to ${targetRunnerPath}`
  )

  let attempt = 0
  while (true) {
    try {
      // make temporary directory
      const exec = new k8s.Exec(kc)
      const containerPaths = containerPath.split('/')
      const dirname = containerPaths.pop() as string
      const command = [
        'tar',
        'cf',
        '-',
        '-C',
        containerPaths.join('/') || '/',
        dirname
      ]
      const writerStream = tar.extract(parentRunnerPath)
      const errStream = new WritableStreamBuffer()

      await new Promise((resolve, reject) => {
        exec
          .exec(
            namespace(),
            podName,
            JOB_CONTAINER_NAME,
            command,
            writerStream,
            errStream,
            null,
            false,
            async status => {
              if (errStream.size()) {
                reject(
                  new Error(
                    `Error from cpFromPod - details: \n ${errStream.getContentsAsString()}`
                  )
                )
              }
              resolve(status)
            }
          )
          .catch(e => reject(e))
      })
      break
    } catch (error) {
      core.debug(`Attempt ${attempt + 1} failed: ${error}`)
      attempt++
      if (attempt >= 30) {
        throw new Error(
          `execCpFromPod failed after ${attempt} attempts: ${JSON.stringify(error)}`
        )
      }
      await sleep(1000)
    }
  }

  let attempts = 15
  const delay = 1000
  for (let i = 0; i < attempts; i++) {
    try {
      const want = await execCalculateOutputHashSorted(
        podName,
        JOB_CONTAINER_NAME,
        ['sh', '-c', listDirAllCommand(containerPath)]
      )

      const got = await localCalculateOutputHashSorted([
        'sh',
        '-c',
        listDirAllCommand(targetRunnerPath)
      ])

      if (got !== want) {
        core.debug(
          `The hash of the directory does not match the expected value; want='${want}' got='${got}'`
        )
        await sleep(delay)
        continue
      }

      break
    } catch (error) {
      core.debug(`Attempt ${i + 1} failed: ${error}`)
      await sleep(delay)
    }
  }
}

export async function waitForJobToComplete(jobName: string): Promise<void> {
  const backOffManager = new BackOffManager()
  while (true) {
    try {
      if (await isJobSucceeded(jobName)) {
        return
      }
    } catch (error) {
      throw new Error(`job ${jobName} has failed: ${JSON.stringify(error)}`)
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

  return await k8sApi.createNamespacedSecret({
    namespace: namespace(),
    body: secret
  })
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

  await k8sApi.createNamespacedSecret({
    namespace: namespace(),
    body: secret
  })
  return secretName
}

export async function deleteSecret(name: string): Promise<void> {
  await k8sApi.deleteNamespacedSecret({
    name,
    namespace: namespace()
  })
}

export async function pruneSecrets(): Promise<void> {
  const secretList = await k8sApi.listNamespacedSecret({
    namespace: namespace(),
    labelSelector: new RunnerInstanceLabel().toString()
  })
  if (!secretList.items.length) {
    return
  }

  await Promise.all(
    secretList.items.map(
      async secret =>
        secret.metadata?.name && (await deleteSecret(secret.metadata.name))
    )
  )
}

export const UNRECOVERABLE_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError'
])

// Maximum number of Warning events to include in a pod's failure description so
// that the GitHub Actions log is not flooded.
const MAX_DIAGNOSTIC_EVENTS = 10

// The fast-fail whitelist can be extended (not narrowed) from the environment so
// operators can add deterministic terminal reasons without a code change. This
// reuses the same env-var configuration pattern as the prepare-job timeout. When
// the variable is unset, behaviour is identical to the built-in defaults.
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

// describePodFailure aggregates everything that might explain why a pod is not
// healthy into a single human-readable string. It makes NO success/failure
// judgement of its own (a terminated exitCode=0 container is just reported as
// such) -- callers decide what is "bad". It never throws: if it cannot read the
// pod or list events it returns/embeds a best-effort note instead, so it is safe
// to call from any error path.
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

  // Surface conditions that are blocking readiness, e.g. PodScheduled=False
  // which is the only place a FailedScheduling shows up on the pod itself.
  for (const cond of status?.conditions ?? []) {
    if (cond.status === 'False') {
      lines.push(
        `Condition ${cond.type}=False${
          cond.reason ? ` (reason: ${cond.reason})` : ''
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
      // Skip reasons already surfaced by getContainerErrors() to avoid
      // duplicating the same message in the caller's error string.
      if (!UNRECOVERABLE_WAITING_REASONS.has(waiting.reason)) {
        lines.push(
          `Container "${cs.name}" waiting: ${waiting.reason}${
            waiting.message ? ` - ${waiting.message}` : ''
          }`
        )
      }
    }
    const terminated = cs.state?.terminated
    // Only surface non-zero exits; exit 0 (e.g. fs-init Completed) is noise.
    if (terminated && terminated.exitCode !== 0) {
      lines.push(
        `Container "${cs.name}" terminated: ${
          terminated.reason ?? 'Unknown'
        } (exit code ${terminated.exitCode})${
          terminated.message ? ` - ${terminated.message}` : ''
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

// Reads the most recent Warning events for a pod. Best-effort: listing events
// requires the optional "events" get/list permission, so any error (including
// RBAC Forbidden) is swallowed and an empty list is returned.
async function describePodWarningEvents(podName: string): Promise<string[]> {
  let items: k8s.CoreV1Event[]
  try {
    const result = await k8sApi.listNamespacedEvent({
      namespace: namespace(),
      fieldSelector: `involvedObject.name=${podName}`
    })
    items = result.items
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

    // The pod reached a phase we are not willing to keep waiting on
    // (a terminal/unhealthy phase). Attach full diagnostics and stop.
    if (!backOffPhases.has(phase)) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} is unhealthy with phase status ${phase}\n${details}`
      )
    }

    // Still in a back-off phase, but a container hit a deterministic terminal
    // error (e.g. ImagePullBackOff) -- fail fast with diagnostics instead of
    // waiting out the full timeout.
    const containerErrors = getContainerErrors(pod)
    if (containerErrors.length > 0) {
      const details = await describePodFailure(podName)
      throw new Error(
        `Pod ${podName} has unrecoverable container errors: ${containerErrors.join(
          '; '
        )}\n${details}`
      )
    }

    try {
      await backOffManager.backOff()
    } catch (error) {
      // BackOffManager throws "backoff timeout" when maxTimeSeconds is exceeded.
      // Don't surface that bare message: collect diagnostics first so the user
      // can see WHY the pod never became ready. This is the safest improvement
      // -- it only runs when we were going to fail anyway and changes no
      // success/failure decision.
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
  return await k8sApi.readNamespacedPod({
    name: podName,
    namespace: namespace()
  })
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

async function isJobSucceeded(name: string): Promise<boolean> {
  const job = await k8sBatchV1Api.readNamespacedJob({
    name,
    namespace: namespace()
  })
  if (job.status?.failed) {
    throw new Error(`job ${name} has failed`)
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

  await log.log(namespace(), podName, containerName, logStream, {
    follow: true,
    pretty: false,
    timestamps: false
  })
  await new Promise(resolve => logStream.on('end', () => resolve(null)))
}

export async function prunePods(): Promise<void> {
  const podList = await k8sApi.listNamespacedPod({
    namespace: namespace(),
    labelSelector: new RunnerInstanceLabel().toString()
  })
  if (!podList.items.length) {
    return
  }

  await Promise.all(
    podList.items.map(
      async pod => pod.metadata?.name && (await deletePod(pod.metadata.name))
    )
  )
}

export async function getPodStatus(
  name: string
): Promise<k8s.V1PodStatus | undefined> {
  const pod = await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })
  return pod.status
}

export async function isAuthPermissionsOK(): Promise<boolean> {
  const sar = new k8s.V1SelfSubjectAccessReview()
  const asyncs: Promise<k8s.V1SelfSubjectAccessReview>[] = []
  for (const resource of requiredPermissions) {
    for (const verb of resource.verbs) {
      sar.spec = new k8s.V1SelfSubjectAccessReviewSpec()
      sar.spec.resourceAttributes = new k8s.V1ResourceAttributes()
      sar.spec.resourceAttributes.verb = verb
      sar.spec.resourceAttributes.namespace = namespace()
      sar.spec.resourceAttributes.group = resource.group
      sar.spec.resourceAttributes.resource = resource.resource
      sar.spec.resourceAttributes.subresource = resource.subresource
      asyncs.push(
        k8sAuthorizationV1Api.createSelfSubjectAccessReview({ body: sar })
      )
    }
  }
  const responses = await Promise.all(asyncs)
  return responses.every(resp => resp.status?.allowed)
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
  } catch {
    isAlpine = false
  }

  return isAlpine
}

export function namespace(): string {
  if (process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']) {
    return process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  }

  const context = kc.getContexts().find(ctx => ctx.namespace)
  if (context?.namespace) {
    return context.namespace
  }

  // When running in-cluster the kubeconfig context has no namespace field;
  // read it from the mounted ServiceAccount file instead.
  const saNamespaceFile =
    '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
  try {
    const ns = fs.readFileSync(saNamespaceFile, 'utf8').trim()
    if (ns) {
      return ns
    }
  } catch {
    // not running in-cluster, fall through to error
  }

  throw new Error(
    'Failed to determine namespace. Set the ACTIONS_RUNNER_KUBERNETES_NAMESPACE environment variable or ensure the kubeconfig context includes a namespace.'
  )
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
  return await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })
}
