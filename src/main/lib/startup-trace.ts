/**
 * Start-up timing, printed when AQUA_TRACE_STARTUP is set: milliseconds since
 * the process started (Chromium's own start-up included) at each milestone.
 */
const enabled = !!process.env['AQUA_TRACE_STARTUP']

export function mark(milestone: string): void {
  if (enabled) console.info(`[startup] ${Math.round(process.uptime() * 1000)} ms  ${milestone}`)
}
