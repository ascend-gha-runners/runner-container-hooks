/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import {
  execCpFromPod,
  execCpToPod,
  execPodStep,
  execPodStepWithOutput
} from '../k8s'
import { formatError, writeRunScript } from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import { dirname } from 'path'
import * as shlex from 'shlex'

function formatScriptError(exitCode: number, tailOutput: string): string {
  const sep = '-'.repeat(60)
  const errors = [
    `  ✗ exit code: ${exitCode}`,
    `  → your script exited with a non-zero code; please check your script for errors`
  ]
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
  // Validate that pod was created successfully (prepareJob succeeded)
  if (!state?.jobPod) {
    throw new Error(
      'jobPod must be set - ensure prepareJob completed successfully before running script steps'
    )
  }

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
  const runnerTemp = `${workdir}/_temp`
  const containerTemp = '/__w/_temp'
  const containerTempSrc = '/__w/_temp_pre'
  // Ensure base and staging dirs exist before copying
  await execPodStep(
    [
      'sh',
      '-c',
      'mkdir -p /__w && mkdir -p /__w/_temp && mkdir -p /__w/_temp_pre'
    ],
    state.jobPod,
    JOB_CONTAINER_NAME
  )
  await execCpToPod(state.jobPod, runnerTemp, containerTempSrc)

  // Copy GitHub directories from temp to /github
  // Merge strategy:
  // - Overwrite files in _runner_file_commands
  // - Append files not already present elsewhere
  const mergeCommands = [
    'set -e',
    'mkdir -p /__w/_temp /__w/_temp_pre',
    'SRC=/__w/_temp_pre',
    'DST=/__w/_temp',
    // Overwrite _runner_file_commands
    'cp -a "$SRC/_runner_file_commands/." "$DST/_runner_file_commands"',
    `find "$SRC" -type f ! -path "*/_runner_file_commands/*" -exec sh -c '
    rel="\${1#$2/}"
    target="$3/$rel"
    mkdir -p "$(dirname "$target")"
    cp -a "$1" "$target"
  ' _ {} "$SRC" "$DST" \\;`,
    // Remove _temp_pre after merging
    'rm -rf /__w/_temp_pre'
  ]

  try {
    await execPodStep(
      ['sh', '-c', mergeCommands.join(' && ')],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const message = formatError(err)
    core.debug(`Failed to merge temp directories: ${message}`)
    throw new Error(`failed to merge temp dirs: ${message}`)
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
    core.debug(`execPodStep failed: ${formatError(err)}`)
    if (
      err instanceof Error &&
      err.message.startsWith('failed to run script step')
    ) {
      throw err
    }
    const message = formatError(err)
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
    await execCpFromPod(
      state.jobPod,
      `${containerTemp}/_runner_file_commands`,
      `${workdir}/_temp`
    )
  } catch (error) {
    core.warning('Failed to copy _temp from pod')
  }
}
