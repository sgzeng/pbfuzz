import { describe, expect, it } from 'vitest'
import { encodeRequest, EngineRpcClient, EngineRpcError, NdjsonDecoder, type RpcTransport } from '../src/core/rpc.ts'

function pipe() {
  const written: string[] = []
  let data: (c: string) => void = () => {}
  let close: (r: string) => void = () => {}
  const transport: RpcTransport = {
    write: l => { written.push(l) },
    onData: l => { data = l },
    onClose: l => { close = l },
  }
  return { transport, written, emit: (s: string) => { data(s) }, close: (r: string) => { close(r) } }
}

describe('NDJSON framing', () => {
  it('encodes one line per request', () => {
    expect(encodeRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
  })

  it('buffers partial lines across chunks and reports malformed lines', () => {
    const d = new NdjsonDecoder()
    expect(d.push('{"jsonrpc":"2.0","id":1,"res').messages).toEqual([])
    const r = d.push('ult":5}\nnot json\n{"jsonrpc":"2.0","method":"log","params":{}}\n{"x":1}\n')
    expect(r.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: 5 }, { jsonrpc: '2.0', method: 'log', params: {} }])
    expect(r.malformed).toEqual(['not json', '{"x":1}'])
    expect(d.pending()).toBe('')
  })
})

describe('EngineRpcClient', () => {
  it('correlates responses by id and routes notifications', async () => {
    const p = pipe()
    const client = new EngineRpcClient(p.transport)
    const seen: string[] = []
    client.onProgress(n => { seen.push(n.method) })
    const a = client.call('ping')
    const b = client.call('corpus.analyze', { campaignPath: '/c' })
    expect(p.written.map(l => JSON.parse(l).id)).toEqual([1, 2])
    p.emit('{"jsonrpc":"2.0","method":"progress","params":{"i":1}}\n{"jsonrpc":"2.0","id":2,"result":"B"}\n{"jsonrpc":"2.0","id":1,"result":"A"}\n')
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
    expect(seen).toEqual(['progress'])
  })

  it('surfaces error bodies with diagnosis and remedies', async () => {
    const p = pipe()
    const client = new EngineRpcClient(p.transport)
    const call = client.call('trace.run', {})
    p.emit('{"jsonrpc":"2.0","id":1,"error":{"code":-32010,"message":"bp unresolved","data":{"diagnosis":"no -g","remedies":[{"id":"rebuild","label":"Rebuild with -g","effect":"edit_campaign"}]}}}\n')
    const error = await call.catch(e => e as EngineRpcError)
    expect(error).toBeInstanceOf(EngineRpcError)
    expect(error.diagnosis).toBe('no -g')
    expect(error.remedies[0]!.id).toBe('rebuild')
  })

  it('rejects in-flight and later calls when the sidecar dies', async () => {
    const p = pipe()
    const client = new EngineRpcClient(p.transport)
    const call = client.call('fuzz.run', {})
    p.close('code 1')
    const error = await call.catch(e => e as EngineRpcError)
    expect(error.message).toMatch(/exited before answering: code 1/)
    expect(error.remedies[0]!.id).toBe('restart_engine')
    await expect(client.call('ping')).rejects.toThrow(/unavailable/)
  })

  it('aborting a call rejects it', async () => {
    const p = pipe()
    const client = new EngineRpcClient(p.transport)
    const ac = new AbortController()
    const call = client.call('fuzz.run', {}, ac.signal)
    ac.abort()
    await expect(call).rejects.toThrow(/aborted/)
  })
})
