/* MY CINEMA — Service Worker
   · 앱 화면(index.html)        : 네트워크 우선 → 오프라인이면 저장본
   · 아이콘·매니페스트(같은 출처) : 캐시 우선 + 뒤에서 갱신
   · 글꼴(Pretendard CDN)       : 캐시 우선 + 뒤에서 갱신
   · TMDB 포스터·배경 이미지     : 캐시 우선(개수 제한) — 한 번 본 포스터는 오프라인에서도 보임
   · TMDB API · Supabase        : 절대 가로채지 않음 (키가 담긴 요청·데이터는 캐시하지 않음)      */
const VERSION = 'mycinema-v1.0.0';
const SHELL = `${VERSION}-shell`;
const CDN = `${VERSION}-cdn`;
const IMG_SM = 'mycinema-img-sm';   // 포스터·썸네일 — 버전이 바뀌어도 유지
const IMG_LG = 'mycinema-img-lg';   // 큰 배경 이미지 — 버전이 바뀌어도 유지
const KEEP = [IMG_SM, IMG_LG];
const LIMIT = { [IMG_SM]: 900, [IMG_LG]: 90 };

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))))
  );
  // 첫 설치는 바로 활성화, 업데이트는 앱에서 [새로고침]을 눌렀을 때 활성화
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION) && !KEEP.includes(k)).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (_) {} }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const d = event.data;
  if (d === 'SKIP_WAITING') self.skipWaiting();
  if (d === 'CACHE_INFO') event.waitUntil(cacheInfo().then(info => event.source && event.source.postMessage({ type: 'CACHE_INFO', ...info })));
  if (d === 'CLEAR_IMAGES') event.waitUntil(Promise.all(KEEP.map(k => caches.delete(k))).then(() => event.source && event.source.postMessage({ type: 'CACHE_CLEARED' })));
});

async function cacheInfo() {
  let images = 0;
  for (const k of KEEP) { try { images += (await (await caches.open(k)).keys()).length; } catch (_) {} }
  return { version: VERSION, images };
}

const trimTimers = {};
function trimLater(name) {
  clearTimeout(trimTimers[name]);
  trimTimers[name] = setTimeout(async () => {
    const c = await caches.open(name); const keys = await c.keys();
    const over = keys.length - LIMIT[name];
    for (let i = 0; i < over; i++) await c.delete(keys[i]);   // 오래된 것부터 정리
  }, 4000);
}

async function pageResponse(event) {
  const cache = await caches.open(SHELL);
  try {
    const pre = event.preloadResponse ? await event.preloadResponse : null;
    const res = pre || await fetch(event.request);
    if (res && res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch (_) {
    return (await cache.match('./index.html')) || (await cache.match('./')) ||
      new Response('<!doctype html><meta charset="utf-8"><title>MY CINEMA</title><body style="background:#0a130e;color:#f4f2ee;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>오프라인입니다. 인터넷에 연결한 뒤 다시 열어 주세요.</p></body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  const net = fetch(event.request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(event.request, res.clone());
    return res;
  }).catch(() => null);
  if (hit) { event.waitUntil(net); return hit; }
  return (await net) || Response.error();
}

async function tmdbImage(event, url) {
  const big = /\/t\/p\/(w780|w1280|original)\//.test(url.pathname);
  const name = big ? IMG_LG : IMG_SM;
  const cache = await caches.open(name);
  const key = url.href;
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    // TMDB 이미지 서버는 CORS를 허용 → 크기를 알 수 있는 정상 응답으로 받아 저장 (불투명 응답 저장 방지)
    const res = await fetch(key, { mode: 'cors', credentials: 'omit' });
    if (res.ok) { event.waitUntil(cache.put(key, res.clone()).then(() => trimLater(name))); }
    return res;
  } catch (_) {
    try { return await fetch(event.request); } catch (e) { return Response.error(); }
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 데이터·키가 오가는 요청은 그대로 통과
  if (url.hostname === 'api.themoviedb.org' || url.hostname.endsWith('.supabase.co') || url.pathname.includes('/rest/v1/')) return;

  if (req.mode === 'navigate' && url.origin === self.location.origin) { event.respondWith(pageResponse(event)); return; }
  if (url.hostname === 'image.tmdb.org') { event.respondWith(tmdbImage(event, url)); return; }
  if (CDN_HOSTS.includes(url.hostname)) { event.respondWith(staleWhileRevalidate(event, CDN)); return; }
  if (url.origin === self.location.origin) { event.respondWith(staleWhileRevalidate(event, SHELL)); return; }
});
