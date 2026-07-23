import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeToResponseFile } from './index'

describe('writeToResponseFile', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `hooklib-test-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, '')
  })

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })

  it('appends string value with EOL', () => {
    writeToResponseFile(tmpFile, 'hello')
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe(`hello${os.EOL}`)
  })

  it('appends JSON for object value', () => {
    writeToResponseFile(tmpFile, { key: 'value' })
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe(`{"key":"value"}${os.EOL}`)
  })

  it('appends empty string for null', () => {
    writeToResponseFile(tmpFile, null)
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe(`${os.EOL}`)
  })

  it('appends empty string for undefined', () => {
    writeToResponseFile(tmpFile, undefined)
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe(`${os.EOL}`)
  })

  it('throws if filePath is empty', () => {
    expect(() => writeToResponseFile('', 'data')).toThrow('Expected file path')
  })

  it('throws if file does not exist', () => {
    expect(() =>
      writeToResponseFile('/nonexistent/path/file.json', 'data')
    ).toThrow('Missing file at path')
  })

  it('appends multiple writes sequentially', () => {
    writeToResponseFile(tmpFile, 'first')
    writeToResponseFile(tmpFile, 'second')
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe(
      `first${os.EOL}second${os.EOL}`
    )
  })
})
