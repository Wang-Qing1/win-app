import { describe, expect, test, vi, beforeEach } from 'vitest'

const showSaveDialog = vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>()

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) }
}))

const backup = vi.fn<(destinationFile: string) => Promise<unknown>>()
const getDatabase = vi.fn(() => ({ backup }))
const getDatabaseFile = vi.fn(() => 'C:\\Users\\test\\AppData\\Roaming\\winbook\\winbook.db')

vi.mock('../../db/connection', () => ({ getDatabase, getDatabaseFile }))

const statSync = vi.fn<(path: string) => { size: number }>()
vi.mock('node:fs', () => ({ statSync: (...args: unknown[]) => statSync(...(args as [string])) }))

const { BackupService } = await import('./backup.service')

const fakeSender = {} as never

beforeEach(() => {
  showSaveDialog.mockReset()
  backup.mockReset()
  getDatabase.mockClear()
  statSync.mockReset()
})

describe('BackupService.backupDatabase', () => {
  test('returns canceled:true without touching the database when the user cancels the dialog', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const service = new BackupService()

    const result = await service.backupDatabase(fakeSender)

    expect(result).toEqual({ canceled: true, filePath: null, bytes: 0 })
    expect(backup).not.toHaveBeenCalled()
  })

  test('calls db.backup() with the chosen path and reports the written file size', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'D:\\backups\\winbook-2026-09-18.db' })
    backup.mockResolvedValue(undefined)
    statSync.mockReturnValue({ size: 123456 })
    const service = new BackupService()

    const result = await service.backupDatabase(fakeSender)

    expect(backup).toHaveBeenCalledWith('D:\\backups\\winbook-2026-09-18.db')
    expect(statSync).toHaveBeenCalledWith('D:\\backups\\winbook-2026-09-18.db')
    expect(result).toEqual({
      canceled: false,
      filePath: 'D:\\backups\\winbook-2026-09-18.db',
      bytes: 123456
    })
  })

  test('suggests a filename derived from the live database file name', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const service = new BackupService()

    await service.backupDatabase(fakeSender)

    const options = showSaveDialog.mock.calls[0][0] as { defaultPath: string }
    expect(options.defaultPath).toContain('winbook')
    expect(options.defaultPath.endsWith('.db')).toBe(true)
  })
})
