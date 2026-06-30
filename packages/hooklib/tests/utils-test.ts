import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeToResponseFile, getInputFromStdin } from '../src/utils'

describe('writeToResponseFile', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `hooklib-test-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, '')
  })

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile)
    }
  })

  it('should append string value with EOL', () => {
    writeToResponseFile(tmpFile, 'hello')
    const content = fs.readFileSync(tmpFile, 'utf8')
    expect(content).toBe(`hello${os.EOL}`)
  })

  it('should append JSON for object value', () => {
    writeToResponseFile(tmpFile, { key: 'value' })
    const content = fs.readFileSync(tmpFile, 'utf8')
    expect(content).toBe(`{"key":"value"}${os.EOL}`)
  })

  it('should append empty string for null', () => {
    writeToResponseFile(tmpFile, null)
    const content = fs.readFileSync(tmpFile, 'utf8')
    expect(content).toBe(`${os.EOL}`)
  })

  it('should append empty string for undefined', () => {
    writeToResponseFile(tmpFile, undefined)
    const content = fs.readFileSync(tmpFile, 'utf8')
    expect(content).toBe(`${os.EOL}`)
  })

  it('should throw if filePath is empty', () => {
    expect(() => writeToResponseFile('', 'data')).toThrow('Expected file path')
  })

  it('should throw if file does not exist', () => {
    expect(() =>
      writeToResponseFile('/nonexistent/path/file.json', 'data')
    ).toThrow('Missing file at path')
  })

  it('should append multiple writes sequentially', () => {
    writeToResponseFile(tmpFile, 'first')
    writeToResponseFile(tmpFile, 'second')
    const content = fs.readFileSync(tmpFile, 'utf8')
    expect(content).toBe(`first${os.EOL}second${os.EOL}`)
  })
})

describe('getInputFromStdin', () => {
  it('should parse JSON from stdin line', async () => {
    const mockData = { command: 'prepare_job', responseFile: '/tmp/resp.json' }
    const { EventEmitter } = require('events')
    const fakeRl = new EventEmitter()
    fakeRl.close = () => {}

    jest
      .spyOn(require('readline'), 'createInterface')
      .mockReturnValue(fakeRl)

    const promise = getInputFromStdin()

    // Emit line first, then close — matches real readline behavior
    setImmediate(() => {
      fakeRl.emit('line', JSON.stringify(mockData))
      fakeRl.emit('close')
    })

    const result = await promise
    expect(result).toStrictEqual(mockData)
  })
})
