// JRE Clipper - first-party product analytics.
// Events go to the trackEvents callable, which writes analyticsEvents/{auto} in jre-clipper-db.
// No cookies and no third-party scripts: a random visitor id lives in localStorage.
// Open any page with ?internal=1 once per browser to tag your own traffic (?internal=0 undoes it).
// Load after the Firebase SDK scripts and before the page script; pages call jreAnalytics.track().
(function () {
  const VISITOR_KEY = 'jre_vid';
  const SESSION_KEY = 'jre_session';
  const INTERNAL_KEY = 'jre_internal';
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const FLUSH_DELAY_MS = 1000;
  const MAX_BATCH = 20;

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      // Storage blocked (private mode): ids then last for this page load only.
    }
  }
  function newId() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('internal') === '1') write(INTERNAL_KEY, '1');
  if (params.get('internal') === '0') write(INTERNAL_KEY, null);
  const internal = read(INTERNAL_KEY) === '1';

  let visitorId = read(VISITOR_KEY);
  if (!visitorId || !/^[A-Za-z0-9-]{8,64}$/.test(visitorId)) {
    visitorId = newId();
    write(VISITOR_KEY, visitorId);
  }

  // A session ends after 30 idle minutes; shared across tabs.
  function sessionId() {
    const now = Date.now();
    let session = null;
    try { session = JSON.parse(read(SESSION_KEY) || 'null'); } catch (e) { session = null; }
    if (!session || typeof session.id !== 'string' || now - session.lastSeen > SESSION_IDLE_MS) {
      session = { id: newId(), lastSeen: now };
    }
    session.lastSeen = now;
    write(SESSION_KEY, JSON.stringify(session));
    return session.id;
  }

  const device = window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop';
  let queue = [];
  let flushTimer = null;

  // Resolves when the queued events are sent (or failed). Never rejects.
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (queue.length === 0 || typeof firebase === 'undefined' || !firebase.functions) return Promise.resolve();
    const sends = [];
    while (queue.length) {
      const events = queue.splice(0, MAX_BATCH);
      sends.push(firebase.functions().httpsCallable('trackEvents')({ visitorId, sessionId: sessionId(), internal, device, events })
        .catch(error => console.warn('Analytics event not recorded:', error.message)));
    }
    return Promise.all(sends);
  }

  // For events right before a navigation: waits for the send, but at most maxWaitMs.
  function flushSoon(maxWaitMs = 1500) {
    return Promise.race([flush(), new Promise(resolve => setTimeout(resolve, maxWaitMs))]);
  }

  function track(name, props) {
    queue.push({ name, props: props || {}, ts: Date.now(), path: window.location.pathname });
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  // Where this visit came from: external referrer host plus any UTM tags.
  function pageViewProps() {
    const props = {};
    try {
      const ref = document.referrer ? new URL(document.referrer) : null;
      if (ref && ref.host !== window.location.host) props.ref = ref.host;
    } catch (e) {
      // Malformed referrer; leave it out.
    }
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(key => {
      const value = params.get(key);
      if (value) props[key] = value.slice(0, 100);
    });
    if (params.get('q')) props.q = params.get('q').slice(0, 300);
    return props;
  }

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  window.jreAnalytics = { track, flushSoon, visitorId, internal };
  track('page_view', pageViewProps());
})();
