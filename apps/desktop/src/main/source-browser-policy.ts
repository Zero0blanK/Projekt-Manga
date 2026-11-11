/**
 * The decisions behind the source browser window (main/source-browser.ts), kept free of
 * Electron imports so tests can exercise them directly.
 */

/** Source keys are short slugs; anything else is refused before it reaches a URL or a
 * partition name. */
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseOpenBrowserArgs(args: unknown): {
  sourceId: string;
  closeWhenPassed: boolean;
} {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('openBrowser expects { sourceId }');
  }
  const { sourceId, closeWhenPassed } = args as { sourceId?: unknown; closeWhenPassed?: unknown };
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) {
    throw new Error('sourceId must be a source key');
  }
  if (closeWhenPassed !== undefined && typeof closeWhenPassed !== 'boolean') {
    throw new Error('closeWhenPassed must be true or false');
  }
  return { sourceId, closeWhenPassed: closeWhenPassed === true };
}

/** A page title that is still a browser check rather than the site. */
export function isChallengeTitle(title: string): boolean {
  return /just a moment|attention required|checking your browser|checking if the site connection is secure|one more step|verify(ing)? you are human|human verification|ddos-guard/i.test(
    title,
  );
}

/** One persistent partition per source, so a login on one source never shows up in
 * another's window and none of them touch the app's own session. */
export function partitionFor(sourceId: string): string {
  return `persist:source-browser-${sourceId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}

export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Whether the API is on this machine. Cloudflare ties its clearance to the IP that
 * passed the challenge, and the cookies are secrets, so they only go to a local server. */
export function isLoopbackApi(apiUrl: string): boolean {
  try {
    const { hostname } = new URL(apiUrl);
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/** The page the window opens: the source's own site, and only when that site is one the
 * source may reach — a listing whose base_url points elsewhere gets no window. */
export function startUrlFor(baseUrl: string, allowedHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('This source has no usable website address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('This source has no usable website address');
  }
  if (!isHostAllowed(url.hostname, allowedHosts)) {
    throw new Error("This source's website is not one it is allowed to reach");
  }
  return url.href;
}

/** Electron's default User-Agent names Electron and the app, which challenge pages treat
 * as a bot. Without them it is the plain Chromium string the window really is. */
export function browserUserAgent(defaultUserAgent: string): string {
  return defaultUserAgent
    .replace(/\s+Electron\/\S+/gi, '')
    .replace(/\s+projekt[-_ ]?manga\S*\/\S+/gi, '')
    .trim();
}

export interface BrowserUserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  fullVersion?: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

/** Everything about the browser identity that a challenge can see: the User-Agent, the
 * Sec-CH-UA client hints, navigator.platform and navigator.languages. */
export interface BrowserIdentity {
  userAgent: string;
  /** navigator.platform, not the client-hint platform ("Win32" rather than "Windows"). */
  platform: string;
  acceptLanguage: string;
  userAgentMetadata: BrowserUserAgentMetadata;
  clientHints: Record<string, string>;
  /** Hints Chrome sends only when the server asked for them with Accept-CH. */
  highEntropyClientHints: Record<string, string>;
}

function parseChromiumVersion(input: string): { major: string; fullVersion: string } {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(input);
  const major = match?.[1] ?? '124';
  const [minor = '0', build = '0', patch = '0'] = match?.slice(2) ?? [];
  return { major, fullVersion: `${major}.${minor}.${build}.${patch}` };
}

/**
 * A plain Chrome identity matching the Chromium the window really is. Electron's own
 * identity is not enough: its client hints name Chromium but not Google Chrome, and its
 * User-Agent still carries Electron in subframes and workers. Chrome reduces the version
 * in the User-Agent to `<major>.0.0.0`, so do the same; the full version stays in the
 * client hints.
 */
export function browserIdentity(
  defaultUserAgent: string,
  preferredLanguages: readonly string[],
  chromiumVersion: string,
  platform: string = process.platform,
  architecture: string = process.arch,
): BrowserIdentity {
  const { major, fullVersion } = parseChromiumVersion(chromiumVersion || defaultUserAgent);
  const windows = platform === 'win32';
  const mac = platform === 'darwin';
  const metadataPlatform = windows ? 'Windows' : mac ? 'macOS' : 'Linux';
  const platformVersion = windows ? '10.0.0' : mac ? '14.0.0' : '6.5.0';
  const arm = architecture === 'arm' || architecture === 'arm64';
  const userAgent = windows
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    : mac
      ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
      : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const userAgentMetadata: BrowserUserAgentMetadata = {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not A(Brand', version: '99' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
      { brand: 'Not A(Brand', version: '99.0.0.0' },
    ],
    fullVersion,
    platform: metadataPlatform,
    platformVersion,
    architecture: arm ? 'arm' : 'x86',
    model: '',
    mobile: false,
    bitness: architecture === 'ia32' ? '32' : '64',
    wow64: false,
    formFactors: ['Desktop'],
  };
  return {
    userAgent,
    platform: windows ? 'Win32' : mac ? 'MacIntel' : 'Linux x86_64',
    acceptLanguage: acceptLanguages(preferredLanguages),
    userAgentMetadata,
    clientHints: {
      'sec-ch-ua': userAgentMetadata.brands
        .map(({ brand, version }) => `"${brand}";v="${version}"`)
        .join(', '),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${metadataPlatform}"`,
    },
    highEntropyClientHints: {
      'sec-ch-ua-full-version-list': userAgentMetadata.fullVersionList
        .map(({ brand, version }) => `"${brand}";v="${version}"`)
        .join(', '),
      'sec-ch-ua-full-version': `"${fullVersion}"`,
      'sec-ch-ua-arch': `"${userAgentMetadata.architecture}"`,
      'sec-ch-ua-bitness': `"${userAgentMetadata.bitness}"`,
      'sec-ch-ua-model': '""',
      'sec-ch-ua-platform-version': `"${platformVersion}"`,
      'sec-ch-ua-wow64': userAgentMetadata.wow64 ? '?1' : '?0',
      'sec-ch-ua-form-factors': userAgentMetadata.formFactors
        .map((factor) => `"${factor}"`)
        .join(', '),
    },
  };
}

/**
 * Rewrites the identity headers on every request in the source's session, including
 * subframe and worker requests that CDP's page-level override can miss. Header names are
 * case-insensitive, so the old spellings are removed rather than added beside.
 */
export function applyBrowserIdentityHeaders(
  headers: Record<string, string | string[]>,
  identity: BrowserIdentity,
  includeClientHints = true,
): Record<string, string | string[]> {
  const highEntropy = new Set(Object.keys(identity.highEntropyClientHints));
  const requestedHighEntropy = new Set<string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'user-agent' || lower.startsWith('sec-ch-ua')) {
      if (highEntropy.has(lower)) requestedHighEntropy.add(lower);
      delete headers[name];
    }
  }
  headers['User-Agent'] = identity.userAgent;
  if (includeClientHints) {
    for (const [name, value] of Object.entries(identity.clientHints)) headers[name] = value;
    for (const name of requestedHighEntropy) {
      headers[name] = identity.highEntropyClientHints[name];
    }
  }
  return headers;
}

/**
 * The languages for the window's Accept-Language header: the system's preferred languages,
 * which are also what the page's `navigator.languages` lists. Electron otherwise sends only
 * the app locale, and site checks treat that disagreement as a sign of automation. Electron
 * adds the quality weights itself, so the list carries none ("en-US,ja" is sent as
 * "en-US,ja;q=0.9").
 */
export function acceptLanguages(preferred: readonly string[]): string {
  const tags: string[] = [];
  for (const raw of preferred) {
    const tag = raw.trim().replace('_', '-');
    if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return (tags.length ? tags : ['en-US']).slice(0, 10).join(',');
}

export function browserSurfacePatch(options: { hidden: boolean; platform: string }): string {
  return `(() => {
  const win = window;
  const platform = ${JSON.stringify(options.platform)};
  try {
    if (!win.chrome) win.chrome = {};
    const chrome = win.chrome;
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = function () {
        const timing = performance.timing || {};
        return {
          requestTime: (timing.navigationStart || 0) / 1000,
          startLoadTime: (timing.navigationStart || 0) / 1000,
          commitLoadTime: (timing.responseStart || 0) / 1000,
          finishDocumentLoadTime: (timing.domContentLoadedEventEnd || 0) / 1000,
          finishLoadTime: (timing.loadEventEnd || 0) / 1000,
          firstPaintTime: (timing.responseStart || 0) / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      };
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = function () {
        const timing = performance.timing || {};
        return {
          startE: timing.navigationStart || 0,
          onloadT: timing.domContentLoadedEventEnd || 0,
          pageT: performance.now ? performance.now() : 0,
          tran: 15,
        };
      };
    }
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        getDetails() { return null; },
        getIsInstalled() { return false; },
        installState() {
          const callback = arguments[0];
          if (typeof callback === 'function') callback('not_installed');
        },
        runningState() { return 'cannot_run'; },
        InstallState: {
          DISABLED: 'disabled',
          INSTALLED: 'installed',
          NOT_INSTALLED: 'not_installed',
        },
        RunningState: {
          CANNOT_RUN: 'cannot_run',
          READY_TO_RUN: 'ready_to_run',
          RUNNING: 'running',
        },
      };
    }
  } catch (e) {}
  try {
    if (typeof Notification !== 'undefined') {
      const permissionGetter = Object.getOwnPropertyDescriptor({
        get permission() { return 'default'; },
      }, 'permission').get;
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        enumerable: true,
        get: permissionGetter,
      });
      Notification.requestPermission = {
        requestPermission() {
          const callback = arguments[0];
          if (typeof callback === 'function') setTimeout(() => callback('default'), 0);
          return Promise.resolve('default');
        },
      }.requestPermission;
    }
  } catch (e) {}
  try {
    const Permissions = win.Permissions;
    if (Permissions && Permissions.prototype && typeof Permissions.prototype.query === 'function') {
      const states = {
        notifications: 'prompt',
        geolocation: 'prompt',
        camera: 'prompt',
        microphone: 'prompt',
        'clipboard-read': 'prompt',
        'clipboard-write': 'granted',
        midi: 'prompt',
        'background-sync': 'granted',
        'persistent-storage': 'prompt',
        accelerometer: 'granted',
        gyroscope: 'granted',
        magnetometer: 'granted',
        'screen-wake-lock': 'granted',
        'idle-detection': 'prompt',
        'storage-access': 'granted',
        'window-management': 'prompt',
      };
      const original = Permissions.prototype.query;
      Permissions.prototype.query = {
        query(parameters) {
          const result = original.apply(this, arguments);
          const name = parameters && parameters.name;
          if (!name || !Object.prototype.hasOwnProperty.call(states, name)) return result;
          return result.then((status) => new Proxy(status, {
            get(target, property) {
              if (property === 'state') return states[name];
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }));
        },
      }.query;
    }
  } catch (e) {}
  try {
    const softwareVendor = /swiftshader|llvmpipe|basic render driver|software|microsoft/i;
    const softwareRenderer = /swiftshader|llvmpipe|basic render driver|software/i;
    const vendor = platform === 'MacIntel' ? 'Apple Inc.' : 'Google Inc. (Intel)';
    const renderer =
      platform === 'MacIntel'
        ? 'Apple M2'
        : /Linux/.test(platform)
          ? 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)'
          : 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const patch = function (proto) {
      if (!proto || typeof proto.getParameter !== 'function') return;
      const original = proto.getParameter;
      proto.getParameter = {
        getParameter(parameter) {
          const value = original.call(this, parameter);
          if (parameter === 37445 && softwareVendor.test(String(value))) return vendor;
          if (parameter === 37446 && softwareRenderer.test(String(value))) return renderer;
          return value;
        },
      }.getParameter;
    };
    patch(win.WebGLRenderingContext && win.WebGLRenderingContext.prototype);
    patch(win.WebGL2RenderingContext && win.WebGL2RenderingContext.prototype);
  } catch (e) {}
${
  options.hidden
    ? `  try {
    Object.defineProperty(Document.prototype, 'hasFocus', {
      configurable: true,
      writable: true,
      value: {
        hasFocus() { return true; },
      }.hasFocus,
    });
  } catch (e) {}`
    : ''
}
})();`;
}

/** The subset of Electron's `Cookie` this reads. */
export interface PartitionCookie {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
}

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

/**
 * Whether the window has finished a browser check: it is showing an allowed host, no
 * challenge title, and the partition holds Cloudflare's clearance cookie. Used to close
 * the hidden check window as soon as the site is usable, without waiting for a timer.
 */
export function hasPassedBrowserCheck(
  url: string,
  title: string,
  cookies: readonly PartitionCookie[],
  allowedHosts: readonly string[],
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!isHostAllowed(host, allowedHosts) || isChallengeTitle(title)) return false;
  return cookiesForAllowedHosts(cookies, allowedHosts).some(
    (cookie) => cookie.name.toLowerCase() === 'cf_clearance',
  );
}

/**
 * The partition's cookies that the source's requests would carry: those for an allowed
 * host, a subdomain of one, or a parent domain of one (Cloudflare sets its clearance on
 * the registrable domain). Third-party cookies the page picked up are left behind.
 */
export function cookiesForAllowedHosts(
  cookies: readonly PartitionCookie[],
  allowedHosts: readonly string[],
): SessionCookie[] {
  const kept: SessionCookie[] = [];
  for (const cookie of cookies) {
    const domain = (cookie.domain ?? '').replace(/^\.+/, '').toLowerCase();
    if (!domain.includes('.') || !cookie.name) continue;
    // The server's limits (sourceBrowserSessionBodySchema): one oversized cookie must
    // not cost the whole session.
    if (cookie.name.length > 256 || cookie.value.length > 4096 || domain.length > 253) continue;
    if (kept.length >= 300) break;
    const serves = allowedHosts.some(
      (allowed) =>
        allowed === domain || allowed.endsWith(`.${domain}`) || domain.endsWith(`.${allowed}`),
    );
    if (!serves) continue;
    kept.push({
      name: cookie.name,
      value: cookie.value,
      domain,
      hostOnly: cookie.hostOnly ?? false,
      path: cookie.path || '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      ...(!cookie.session && cookie.expirationDate ? { expires: cookie.expirationDate } : {}),
    });
  }
  return kept;
}
