/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import { execCpFromPod, execCpToPod, execPodStep, execPodStepWithOutput } from '../k8s'
import { writeRunScript, sleep, listDirAllCommand } from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import { dirname } from 'path'
import * as shlex from 'shlex'

function formatScriptError(exitCode: number, tailOutput: string): string {
  const sep = '─'.repeat(60)
  const errors = [`  ✗ exit code: ${exitCode}`]
  const sections: string[] = []
  if (tailOutput) {
    const outputLines = tailOutput
      .split('\n')
      .map(l => `  ${l}`)
      .join('\n')
    sections.push(`Last output:\n${outputLines}`)
  }
  let result = `failed to run script step:\n${errors.join('\n')}`
  if (sections.length) result += `\n${sep}\n${sections.join('\n')}`
  return result
}

export async function runScriptStep(
  args: RunScriptStepArgs,
  state
): Promise<void> {
  // Write the entrypoint first. This will be later coppied to the workflow pod
  const { entryPoint, entryPointArgs, environmentVariables } = args
  const { containerPath, runnerPath } = writeRunScript(
    args.workingDirectory,
    entryPoint,
    entryPointArgs,
    args.prependPath,
    environmentVariables
  )

  const workdir = dirname(process.env.RUNNER_WORKSPACE as string)
  const containerTemp = '/__w/_temp'
  const runnerTemp = `${workdir}/_temp`
  await execCpToPod(state.jobPod, runnerTemp, containerTemp)

  // Copy GitHub directories from temp to /github
  const setupCommands = [
    'mkdir -p /github',
    'cp -r /__w/_temp/_github_home /github/home',
    'cp -r /__w/_temp/_github_workflow /github/workflow'
  ]

  try {
    await execPodStep(
      ['sh', '-c', shlex.quote(setupCommands.join(' && '))],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    core.debug(`Failed to copy GitHub directories: ${JSON.stringify(err)}`)
  }

  // Execute the entrypoint script
  args.entryPoint = 'sh'
  args.entryPointArgs = ['-e', containerPath]
  try {
    const { code, output } = await execPodStepWithOutput(
      [args.entryPoint, ...args.entryPointArgs],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
    if (code !== 0) {
      throw new Error(formatScriptError(code, output))
    }
  } catch (err) {
    core.debug(`execPodStep failed: ${JSON.stringify(err)}`)
    if (err instanceof Error && err.message.startsWith('failed to run script step')) {
      throw err
    }
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to run script step: ${message}`)
  } finally {
    try {
      fs.rmSync(runnerPath, { force: true })
    } catch (removeErr) {
      core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
    }
  }

  try {
    core.debug(
      `Copying from job pod '${state.jobPod}' ${containerTemp} to ${runnerTemp}`
    )
    await execCpFromPod(state.jobPod, containerTemp, workdir)
  } catch (error) {
    core.warning('Failed to copy _temp from pod')
  }
}
