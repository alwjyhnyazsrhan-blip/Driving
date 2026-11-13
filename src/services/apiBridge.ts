import {
  EngineMode,
  EngineRuntimeConfig,
  ensureLocalEngineInitialized,
  handleLocalApiRequest,
  loadEngineConfig,
  mirrorServerDataToLocal,
  saveEngineConfig,
  startStandaloneBackgroundRunners,
} from './localEngine';

type Listener = (cfg: EngineRuntimeConfig) => void;
const listeners = new Set<Listener>();

let currentConfig: EngineRuntimeConfig = loadEngineConfig();
let bridgeInstalled = false;
let nativeFetchRef: typeof window.fetch | null = null;

function notifyListeners() {
  listeners.forEach((cb) => {
    try {
      cb({ ...currentConfig });
    } catch {}
  });
}

export function getEngineConfig(): EngineRuntimeConfig {
  return { ...currentConfig };
}

export function subscribeEngineConfig(cb: Listener): () => void {
  listeners.add(cb);
  cb({ ...currentConfig });
  return () => listeners.delete(cb);
}

export function updateEngineMode(mode: EngineMode, localServerUrl?: string): EngineRuntimeConfig {
  const cleanUrl = (localServerUrl ?? currentConfig.localServerUrl).trim().replace(/\/+$/, '') || 'http://localhost:3000';
  currentConfig = saveEngineConfig({
    mode,
    localServerUrl: cleanUrl,
    activeBackend: mode === 'standalone' ? 'standalone' : mode === 'local_server' ? 'local_server' : 'server',
    lastFallbackReason: undefined,
  });
  if (currentConfig.activeBackend === 'standalone') {
    startStandaloneBackgroundRunners();
  }
  notifyListeners();
  return { ...currentConfig };
}

export async function probeBackendHealth(targetBaseUrl = ''): Promise<boolean> {
  const fetchFn = nativeFetchRef || (typeof window !== 'undefined' ? window.fetch.bind(window) : null);
  if (!fetchFn) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetchFn(`${targetBaseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return false;
    const data = await res.json();
    return Boolean(data && data.status === 'ok');
  } catch {
    return false;
  }
}

export function installApiBridge() {
  if (bridgeInstalled || typeof window === 'undefined') return;
  bridgeInstalled = true;
  nativeFetchRef = window.fetch.bind(window);
  const originalFetch = nativeFetchRef;

  ensureLocalEngineInitialized().then(() => {
    startStandaloneBackgroundRunners();
  });

  const bridgedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

    let pathname = '';
    let isRelativeApi = false;
    try {
      if (rawUrl.startsWith('/api/')) {
        pathname = rawUrl.split('?')[0];
        isRelativeApi = true;
      } else if (rawUrl.startsWith(window.location.origin + '/api/')) {
        pathname = rawUrl.slice(window.location.origin.length).split('?')[0];
        isRelativeApi = true;
      }
    } catch {}

    if (!isRelativeApi) {
      return originalFetch(input, init);
    }

    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let parsedBody: any = undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {}
    }

    // Mode 1: Pure Standalone Browser Mode (Zero hosting / zero backend server calls)
    if (currentConfig.mode === 'standalone') {
      if (currentConfig.activeBackend !== 'standalone') {
        currentConfig = saveEngineConfig({ activeBackend: 'standalone' });
        notifyListeners();
      }
      return handleLocalApiRequest(pathname, method, parsedBody);
    }

    // Mode 2: Explicit Local Server Mode (e.g., user running start-local.bat at http://localhost:3000)
    const targetUrl =
      currentConfig.mode === 'local_server'
        ? `${currentConfig.localServerUrl}${rawUrl.startsWith('/') ? rawUrl : pathname}`
        : input;

    // Mode 3: Auto mode (try server, mirror to IndexedDB, auto-fallback to standalone if server stops/sleeps)
    const isLongSync = pathname.includes('cloud-login') || pathname.includes('cloud-sync-now');
    const timeoutMs = isLongSync ? 18000 : 5000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await originalFetch(targetUrl, {
        ...init,
        signal: init?.signal || controller.signal,
      });
      clearTimeout(timeoutId);

      // If hosting proxy returned 502/503/504 or HTML fallback page instead of API JSON
      const contentType = response.headers.get('content-type') || '';
      const isExpectedText = pathname === '/api/automation-script';
      const isBadProxyResponse =
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504 ||
        (!isExpectedText && !contentType.includes('application/json'));

      if (isBadProxyResponse) {
        throw new Error(`Hosting unavailable (${response.status})`);
      }

      const expectedBackend = currentConfig.mode === 'local_server' ? 'local_server' : 'server';
      if (currentConfig.activeBackend !== expectedBackend) {
        currentConfig = saveEngineConfig({ activeBackend: expectedBackend, lastFallbackReason: undefined });
        notifyListeners();
      }

      // Mirror GET responses into local IndexedDB silently
      if (method === 'GET' && contentType.includes('application/json')) {
        response
          .clone()
          .json()
          .then((data) => mirrorServerDataToLocal(pathname, data))
          .catch(() => {});
      }

      return response;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (currentConfig.activeBackend !== 'standalone') {
        currentConfig = saveEngineConfig({
          activeBackend: 'standalone',
          lastFallbackReason: err?.message || 'توقف الاتصال بالسيرفر',
        });
        startStandaloneBackgroundRunners();
        notifyListeners();
      }
      return handleLocalApiRequest(pathname, method, parsedBody);
    }
  };

  try {
    const desc = Object.getOwnPropertyDescriptor(window, 'fetch');
    if (!desc || desc.configurable) {
      Object.defineProperty(window, 'fetch', {
        value: bridgedFetch,
        writable: true,
        configurable: true,
        enumerable: desc ? desc.enumerable : true,
      });
    } else if (desc.writable) {
      window.fetch = bridgedFetch;
    }
  } catch (err) {
    console.warn('[API Bridge] Could not override window.fetch cleanly:', err);
  }
}
