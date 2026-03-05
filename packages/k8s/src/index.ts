import * as core from '@actions/core'
import {
  Command,
  getInputFromStdin,
  PrepareJobArgs,
  RunContainerStepArgs,
  RunScriptStepArgs
} from 'hooklib'
import {
  cleanupJob,
  prepareJob,
  runContainerStep,
  runScriptStep
} from './hooks'
import { isAuthPermissionsOK, namespace, requiredPermissions } from './k8s'

async function run(): Promise<void> {
  try {
    const input = await getInputFromStdin()

    const args = input['args']
    const command = input['command']
    const responseFile = input['responseFile']
    const state = input['state']
    if (!(await isAuthPermissionsOK())) {
      throw new Error(
        `The Service account needs the following permissions ${JSON.stringify(
          requiredPermissions
        )} on the pod resource in the '${namespace()}' namespace. Please contact your self hosted runner administrator.`
      )
    }

    let exitCode = 0
    switch (command) {
      case Command.PrepareJob:
        await prepareJob(args as PrepareJobArgs, responseFile)
        return process.exit(0)
      case Command.CleanupJob:
        await cleanupJob()
        return process.exit(0)
      case Command.RunScriptStep:
        await runScriptStep(args as RunScriptStepArgs, state)
        return process.exit(0)
      case Command.RunContainerStep:
        exitCode = await runContainerStep(args as RunContainerStepArgs)
        return process.exit(exitCode)
      default:
        throw new Error(`Command not recognized: ${command}`)
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : String(error)
    core.error('='.repeat(60))
    core.error('HOOK FATAL ERROR — PrepareJob failed')
    core.error('='.repeat(60))
    core.error(errMsg)
    core.error('='.repeat(60))
    core.error('Sleeping 10 minutes to allow pod inspection for debugging...')
    await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000))
    process.exit(1)
  }
}

process.on('uncaughtException', (err: Error) => {
  const e = err as NodeJS.ErrnoException
  core.error(`[GLOBAL] uncaughtException: code=${e.code}, message=${e.message}`)
  core.error(e.stack ?? String(e))
  process.exit(1)
})

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  const e = err as NodeJS.ErrnoException
  core.error(`[GLOBAL] unhandledRejection: code=${e.code}, message=${e.message}`)
  core.error(e.stack ?? String(e))
  process.exit(1)
})

void run()
