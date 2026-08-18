import * as k8s from '@kubernetes/client-node'
import * as http from 'http'
import * as net from 'net'
import {
  DEFAULT_CA_SECRET_NAME,
  DEFAULT_NO_PROXY,
  ENV_CACHE_CA_SECRET,
  ENV_CACHE_NO_PROXY,
  ENV_CACHE_PROXY,
  ENV_ENABLE_TRANSPARENT_CACHE,
  injectTransparentCache,
  isProxyHealthy,
  maybeInjectTransparentCache,
  normalizeProxyUrl,
  readTransparentCacheConfig,
  resetProxyHealthCache
} from '../src/k8s/utils/transparent-cache'

function ephemeralServer(): Promise<http.Server> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 400 // any response means "alive"
      res.end('no')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function closedPort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function buildSpec(): k8s.V1PodSpec {
  const container = new k8s.V1Container()
  container.name = 'job'
  const spec = new k8s.V1PodSpec()
  spec.containers = [container]
  return spec
}

function enabledEnv(proxy: string): NodeJS.ProcessEnv {
  return {
    [ENV_ENABLE_TRANSPARENT_CACHE]: 'true',
    [ENV_CACHE_PROXY]: proxy
  }
}

function envOf(container: k8s.V1Container, name: string): string | undefined {
  return container.env?.find(e => e.name === name)?.value
}

beforeEach(() => {
  resetProxyHealthCache()
})

describe('normalizeProxyUrl', () => {
  it('keeps urls that already carry a scheme', () => {
    expect(normalizeProxyUrl('http://squid:3128')).toBe('http://squid:3128')
    expect(normalizeProxyUrl('https://squid:3128')).toBe('https://squid:3128')
  })

  it('prepends http:// to bare host:port', () => {
    expect(normalizeProxyUrl('squid-cache.squid.svc:3128')).toBe(
      'http://squid-cache.squid.svc:3128'
    )
  })

  it('returns undefined for empty input', () => {
    expect(normalizeProxyUrl('')).toBeUndefined()
    expect(normalizeProxyUrl('   ')).toBeUndefined()
  })
})

describe('readTransparentCacheConfig', () => {
  it('is disabled when the gate env is missing', () => {
    expect(readTransparentCacheConfig({})).toBeUndefined()
    expect(
      readTransparentCacheConfig({ [ENV_CACHE_PROXY]: 'http://squid:3128' })
    ).toBeUndefined()
  })

  it('is disabled when the gate is not exactly true', () => {
    expect(
      readTransparentCacheConfig({
        [ENV_ENABLE_TRANSPARENT_CACHE]: 'TRUE',
        [ENV_CACHE_PROXY]: 'http://squid:3128'
      })
    ).toBeUndefined()
    expect(
      readTransparentCacheConfig({
        [ENV_ENABLE_TRANSPARENT_CACHE]: '1',
        [ENV_CACHE_PROXY]: 'http://squid:3128'
      })
    ).toBeUndefined()
  })

  it('is disabled when the proxy is missing or blank', () => {
    expect(
      readTransparentCacheConfig({
        [ENV_ENABLE_TRANSPARENT_CACHE]: 'true'
      })
    ).toBeUndefined()
    expect(
      readTransparentCacheConfig({
        [ENV_ENABLE_TRANSPARENT_CACHE]: 'true',
        [ENV_CACHE_PROXY]: '   '
      })
    ).toBeUndefined()
  })

  it('returns defaults for a minimal enabled config', () => {
    const cfg = readTransparentCacheConfig(
      enabledEnv('squid-cache.squid.svc:3128')
    )
    expect(cfg).toBeDefined()
    expect(cfg!.proxy).toBe('http://squid-cache.squid.svc:3128')
    expect(cfg!.noProxy).toBe(DEFAULT_NO_PROXY)
    expect(cfg!.caSecret).toBe(DEFAULT_CA_SECRET_NAME)
    expect(cfg!.caTrustHook).toBe(true)
  })

  it('honours explicit overrides', () => {
    const cfg = readTransparentCacheConfig({
      [ENV_ENABLE_TRANSPARENT_CACHE]: 'true',
      [ENV_CACHE_PROXY]: 'http://squid:3128',
      [ENV_CACHE_NO_PROXY]: 'localhost,.svc',
      [ENV_CACHE_CA_SECRET]: 'custom-ca',
      ACTIONS_RUNNER_CACHE_CA_TRUST_HOOK: 'false'
    })
    expect(cfg!.noProxy).toBe('localhost,.svc')
    expect(cfg!.caSecret).toBe('custom-ca')
    expect(cfg!.caTrustHook).toBe(false)
  })
})

describe('injectTransparentCache', () => {
  const config = {
    proxy: 'http://squid-cache.squid.svc.cluster.local:3128',
    noProxy: 'localhost,127.0.0.1,.svc',
    caSecret: 'squid-ca-cert',
    caTrustHook: true
  }

  it('injects proxy env, CA env, volume, mount and postStart when healthy', () => {
    const spec = buildSpec()
    const result = injectTransparentCache(spec, config, {
      proxyHealthy: true
    })
    expect(result.caInjected).toBe(true)
    expect(result.proxyEnvInjected).toBe(true)

    const c = spec.containers![0]
    expect(envOf(c, 'HTTP_PROXY')).toBe(config.proxy)
    expect(envOf(c, 'HTTPS_PROXY')).toBe(config.proxy)
    expect(envOf(c, 'http_proxy')).toBe(config.proxy)
    expect(envOf(c, 'https_proxy')).toBe(config.proxy)
    expect(envOf(c, 'NO_PROXY')).toBe(config.noProxy)
    expect(envOf(c, 'no_proxy')).toBe(config.noProxy)
    expect(envOf(c, 'SSL_CERT_FILE')).toBe('/etc/squid-ca/squid-ca.pem')
    expect(envOf(c, 'PIP_CERT')).toBe('/etc/squid-ca/squid-ca.pem')

    const vol = spec.volumes!.find(v => v.name === 'squid-ca')
    expect(vol).toBeDefined()
    expect(vol!.secret!.secretName).toBe('squid-ca-cert')
    expect(vol!.secret!.items![0]).toEqual({
      key: 'squid-ca.pem',
      path: 'squid-ca.pem'
    })
    expect(
      c.volumeMounts!.some(
        m =>
          m.name === 'squid-ca' && m.mountPath === '/etc/squid-ca' && m.readOnly
      )
    ).toBe(true)
    expect(c.lifecycle!.postStart!.exec!.command![0]).toBe('/bin/sh')
    // The trust hook must never be able to fail the container.
    expect(c.lifecycle!.postStart!.exec!.command![2]).toContain('exit 0')
  })

  it('injects only the CA when the proxy is unhealthy (fail-open)', () => {
    const spec = buildSpec()
    const result = injectTransparentCache(spec, config, {
      proxyHealthy: false
    })
    expect(result.caInjected).toBe(true)
    expect(result.proxyEnvInjected).toBe(false)
    const c = spec.containers![0]
    expect(envOf(c, 'HTTP_PROXY')).toBeUndefined()
    expect(envOf(c, 'https_proxy')).toBeUndefined()
    expect(envOf(c, 'SSL_CERT_FILE')).toBe('/etc/squid-ca/squid-ca.pem')
    expect(spec.volumes!.some(v => v.name === 'squid-ca')).toBe(true)
  })

  it('never overrides env vars already set by the workflow or ops template', () => {
    const spec = buildSpec()
    spec.containers![0].env = [
      { name: 'HTTPS_PROXY', value: 'http://ops-proxy:1' },
      { name: 'SSL_CERT_FILE', value: '/custom/ca.pem' }
    ]
    injectTransparentCache(spec, config, { proxyHealthy: true })
    const c = spec.containers![0]
    expect(envOf(c, 'HTTPS_PROXY')).toBe('http://ops-proxy:1')
    expect(envOf(c, 'SSL_CERT_FILE')).toBe('/custom/ca.pem')
    // missing siblings are still added
    expect(envOf(c, 'HTTP_PROXY')).toBe(config.proxy)
    expect(envOf(c, 'NO_PROXY')).toBe(config.noProxy)
  })

  it('keeps an existing postStart hook untouched', () => {
    const spec = buildSpec()
    spec.containers![0].lifecycle = {
      postStart: { exec: { command: ['/bin/true'] } }
    }
    injectTransparentCache(spec, config, { proxyHealthy: true })
    expect(spec.containers![0].lifecycle!.postStart!.exec!.command).toEqual([
      '/bin/true'
    ])
  })

  it('skips the postStart hook when caTrustHook is disabled', () => {
    const spec = buildSpec()
    injectTransparentCache(
      spec,
      { ...config, caTrustHook: false },
      {
        proxyHealthy: true
      }
    )
    expect(spec.containers![0].lifecycle).toBeUndefined()
    expect(envOf(spec.containers![0], 'HTTPS_PROXY')).toBe(config.proxy)
  })

  it('does not duplicate the CA volume when one already exists', () => {
    const spec = buildSpec()
    spec.volumes = [{ name: 'squid-ca', emptyDir: {} }]
    injectTransparentCache(spec, config, { proxyHealthy: true })
    expect(spec.volumes!.filter(v => v.name === 'squid-ca')).toHaveLength(1)
  })

  it('injects into every container (job + services)', () => {
    const spec = buildSpec()
    const svc = new k8s.V1Container()
    svc.name = 'redis'
    spec.containers!.push(svc)
    injectTransparentCache(spec, config, { proxyHealthy: true })
    for (const c of spec.containers!) {
      expect(envOf(c, 'HTTPS_PROXY')).toBe(config.proxy)
      expect(c.volumeMounts!.some(m => m.name === 'squid-ca')).toBe(true)
    }
  })

  it('is a no-op for a spec without containers', () => {
    const spec = new k8s.V1PodSpec()
    spec.containers = []
    const result = injectTransparentCache(spec, config, {
      proxyHealthy: true
    })
    expect(result.caInjected).toBe(false)
    expect(result.proxyEnvInjected).toBe(false)
    expect(spec.volumes).toBeUndefined()
  })
})

describe('isProxyHealthy / maybeInjectTransparentCache', () => {
  it('reports a responding proxy as healthy', async () => {
    const server = await ephemeralServer()
    const port = (server.address() as net.AddressInfo).port
    await expect(
      isProxyHealthy(`http://127.0.0.1:${port}`, 1000)
    ).resolves.toBe(true)
    await server.close()
  })

  it('reports a dead port as unhealthy', async () => {
    const port = await closedPort()
    await expect(isProxyHealthy(`http://127.0.0.1:${port}`, 500)).resolves.toBe(
      false
    )
  })

  it('caches the probe result within the TTL', async () => {
    const server = await ephemeralServer()
    const port = (server.address() as net.AddressInfo).port
    const url = `http://127.0.0.1:${port}`
    await expect(isProxyHealthy(url, 1000)).resolves.toBe(true)
    // Server gone: the cached verdict must still answer "healthy".
    await server.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(isProxyHealthy(url, 500)).resolves.toBe(true)
  })

  it('leaves the spec untouched when the feature is disabled', async () => {
    const spec = buildSpec()
    const result = await maybeInjectTransparentCache(spec, {})
    expect(result).toBeUndefined()
    expect(spec.containers![0].env).toBeUndefined()
    expect(spec.volumes).toBeUndefined()
  })

  it('injects proxy env end-to-end against a live proxy', async () => {
    const server = await ephemeralServer()
    const port = (server.address() as net.AddressInfo).port
    const spec = buildSpec()
    const result = await maybeInjectTransparentCache(
      spec,
      enabledEnv(`http://127.0.0.1:${port}`)
    )
    expect(result!.proxyEnvInjected).toBe(true)
    expect(envOf(spec.containers![0], 'HTTPS_PROXY')).toBe(
      `http://127.0.0.1:${port}`
    )
    await server.close()
  })

  it('injects CA only when the proxy is dead (fail-open escape)', async () => {
    const port = await closedPort()
    const spec = buildSpec()
    const result = await maybeInjectTransparentCache(
      spec,
      enabledEnv(`http://127.0.0.1:${port}`)
    )
    expect(result!.caInjected).toBe(true)
    expect(result!.proxyEnvInjected).toBe(false)
    expect(envOf(spec.containers![0], 'HTTPS_PROXY')).toBeUndefined()
    expect(envOf(spec.containers![0], 'SSL_CERT_FILE')).toBe(
      '/etc/squid-ca/squid-ca.pem'
    )
  })

  it('injects nothing when the CA secret is missing (no FailedMount)', async () => {
    const server = await ephemeralServer()
    const port = (server.address() as net.AddressInfo).port
    const spec = buildSpec()
    const result = await maybeInjectTransparentCache(
      spec,
      enabledEnv(`http://127.0.0.1:${port}`),
      { secretExists: async () => false }
    )
    expect(result).toBeUndefined()
    expect(spec.containers![0].env).toBeUndefined()
    expect(spec.volumes).toBeUndefined()
    await server.close()
  })

  it('injects fully when the CA secret exists and the proxy is healthy', async () => {
    const server = await ephemeralServer()
    const port = (server.address() as net.AddressInfo).port
    const spec = buildSpec()
    const result = await maybeInjectTransparentCache(
      spec,
      enabledEnv(`http://127.0.0.1:${port}`),
      { secretExists: async () => true }
    )
    expect(result!.proxyEnvInjected).toBe(true)
    expect(result!.caInjected).toBe(true)
    expect(spec.volumes!.some(v => v.name === 'squid-ca')).toBe(true)
    await server.close()
  })

  it('treats a throwing secret check as missing', async () => {
    const server = await ephemeralServer()
    const port = (server.address() as net.AddressInfo).port
    const spec = buildSpec()
    const result = await maybeInjectTransparentCache(
      spec,
      enabledEnv(`http://127.0.0.1:${port}`),
      {
        secretExists: async () => {
          throw new Error('rbac denied')
        }
      }
    )
    expect(result).toBeUndefined()
    expect(spec.volumes).toBeUndefined()
    await server.close()
  })
})
