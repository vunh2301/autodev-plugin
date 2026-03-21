// src/oauth/lock.ts — File-based locking for refresh race condition and concurrent login guard

import { mkdir, writeFile, unlink, stat } from 'node:fs/promises'
import path from 'node:path'

// Lock dir is always passed by engine — no default needed
const DEFAULT_LOCK_DIR = ''
const LOCK_TIMEOUT_MS = 30_000       // refresh lock stale after 30s
const LOCK_RETRY_MS = 100            // retry interval
const LOCK_MAX_RETRIES = 50          // max 50 * 100ms = 5s wait
const LOGIN_LOCK_TIMEOUT_MS = 600_000 // login lock stale after 10 min

interface LockInfo {
  pid: number
  created_at: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Acquire file lock for refresh cycle, execute fn, then release.
 * Lock file: ~/.config/autodev/oauth/.refresh-lock-{accountName}
 *
 * Strategy:
 *   1. Try exclusive file create (flag 'wx')
 *   2. If lock exists: check stale (> 30s) -> delete and retry
 *   3. If still valid: sleep 100ms, retry (max 50 times = 5s)
 *   4. After acquire: run fn()
 *   5. Release lock (delete file)
 */
export async function withRefreshLock<T>(
  accountName: string,
  fn: () => Promise<T>,
  lockDir: string = DEFAULT_LOCK_DIR,
): Promise<T> {
  const lockPath = path.join(lockDir, `.refresh-lock-${accountName}`)
  await mkdir(lockDir, { recursive: true })

  let acquired = false
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      } satisfies LockInfo), { flag: 'wx' })
      acquired = true
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err

      // Lock file exists — check if stale
      try {
        const lockStat = await stat(lockPath)
        const age = Date.now() - lockStat.mtimeMs
        if (age > LOCK_TIMEOUT_MS) {
          // Stale lock — remove and retry
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Lock file was deleted between check — retry
        continue
      }

      // Lock still valid — wait and retry
      if (attempt < LOCK_MAX_RETRIES - 1) {
        await sleep(LOCK_RETRY_MS)
      }
    }
  }

  if (!acquired) {
    throw new Error(
      `Could not acquire refresh lock for "${accountName}" after ${LOCK_MAX_RETRIES} attempts (5s). Another process may be refreshing.`
    )
  }

  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}

/**
 * Acquire login lock — prevents two concurrent login flows for the same account.
 * Lock file: ~/.config/autodev/oauth/.login-lock-{accountName}
 *
 * Does NOT retry — rejects immediately if lock exists and is not stale.
 * Stale threshold: 10 minutes (login timeout).
 */
export async function acquireLoginLock(
  accountName: string,
  lockDir: string = DEFAULT_LOCK_DIR,
): Promise<void> {
  const lockPath = path.join(lockDir, `.login-lock-${accountName}`)
  await mkdir(lockDir, { recursive: true })

  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    } satisfies LockInfo), { flag: 'wx' })
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err

    // Lock exists — check stale
    try {
      const lockStat = await stat(lockPath)
      const age = Date.now() - lockStat.mtimeMs
      if (age > LOGIN_LOCK_TIMEOUT_MS) {
        // Stale login lock — remove and acquire
        await unlink(lockPath).catch(() => {})
        await writeFile(lockPath, JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
        } satisfies LockInfo), { flag: 'wx' })
        return
      }
    } catch {
      // Lock was deleted — try acquire again
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      } satisfies LockInfo), { flag: 'wx' })
      return
    }

    throw new Error(
      `Login đang chạy cho account "${accountName}" (PID khác). Chờ hoàn tất hoặc xóa lock file: ${lockPath}`
    )
  }
}

/**
 * Release login lock.
 */
export async function releaseLoginLock(
  accountName: string,
  lockDir: string = DEFAULT_LOCK_DIR,
): Promise<void> {
  const lockPath = path.join(lockDir, `.login-lock-${accountName}`)
  await unlink(lockPath).catch(() => {})
}
