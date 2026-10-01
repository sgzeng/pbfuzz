/**
 * The TS↔Python engine JSON-RPC client (`contracts/engine-rpc.schema.json`).
 *
 * Newline-delimited JSON-RPC 2.0 over the sidecar's stdin/stdout; stderr is log only. The framing
 * and correlation live here as a transport-agnostic client so they can be unit-tested against an
 * in-memory pipe rather than a real Python process — the engine itself is W2/W3's and only exists
 * on the Linux box.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/rpc
 */

import type { Remedy } from './contracts.ts'

/** The methods the sidecar serves. */
export type RpcMethod =
  | 'ping'
  | 'campaign.load'
  | 'fuzz.run'
  | 'fuzz.cancel'
  | 'trace.run'
  | 'deviation.run'
  | 'corpus.analyze'
  | 'params.extract'
  | 'generator.validate'
  | 'selfcheck.engine'

/** Server→client progress, so a long fuzz job streams instead of going silent. */
export type RpcNotificationMethod = 'progress' | 'iteration' | 'log'

/** One outbound request. */
export interface RpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: RpcMethod
  params?: Record<string, unknown>
}

/** A JSON-RPC error whose `data` carries the diagnosis and the options, never just a message. */
export interface RpcErrorBody {
  code: number
  message: string
  data?: { diagnosis?: string; remedies?: Remedy[] }
}

/** One inbound response. */
export interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: RpcErrorBody
}

/** One inbound notification. */
export interface RpcNotification {
  jsonrpc: '2.0'
  method: RpcNotificationMethod
  params: Record<string, unknown>
}

/** Anything the sidecar may write on stdout. */
export type RpcInbound = RpcResponse | RpcNotification

/** An engine failure that preserves the diagnosis and remedies for the recovery flow. */
export class EngineRpcError extends Error {
  /** JSON-RPC error code. */
  readonly code: number
  /** The engine's root-cause statement, when it supplied one. */
  readonly diagnosis: string | undefined
  /** Concrete options to offer the user. */
  readonly remedies: Remedy[]

  constructor(body: RpcErrorBody) {
    super(body.message)
    this.name = 'EngineRpcError'
    this.code = body.code
    this.diagnosis = body.data?.diagnosis
    this.remedies = body.data?.remedies ?? []
  }
}

/** Serialize one request as a single NDJSON line, trailing newline included. */
export function encodeRequest(request: RpcRequest): string {
  return `${JSON.stringify(request)}\n`
}

/**
 * Incremental NDJSON decoder.
 *
 * A stdout chunk boundary lands anywhere, so the decoder must buffer partial lines; a decoder
 * that assumed chunk == line would drop or corrupt messages under load, which for a fuzz run is
 * exactly when it matters. Malformed lines are reported rather than thrown, because one bad line
 * (a stray print in the engine) must not kill a live campaign.
 */
export class NdjsonDecoder {
  private buffer = ''

  /**
   * Feed one chunk and take every complete message it finished.
   * @param chunk - raw stdout text.
   * @returns the parsed messages plus any lines that failed to parse.
   */
  push(chunk: string): { messages: RpcInbound[]; malformed: string[] } {
    this.buffer += chunk
    const messages: RpcInbound[] = []
    const malformed: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isInbound(parsed)) messages.push(parsed)
        else malformed.push(line)
      } catch {
        malformed.push(line)
      }
    }
    return { messages, malformed }
  }

  /** Whatever is buffered but not yet newline-terminated; used to report a truncated stream. */
  pending(): string {
    return this.buffer
  }
}

/** Whether a parsed value is a JSON-RPC 2.0 response or notification. */
function isInbound(value: unknown): value is RpcInbound {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.jsonrpc !== '2.0') return false
  return 'id' in record || typeof record.method === 'string'
}

/** Whether an inbound message is a response rather than a notification. */
export function isResponse(message: RpcInbound): message is RpcResponse {
  return 'id' in message
}

/** The duplex the client drives; a real sidecar, or an in-memory pipe in tests. */
export interface RpcTransport {
  /** Write one encoded request line. */
  write(line: string): void
  /** Subscribe to stdout text. */
  onData(listener: (chunk: string) => void): void
  /** Subscribe to transport death, so in-flight calls reject instead of hanging forever. */
  onClose(listener: (reason: string) => void): void
}

/** Progress callback for a long-running call. */
export type RpcProgressListener = (notification: RpcNotification) => void

/**
 * Correlating JSON-RPC client over one transport.
 *
 * Every in-flight call is rejected when the transport dies: a fuzz job whose sidecar crashed must
 * surface as a failure with a diagnosis, never as a promise that never settles.
 */
export class EngineRpcClient {
  private nextId = 1
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()

  private readonly decoder = new NdjsonDecoder()
  private readonly progressListeners = new Set<RpcProgressListener>()
  private closedReason: string | undefined

  constructor(private readonly transport: RpcTransport) {
    transport.onData((chunk) => { this.ingest(chunk) })
    transport.onClose((reason) => { this.fail(reason) })
  }

  /**
   * Observe server→client progress notifications.
   * @param listener - invoked for every notification.
   * @returns a disposer removing the listener.
   */
  onProgress(listener: RpcProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => { this.progressListeners.delete(listener) }
  }

  /**
   * Issue one call and await its result.
   * @param method - the RPC method.
   * @param params - the method's parameters.
   * @param signal - caller cancellation; aborting rejects the call without killing the sidecar.
   * @returns the method's result value.
   * @throws {EngineRpcError} when the engine returned an error body.
   */
  call(method: RpcMethod, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new EngineRpcError({ code: -32000, message: `engine sidecar unavailable: ${this.closedReason}` }))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const onAbort = (): void => {
        this.pending.delete(id)
        reject(new EngineRpcError({ code: -32001, message: `${method} aborted by caller` }))
      }
      if (signal !== undefined) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.transport.write(encodeRequest({
        jsonrpc: '2.0',
        id,
        method,
        ...params !== undefined ? { params } : {},
      }))
    })
  }

  /** Route one stdout chunk to the waiting callers and the progress listeners. */
  private ingest(chunk: string): void {
    const { messages } = this.decoder.push(chunk)
    for (const message of messages) {
      if (!isResponse(message)) {
        for (const listener of [...this.progressListeners]) listener(message)
        continue
      }
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) continue
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new EngineRpcError(message.error))
      else waiter.resolve(message.result)
    }
  }

  /** Reject everything in flight; a dead sidecar must not leave a hanging campaign. */
  private fail(reason: string): void {
    this.closedReason = reason
    for (const [id, waiter] of [...this.pending]) {
      this.pending.delete(id)
      waiter.reject(new EngineRpcError({
        code: -32000,
        message: `engine sidecar exited before answering: ${reason}`,
        data: {
          diagnosis: 'The Python engine sidecar terminated while a call was in flight.',
          remedies: [{
            id: 'restart_engine',
            label: 'Restart the engine and re-run the step',
            effect: 'retry',
          }],
        },
      }))
    }
  }
}
