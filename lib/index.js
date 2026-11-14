/**
 * dsh-atc — host half.
 *
 * Serves one same-origin JSON route the browser half polls. All work is local
 * file/SQLite reads: no model calls, no tokens, no network.
 */

import { collectBoard } from './collect.mjs'

/** Plugin manifest name. */
export const name = 'dsh-atc'

/** The route is optional outside Web profiles. */
export const inject = []

/** Absolute route prefix owned by this plugin. */
export const ROUTE = '/dsh-atc'

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/** Register the read-only board endpoint. */
export function mountBoardRoute(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    async handler(request, response) {
      const url = request.url ?? ''
      if (!url.startsWith(`${ROUTE}/data`)) {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      try {
        sendJson(response, 200, await collectBoard())
      } catch (error) {
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
    },
  })
}

/** Cordis plugin body. */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => mountBoardRoute(webCtx), 'dsh-atc: board route')
  })
}
