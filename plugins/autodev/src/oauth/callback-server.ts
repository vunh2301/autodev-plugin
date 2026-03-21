// src/oauth/callback-server.ts — HTTP callback server for PKCE OAuth flow

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { URL } from 'node:url'
import { PortExhaustedError } from './types.js'

export interface CallbackServerOptions {
  port: number
  callbackPath: string       // '/auth/callback'
  expectedState: string      // CSRF state to verify
  signal?: AbortSignal
  timeoutMs: number          // 300_000 (5 min)
}

export interface CallbackServer {
  url: string                // 'http://127.0.0.1:{port}/auth/callback'
  waitForCode(): Promise<{ code: string }>
  close(): void
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Login</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:80px">
  <h2>Login thanh cong!</h2>
  <p>Ban co the dong tab nay.</p>
  <script>window.close()</script>
</body>
</html>`

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Error</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:80px">
  <h2>Login that bai</h2>
  <p>${msg}</p>
</body>
</html>`

/**
 * Start an HTTP callback server for the PKCE OAuth redirect.
 * Binds to 127.0.0.1 only (security — no external access).
 *
 * The server validates the CSRF state parameter, extracts the authorization code,
 * and resolves the promise returned by waitForCode().
 */
export function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  const { port, callbackPath, expectedState, signal, timeoutMs } = options

  return new Promise<CallbackServer>((resolveServer, rejectServer) => {
    let codeResolve: ((value: { code: string }) => void) | null = null
    let codeReject: ((reason: Error) => void) | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== callbackPath) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      // Validate CSRF state
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERROR_HTML('State mismatch — co the la CSRF attack. Vui long thu lai.'))
        if (!settled && codeReject) {
          settled = true
          codeReject(new Error('CSRF state mismatch on callback'))
          cleanup()
        }
        return
      }

      // Validate code present
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERROR_HTML('Khong nhan duoc authorization code. Vui long thu lai.'))
        if (!settled && codeReject) {
          settled = true
          codeReject(new Error('No authorization code in callback'))
          cleanup()
        }
        return
      }

      // Success
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(SUCCESS_HTML)
      if (!settled && codeResolve) {
        settled = true
        codeResolve({ code })
        cleanup()
      }
    })

    function cleanup(): void {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      // Close server gracefully
      server.close(() => {})
    }

    // Handle AbortSignal
    if (signal) {
      if (signal.aborted) {
        rejectServer(new Error('Callback server aborted before start'))
        return
      }
      signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true
          if (codeReject) codeReject(new Error('Callback cancelled'))
          cleanup()
        }
      }, { once: true })
    }

    // Handle server errors (e.g. EADDRINUSE)
    server.on('error', (err: any) => {
      rejectServer(err)
    })

    // Bind to localhost only
    server.listen(port, '127.0.0.1', () => {
      const callbackUrl = `http://localhost:${port}${callbackPath}`

      const callbackServer: CallbackServer = {
        url: callbackUrl,

        waitForCode(): Promise<{ code: string }> {
          return new Promise<{ code: string }>((resolve, reject) => {
            codeResolve = resolve
            codeReject = reject

            // Timeout
            timeoutHandle = setTimeout(() => {
              if (!settled) {
                settled = true
                reject(new Error(`Callback timeout sau ${timeoutMs / 1000}s — user chua login xong`))
                cleanup()
              }
            }, timeoutMs)
          })
        },

        close(): void {
          if (!settled) {
            settled = true
          }
          cleanup()
        },
      }

      resolveServer(callbackServer)
    })
  })
}

/**
 * Try to start a callback server on one of the given ports.
 * Returns the server on the first port that works.
 * Throws PortExhaustedError if all ports fail with EADDRINUSE.
 */
export async function startCallbackServerWithRetry(
  ports: number[],
  callbackPath: string,
  expectedState: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CallbackServer> {
  for (let i = 0; i < ports.length; i++) {
    try {
      const server = await startCallbackServer({
        port: ports[i],
        callbackPath,
        expectedState,
        signal,
        timeoutMs,
      })
      return server
    } catch (err: any) {
      if (err.code === 'EADDRINUSE' && i < ports.length - 1) {
        continue // try next port
      }
      if (err.code === 'EADDRINUSE') {
        throw new PortExhaustedError(
          `Tat ca port callback (${ports.join(', ')}) deu bi chiem. Dung Device Code flow.`
        )
      }
      throw err
    }
  }
  throw new PortExhaustedError('No ports to try')
}
