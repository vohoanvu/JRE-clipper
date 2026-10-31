// JRE Clipper - Main JavaScript Application
// Search, AI answer, YouTube players and compilation requests for index.html.
// Every Google API is reached through Firebase callable functions; the browser
// never holds a Google access token.

// ===== CONSTANTS =====
const SEARCH_PLACEHOLDER = 'e.g. Jiu Jitsu, Bears, Bees, Aliens, Psychedelic Drugs';
// Mirrors the server-side limits enforced by createVideoJob.
const MAX_SEGMENTS = 30;
const MAX_SEGMENT_SECONDS = 600;
const MAX_TOTAL_SECONDS = 1200;
const DAILY_VIDEO_LIMIT = 5;
const LIMITS_HINT = `Free for signed-in users: up to ${DAILY_VIDEO_LIMIT} videos per day, max ${MAX_SEGMENTS} segments and ${MAX_TOTAL_SECONDS / 60} minutes per video.`;
const DEFAULT_SORT = 'newest';

const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// ===== STATE =====
let functionsClient = null;
let lastSearch = null;        // { query, results, session, queryId }
let searchSeq = 0;            // bumped per search so stale async responses are ignored
let searchInFlight = false;
let selectedSegments = [];
let activePlayerId = null;    // only one live YouTube iframe at a time; others are thumbnails
const defaultTitle = document.title;

// DOM element references (set after DOM loads)
let searchInput, searchButton, exampleQueries;
let searchResultsContainer, answerSection, videoPlayersContainer;

// analytics.js loads first; if it failed, events are simply dropped.
function track(name, props) {
  window.jreAnalytics?.track(name, props);
}

// ===== DOM INITIALIZATION =====
document.addEventListener('DOMContentLoaded', function () {
  searchInput = document.getElementById('searchInput');
  searchButton = document.getElementById('searchButton');
  exampleQueries = document.getElementById('example-queries');
  searchResultsContainer = document.getElementById('search-results');
  answerSection = document.getElementById('answer-section');
  videoPlayersContainer = document.getElementById('video-players-container');

  initializeApp();
});

// ===== APPLICATION INITIALIZATION =====
function initializeApp() {
  if (typeof firebase === 'undefined') {
    searchInput.placeholder = 'Could not load. Please refresh the page.';
    console.error('Firebase SDK is not loaded');
    return;
  }

  initializeAuth();
  setupEventListeners();

  searchInput.disabled = false;
  searchButton.disabled = false;
  searchInput.placeholder = SEARCH_PLACEHOLDER;

  // Shared links, status.html's back link and the browser's back/forward carry ?q=<query>.
  searchFromUrl('url');
}

function searchFromUrl(source) {
  const query = (new URLSearchParams(window.location.search).get('q') || '').trim();
  if (query) {
    searchInput.value = query;
    performSearch(query, source);
  } else if (source === 'history') {
    resetResults();
    searchInput.value = '';
    document.title = defaultTitle;
  }
}

function setupEventListeners() {
  searchButton.addEventListener('click', () => performSearch(searchInput.value, 'typed'));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') performSearch(searchInput.value, 'typed');
  });
  exampleQueries?.addEventListener('click', (event) => {
    const example = event.target.closest('[data-query]');
    if (!example) return;
    searchInput.value = example.dataset.query;
    performSearch(example.dataset.query, 'example');
  });
  window.addEventListener('popstate', () => searchFromUrl('history'));

  const signOutBtn = document.getElementById('sign-out');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      firebase.auth().signOut().then(() => window.location.reload());
    });
  }

  // One delegated click listener per results area.
  videoPlayersContainer.addEventListener('click', handleResultsClick);
  answerSection.addEventListener('click', handleResultsClick);
  searchResultsContainer.addEventListener('click', handleResultsClick);
  videoPlayersContainer.addEventListener('change', (event) => {
    if (event.target.classList.contains('segment-checkbox')) updateSelectedSegments();
    if (event.target.id === 'resultsSort') sortVideoCards(event.target.value);
  });
}

function handleResultsClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || !event.currentTarget.contains(target)) return;

  switch (target.dataset.action) {
    case 'play':
      track('moment_play', { videoId: target.dataset.videoId, start: Number(target.dataset.start), via: 'thumbnail' });
      activatePlayer(target.dataset.videoId, Number(target.dataset.start));
      break;
    case 'seek':
      track('moment_play', {
        videoId: target.dataset.videoId, start: Number(target.dataset.start), via: target.dataset.via || 'seek'
      });
      seekToTime(target.dataset.videoId, Number(target.dataset.start), target);
      break;
    case 'youtube':
      // A plain link; only recorded here.
      track('youtube_open', { videoId: target.dataset.videoId, start: Number(target.dataset.start) });
      break;
    case 'copy-citation':
      copyCitation(target);
      break;
    case 'copy-search-link':
      copySearchLink(target);
      break;
    case 'toggle-video':
      toggleVideoSelection(target.closest('.video-container'));
      break;
    case 'select-all':
      setAllCheckboxes(true);
      break;
    case 'clear-selection':
      setAllCheckboxes(false);
      break;
    case 'generate':
      initiateVideoGeneration();
      break;
    case 'dismiss-status':
      hideGenerationStatus();
      break;
    case 'resend-verification':
      resendVerificationEmail(target);
      break;
  }
}

// ===== FIREBASE HELPERS =====
function callFunction(name, data, options) {
  functionsClient ??= firebase.functions();
  return functionsClient.httpsCallable(name, options)(data).then(result => result.data);
}

// Callable errors arrive as "functions/<code>" in SDK v9+.
function errorCode(error) {
  return String(error?.code || '').replace(/^functions\//, '');
}

// ===== AUTHENTICATION =====
function initializeAuth() {
  firebase.auth().onAuthStateChanged(user => {
    const authButtonsContainer = document.getElementById('auth-buttons');
    const userInfoContainer = document.getElementById('user-info');

    if (user) {
      if (authButtonsContainer) authButtonsContainer.style.display = 'none';
      if (userInfoContainer) userInfoContainer.style.display = 'flex';

      const userPhoto = document.getElementById('user-photo');
      const userEmail = document.getElementById('user-email');
      if (userPhoto) {
        if (user.photoURL) {
          userPhoto.src = user.photoURL;
          userPhoto.style.display = '';
        } else {
          userPhoto.style.display = 'none';
        }
      }
      if (userEmail) userEmail.textContent = user.email || user.displayName || '';
    } else {
      if (authButtonsContainer) authButtonsContainer.style.display = 'block';
      if (userInfoContainer) userInfoContainer.style.display = 'none';
    }

    updateGenerateVideoButton();
  });
}

// ===== SEARCH FUNCTIONALITY =====
function resetResults() {
  searchResultsContainer.innerHTML = '';
  answerSection.innerHTML = '';
  videoPlayersContainer.innerHTML = '';
  selectedSegments = [];
  activePlayerId = null;
}

// Puts the query in the address bar so results can be shared, bookmarked and navigated with Back.
// UTM tags are dropped so a shared link doesn't carry the sharer's campaign.
function syncUrl(query, source) {
  if (source === 'url' || source === 'history') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('q') === query) return;
  url.searchParams.set('q', query);
  UTM_PARAMS.concat('internal').forEach(key => url.searchParams.delete(key));
  history.pushState(null, '', url.pathname + url.search);
}

// source: typed | example | url | history (back/forward)
async function performSearch(rawQuery, source = 'typed') {
  const query = (rawQuery || '').trim();
  if (!query || searchInFlight) return;

  searchInFlight = true;
  const seq = ++searchSeq;
  const startedAt = performance.now();

  searchInput.placeholder = 'Searching...';
  searchButton.setAttribute('aria-busy', 'true');
  resetResults();
  syncUrl(query, source);
  document.title = `${query} - what Joe Rogan said | JRE Clipper`;

  recordSearchActivity(query);

  try {
    const data = await callFunction('searchSegments', {
      query,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    if (seq !== searchSeq) return;

    lastSearch = {
      query,
      results: Array.isArray(data?.results) ? data.results : [],
      session: data?.session || null,
      queryId: data?.queryId || null
    };
    track('search', {
      query,
      source,
      results: lastSearch.results.length,
      episodes: new Set(lastSearch.results.map(item => item.videoId)).size,
      ms: Math.round(performance.now() - startedAt)
    });

    if (lastSearch.results.length > 0) {
      // Answer and player metadata load in parallel; both ignore stale responses.
      generateAnswer(seq, lastSearch);
      displaySearchSummary(lastSearch.results);
      loadVideoPlayers(seq, lastSearch.results);
    } else {
      displaySearchSummary(lastSearch.results);
    }
  } catch (error) {
    if (seq !== searchSeq) return;
    console.error('Search failed:', error);
    track('search', { query, source, error: errorCode(error) || 'unknown' });
    searchResultsContainer.innerHTML = `<p style="color: red;">Search failed: ${escapeHtml(error.message || 'Unknown error')}</p>`;
  } finally {
    searchInFlight = false;
    searchInput.placeholder = SEARCH_PLACEHOLDER;
    searchButton.removeAttribute('aria-busy');
  }
}

function displaySearchSummary(results) {
  if (results.length === 0) {
    searchResultsContainer.innerHTML = '<p>No results found. Try different words, or a broader topic.</p>';
    return;
  }

  // Group results by video (insertion order = first appearance)
  const videoGroups = new Map();
  results.forEach(item => {
    if (!videoGroups.has(item.videoId)) {
      videoGroups.set(item.videoId, { title: item.videoTitle, count: 0 });
    }
    videoGroups.get(item.videoId).count++;
  });

  let html = `
    <div class="results-summary-header">
      <h3>Found ${results.length} moments in ${videoGroups.size} episodes</h3>
      <button type="button" class="link-btn" data-action="copy-search-link">🔗 Copy link to these results</button>
    </div>`;
  html += '<div style="background: #f5f5f5; padding: 1rem; border-radius: 4px; margin: 1rem 0;">';
  videoGroups.forEach(group => {
    html += `<div style="margin-bottom: 0.5rem; color: #2c3e50;">
      <strong>${escapeHtml(group.title)}</strong> - ${group.count} moment${group.count > 1 ? 's' : ''}
    </div>`;
  });
  html += '</div>';
  html += '<p style="color: #666; font-style: italic;">Watch the moments below...</p>';

  searchResultsContainer.innerHTML = html;
}

function recordSearchActivity(query) {
  callFunction('recordSearchActivity', {
    searchQuery: query,
    sessionId: window.jreAnalytics?.visitorId || null,
    internal: window.jreAnalytics?.internal === true,
    userAgent: navigator.userAgent,
  }).catch(error => console.error('Failed to record search activity:', error));
}

// ===== AI SUMMARY =====
function answerHeaderHtml(query) {
  return `<div class="answer-header">📝 What was said about "${escapeHtml(query)}"</div>`;
}

async function generateAnswer(seq, search) {
  answerSection.innerHTML = `
    <div class="answer-section">
      ${answerHeaderHtml(search.query)}
      <div class="answer-loading">
        <div class="gemini-loading">
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
        <span>Summarizing the matching moments<span class="dots"></span></span>
      </div>
    </div>
  `;

  try {
    const data = await callFunction('answerQuery', {
      query: search.query,
      session: search.session,
      queryId: search.queryId
    }, { timeout: 95000 });
    if (seq !== searchSeq) return;
    displayAnswer(data?.answerText, Array.isArray(data?.sourceIds) ? data.sourceIds : [], search);
  } catch (error) {
    if (seq !== searchSeq) return;
    console.error('Answer generation failed:', error);
    track('answer_shown', { ok: false });
    answerSection.innerHTML = `
      <div class="answer-section">
        ${answerHeaderHtml(search.query)}
        <div class="answer-error">
          Could not summarize these moments: ${escapeHtml(error.message || 'Unknown error')}
        </div>
      </div>
    `;
  }
}

// sourceIds are search result ids; each becomes a link that plays that moment.
function displayAnswer(answerText, sourceIds, search) {
  if (!answerText) {
    track('answer_shown', { ok: false });
    answerSection.innerHTML = `
      <div class="answer-section">
        ${answerHeaderHtml(search.query)}
        <div class="answer-error">
          No summary for this search. The moments below are still the best matches.
        </div>
      </div>
    `;
    return;
  }

  const byId = new Map(search.results.filter(item => item.id).map(item => [item.id, item]));
  const sources = sourceIds.map(id => byId.get(id)).filter(Boolean);
  track('answer_shown', { ok: true, sources: sources.length });

  answerSection.innerHTML = `
    <div class="answer-section">
      ${answerHeaderHtml(search.query)}
      <div class="answer-content"></div>
      ${sources.length ? `
        <div class="answer-sources">
          <div class="answer-sources-title">Sources</div>
          <ol>
            ${sources.map(source => `
              <li>
                <button type="button" class="answer-source" data-action="seek" data-via="answer"
                        data-video-id="${escapeHtml(source.videoId)}" data-start="${Number(source.startTime)}">
                  ${escapeHtml(source.videoTitle || 'Episode')} · ${formatTimeHMS(source.startTime)}
                </button>
              </li>`).join('')}
          </ol>
        </div>` : ''}
      <p class="answer-disclaimer">AI-generated summary of the transcripts. It can be wrong, so check the moments it cites.</p>
    </div>
  `;
  answerSection.querySelector('.answer-content').innerHTML = renderAnswerMarkdown(answerText);
}

// The model writes a little markdown (**bold**, "* " bullets). Everything is HTML-escaped first,
// so only these two constructs ever become markup.
function renderAnswerMarkdown(text) {
  const inline = line => escapeHtml(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const html = [];
  let list = [];
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map(item => `<li>${item}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const bullet = /^[*-]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(inline(bullet[1]));
      continue;
    }
    flushList();
    if (line) html.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return html.join('');
}

// ===== VIDEO PLAYER FUNCTIONALITY =====
async function loadVideoPlayers(seq, results) {
  videoPlayersContainer.innerHTML = '<div class="loading">Loading video players...</div>';

  const groups = new Map(); // videoId -> segments, in first-appearance order
  results.forEach(item => {
    if (!groups.has(item.videoId)) groups.set(item.videoId, []);
    groups.get(item.videoId).push({
      videoId: item.videoId,
      startTimeSeconds: item.startTime,
      endTimeSeconds: item.endTime,
      videoTitle: item.videoTitle,
      snippet: typeof item.snippet === 'string' ? item.snippet : ''
    });
  });

  try {
    const data = await callFunction('getVideoMetadata', { videoIds: [...groups.keys()] });
    if (seq !== searchSeq) return;
    if (!data || !data.success) {
      throw new Error('Invalid response from video metadata service');
    }
    renderVideoPlayers(groups, data.videos || {}, data.available || {});
  } catch (error) {
    if (seq !== searchSeq) return;
    console.error('Error fetching video metadata:', error);

    const code = errorCode(error);
    let errorMessage = 'Failed to load video players';
    if (code === 'permission-denied') {
      errorMessage = 'YouTube API access denied. Please check API key configuration.';
    } else if (code === 'resource-exhausted') {
      errorMessage = 'YouTube API quota exceeded. Please try again later.';
    } else if (error.message) {
      errorMessage += ': ' + error.message;
    }
    videoPlayersContainer.innerHTML = `<p style="color: red;">${escapeHtml(errorMessage)}</p>`;
  }
}

// available[videoId] === false: no source MP4 yet, so the segments can be watched but not selected.
function renderVideoPlayers(groups, videos, available) {
  const cards = [];
  let rank = 0; // position in the search ranking, for the "Most relevant" sort

  groups.forEach((segments, videoId) => {
    rank++;
    const videoMetadata = videos[videoId];
    if (!videoMetadata) {
      console.warn(`No metadata available for video ${videoId}`);
      return;
    }

    const title = videoMetadata.title || segments[0].videoTitle || 'JRE Episode';
    const details = [
      videoMetadata.channelTitle || '',
      videoMetadata.viewCount ? parseInt(videoMetadata.viewCount, 10).toLocaleString() + ' views' : '',
      videoMetadata.publishedAt ? new Date(videoMetadata.publishedAt).toLocaleDateString() : ''
    ].join(' • ');
    const selectable = available[videoId] !== false;
    const published = Date.parse(videoMetadata.publishedAt || '');

    cards.push(`
      <div class="video-container${selectable ? '' : ' video-unavailable'}"
           data-rank="${rank}" data-published="${Number.isFinite(published) ? published : ''}">
        <div class="video-header">
          <div class="video-title">${escapeHtml(title)}</div>
          <div class="video-controls">
            ${selectable ? `
              <button class="select-video-btn" data-action="toggle-video">
                📋 Select All (${segments.length})
              </button>` : `
              <span class="video-unavailable-badge">⏳ Video not available yet</span>`}
          </div>
        </div>
        <div style="font-size: 0.9rem; color: #666; margin-bottom: 1rem;">${escapeHtml(details)}</div>
        ${selectable ? '' : `
          <p class="video-unavailable-note">This episode isn't in our video library yet, so its segments can't go into a compilation. You can still watch them here.</p>`}
        ${playerFacadeHtml(videoId, title, segments[0].startTimeSeconds)}
        <div class="segments-list">
          <div class="segments-header">Relevant Segments (${segments.length}):</div>
          ${segments.map(segment => segmentHtml(segment, title, selectable)).join('')}
        </div>
      </div>
    `);
  });

  if (cards.length === 0) {
    videoPlayersContainer.innerHTML = '<p>No videos found.</p>';
    return;
  }

  videoPlayersContainer.innerHTML = `
    <div class="video-generation-controls">
      <h3>🎬 Generate Custom Video Clips</h3>
      <p>Select segments below to generate a custom video compilation:</p>
      <div class="generation-buttons">
        <button id="generateVideoBtn" class="generate-video-btn" data-action="generate" disabled>
          📹 Generate Compilation Video (0 segments selected)
        </button>
        <button class="select-all-btn" data-action="select-all">
          ☑️ Select All Segments
        </button>
        <button class="clear-selection-btn" data-action="clear-selection">
          ❌ Clear Selection
        </button>
      </div>
      <p id="selection-hint" class="generation-limits">${escapeHtml(LIMITS_HINT)}</p>
      <div id="generation-status" class="generation-status"></div>
    </div>
    <div class="results-toolbar">
      <label for="resultsSort">Sort episodes by</label>
      <select id="resultsSort">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="relevance">Most relevant</option>
      </select>
    </div>
    <div class="videos-grid">${cards.join('')}</div>
  `;

  const sortSelect = document.getElementById('resultsSort');
  sortSelect.value = DEFAULT_SORT;
  sortVideoCards(sortSelect.value);
}

// Reorders the rendered cards in place, so checkbox state survives. The compilation
// follows the on-screen order (updateSelectedSegments walks the DOM), so it is rebuilt.
// Episodes without a publish date go last in either date order.
function sortVideoCards(order) {
  const grid = videoPlayersContainer.querySelector('.videos-grid');
  if (!grid) return;

  const published = card => card.dataset.published ? Number(card.dataset.published) : null;
  const byRank = (a, b) => Number(a.dataset.rank) - Number(b.dataset.rank);
  const cards = Array.from(grid.children).sort((a, b) => {
    if (order === 'relevance') return byRank(a, b);
    const pa = published(a), pb = published(b);
    if (pa === null || pb === null) return (pa === null) - (pb === null) || byRank(a, b);
    return (order === 'oldest' ? pa - pb : pb - pa) || byRank(a, b);
  });
  cards.forEach(card => grid.appendChild(card));

  updateSelectedSegments();
}

function segmentHtml(segment, title, selectable) {
  const videoId = escapeHtml(segment.videoId);
  const start = segment.startTimeSeconds;
  const end = segment.endTimeSeconds;
  const checkboxId = `segment_${videoId}_${start}_${end}`;
  return `
    <div class="segment-item">
      <div class="segment-selection">
        <input type="checkbox"
               id="${checkboxId}"
               class="segment-checkbox"
               data-video-id="${videoId}"
               data-start="${start}"
               data-end="${end}"
               data-title="${escapeHtml(title)}"
               ${selectable ? '' : 'disabled'}>
        <label for="${checkboxId}" class="segment-checkbox-label">${selectable ? 'Select' : 'Watch only'}</label>
      </div>
      <div class="segment-content">
        <div class="segment-timestamp-text">At ${formatTimeHMS(start)}</div>
        ${segment.snippet ? `<blockquote class="segment-snippet">“${escapeHtml(segment.snippet)}”</blockquote>` : ''}
        <div class="segment-actions">
          <button type="button" class="link-btn" data-action="copy-citation" data-video-id="${videoId}"
                  data-start="${start}" data-title="${escapeHtml(title)}" data-snippet="${escapeHtml(segment.snippet)}">
            📋 Copy citation
          </button>
          <a class="link-btn" href="${escapeHtml(youtubeWatchUrl(segment.videoId, start))}" target="_blank" rel="noopener"
             data-action="youtube" data-video-id="${videoId}" data-start="${start}">
            ↗ Open on YouTube
          </a>
        </div>
      </div>
      <button class="skip-btn" data-action="seek" data-video-id="${videoId}" data-start="${start}">
        SKIP TO
      </button>
    </div>
  `;
}

function youtubeWatchUrl(videoId, startSeconds) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(startSeconds)}s`;
}

// e.g. “… black bears attack people as predators …” (Joe Rogan Experience #1883 - Ryan Graves, 1:42:02) https://youtu.be/…?t=6122
function citationText({ videoId, start, title, snippet }) {
  const quote = snippet ? `“${snippet}” ` : '';
  return `${quote}(${title}, ${formatTimeHMS(start)}) https://youtu.be/${videoId}?t=${Math.floor(start)}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    // Clipboard API unavailable (insecure context, old browser): fall back to a hidden textarea.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function flashButton(button, message) {
  const original = button.dataset.label || button.textContent.trim();
  button.dataset.label = original;
  button.textContent = message;
  setTimeout(() => { button.textContent = original; }, 2000);
}

async function copyCitation(button) {
  const { videoId, title, snippet } = button.dataset;
  const start = Number(button.dataset.start);
  const copied = await copyText(citationText({ videoId, start, title, snippet }));
  flashButton(button, copied ? '✅ Copied' : 'Copy failed');
  if (copied) track('citation_copy', { videoId, start });
}

async function copySearchLink(button) {
  if (!lastSearch) return;
  const url = `${window.location.origin}/?q=${encodeURIComponent(lastSearch.query)}`;
  const copied = await copyText(url);
  flashButton(button, copied ? '✅ Link copied' : 'Copy failed');
  if (copied) track('search_link_copy', { query: lastSearch.query });
}

// Click-to-load facade: a thumbnail instead of a YouTube iframe. Each iframe
// pulls ~1 MB of player JS, so only the player the user interacts with is loaded.
// Playing from the thumbnail starts at the first matching segment.
function playerFacadeHtml(videoId, title, startSeconds) {
  const id = escapeHtml(videoId);
  const safeTitle = escapeHtml(title);
  const start = Number.isFinite(startSeconds) ? startSeconds : 0;
  return `
    <button class="video-embed video-facade" id="player-${id}" data-action="play" data-video-id="${id}"
            data-title="${safeTitle}" data-start="${start}" aria-label="Play: ${safeTitle}">
      <img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="" loading="lazy" decoding="async">
      <span class="video-facade-play" aria-hidden="true"></span>
    </button>
  `;
}

function createElementFromHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function embedUrl(videoId, startSeconds) {
  const params = new URLSearchParams({ rel: '0', autoplay: '1' });
  if (Number.isFinite(startSeconds)) params.set('start', String(Math.floor(startSeconds)));
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

// Loads (or re-targets) the iframe for videoId and turns the previously
// active player back into a thumbnail.
function activatePlayer(videoId, startSeconds) {
  if (activePlayerId && activePlayerId !== videoId) {
    const previous = document.getElementById(`player-${activePlayerId}`);
    if (previous && previous.tagName === 'IFRAME') {
      previous.replaceWith(createElementFromHtml(
        playerFacadeHtml(activePlayerId, previous.dataset.title || '', Number(previous.dataset.start))));
    }
  }

  const current = document.getElementById(`player-${videoId}`);
  if (!current) {
    console.error(`Could not find player for video: ${videoId}`);
    return null;
  }

  const src = embedUrl(videoId, startSeconds);
  let iframe = current;
  if (current.tagName === 'IFRAME') {
    current.src = src;
  } else {
    iframe = document.createElement('iframe');
    iframe.id = `player-${videoId}`;
    iframe.className = 'video-embed';
    iframe.dataset.title = current.dataset.title || '';
    iframe.dataset.start = current.dataset.start || '';
    iframe.title = current.dataset.title || 'YouTube video player';
    iframe.src = src;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allowFullscreen = true;
    current.replaceWith(iframe);
  }
  activePlayerId = videoId;
  return iframe;
}

// An AI-summary source can be clicked before its card has rendered; open it on YouTube instead.
function seekToTime(videoId, startTime, button) {
  const iframe = document.getElementById(`player-${videoId}`) ? activatePlayer(videoId, startTime) : null;
  if (!iframe) {
    window.open(youtubeWatchUrl(videoId, startTime), '_blank', 'noopener');
    return;
  }

  iframe.scrollIntoView({ behavior: 'smooth', block: 'center' });

  if (button?.classList.contains('skip-btn')) {
    button.textContent = 'LOADING...';
    button.disabled = true;
    setTimeout(() => {
      button.textContent = 'SKIP TO';
      button.disabled = false;
    }, 2000);
  }
}

// ===== SEGMENT SELECTION =====
function updateSelectedSegments() {
  selectedSegments = [];
  videoPlayersContainer.querySelectorAll('.segment-checkbox').forEach(checkbox => {
    checkbox.closest('.segment-item').classList.toggle('selected', checkbox.checked);
    if (checkbox.checked) {
      selectedSegments.push({
        videoId: checkbox.dataset.videoId,
        startTimeSeconds: Number(checkbox.dataset.start),
        endTimeSeconds: Number(checkbox.dataset.end),
        videoTitle: checkbox.dataset.title
      });
    }
  });

  videoPlayersContainer.querySelectorAll('.video-container').forEach(container => {
    const button = container.querySelector('[data-action="toggle-video"]');
    const boxes = container.querySelectorAll('.segment-checkbox');
    const allChecked = boxes.length > 0 && Array.from(boxes).every(box => box.checked);
    if (button) {
      button.textContent = allChecked ? `✅ All Selected (${boxes.length})` : `📋 Select All (${boxes.length})`;
    }
  });

  updateGenerateVideoButton();
}

function setAllCheckboxes(checked) {
  videoPlayersContainer.querySelectorAll('.segment-checkbox:not(:disabled)').forEach(checkbox => {
    checkbox.checked = checked;
  });
  updateSelectedSegments();
}

function toggleVideoSelection(container) {
  if (!container) return;
  const boxes = container.querySelectorAll('.segment-checkbox:not(:disabled)');
  const shouldCheck = !Array.from(boxes).some(box => box.checked);
  boxes.forEach(box => { box.checked = shouldCheck; });
  updateSelectedSegments();
}

function selectionProblem() {
  let total = 0;
  for (const segment of selectedSegments) {
    const duration = segment.endTimeSeconds - segment.startTimeSeconds;
    if (duration > MAX_SEGMENT_SECONDS) return `Each segment must be ${MAX_SEGMENT_SECONDS / 60} minutes or shorter.`;
    total += duration;
  }
  if (selectedSegments.length > MAX_SEGMENTS) return `Select at most ${MAX_SEGMENTS} segments.`;
  if (total > MAX_TOTAL_SECONDS) {
    return `Your selection is ${formatTime(total)} long; the maximum is ${MAX_TOTAL_SECONDS / 60} minutes.`;
  }
  return null;
}

function updateGenerateVideoButton() {
  const button = document.getElementById('generateVideoBtn');
  if (!button) return;

  const count = selectedSegments.length;
  const plural = count !== 1 ? 's' : '';
  const totalSeconds = selectedSegments.reduce((sum, s) => sum + (s.endTimeSeconds - s.startTimeSeconds), 0);
  const problem = selectionProblem();
  const signedIn = !!firebase.auth().currentUser;

  if (signedIn) {
    button.textContent = `📹 Generate Compilation Video (${count} segment${plural} selected${count ? `, ${formatTime(totalSeconds)}` : ''})`;
    button.title = count === 0
      ? 'Select at least one segment to generate compilation video'
      : `Generate compilation video from ${count} selected segment${plural}`;
    button.classList.remove('requires-signin');
  } else {
    button.textContent = `🔒 Generate Compilation Video (Sign In Required) - ${count} segment${plural} selected`;
    button.title = count === 0
      ? 'Select segments and sign in (free) to generate a compilation video'
      : `Sign in (free) to generate a compilation video from ${count} selected segment${plural}`;
    button.classList.add('requires-signin');
  }
  if (problem) button.title = problem;
  button.disabled = count === 0 || !!problem;

  const hint = document.getElementById('selection-hint');
  if (hint) {
    hint.textContent = problem || LIMITS_HINT;
    hint.classList.toggle('warning', !!problem);
  }
}

// ===== VIDEO GENERATION =====
function showGenerationStatus(html, type = 'processing') {
  const statusDiv = document.getElementById('generation-status');
  if (!statusDiv) return;
  statusDiv.className = `generation-status ${type}`;
  statusDiv.innerHTML = html;
}

function hideGenerationStatus() {
  const statusDiv = document.getElementById('generation-status');
  if (!statusDiv) return;
  statusDiv.className = 'generation-status';
  statusDiv.innerHTML = '';
}

async function initiateVideoGeneration() {
  if (selectedSegments.length === 0) return;

  const signedIn = !!firebase.auth().currentUser;
  track('compile_click', { segments: selectedSegments.length, signedIn });
  if (!signedIn) {
    showSignInModal();
    return;
  }

  const problem = selectionProblem();
  if (problem) {
    showGenerationStatus(`<p>${escapeHtml(problem)}</p>`, 'error');
    return;
  }

  if (!(await ensureEmailVerified())) {
    showVerifyEmailStatus();
    return;
  }

  const button = document.getElementById('generateVideoBtn');
  if (button) {
    button.disabled = true;
    button.textContent = '⚙️ Starting...';
  }
  showGenerationStatus(`
    <div style="display: flex; align-items: center; gap: 0.5rem; justify-content: center;">
      <div class="gemini-loading">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
      <span>Starting video generation job...</span>
    </div>
  `, 'processing');

  try {
    const data = await callFunction('createVideoJob', {
      segments: selectedSegments.map(({ videoId, startTimeSeconds, endTimeSeconds, videoTitle }) =>
        ({ videoId, startTimeSeconds, endTimeSeconds, videoTitle }))
    });

    try {
      localStorage.setItem('lastSearchQuery', lastSearch?.query || '');
    } catch (storageError) {
      // Storage can be unavailable (private mode); the back link just won't prefill.
    }

    track('job_created', {
      segments: data.segmentCount ?? selectedSegments.length,
      seconds: Math.round(selectedSegments.reduce((sum, s) => sum + (s.endTimeSeconds - s.startTimeSeconds), 0))
    });
    await window.jreAnalytics?.flushSoon();
    window.location.href = `status.html?jobId=${encodeURIComponent(data.jobId)}`;
  } catch (error) {
    console.error('Video generation failed:', error);
    const code = errorCode(error);

    if (code === 'unauthenticated') {
      hideGenerationStatus();
      showSignInModal();
    } else if (code === 'failed-precondition' && error.details?.reason === 'email-unverified') {
      showVerifyEmailStatus();
    } else {
      const showTips = code !== 'resource-exhausted' && code !== 'invalid-argument';
      showGenerationStatus(`
        <div>
          <h4>❌ Could not start video generation</h4>
          <p>${escapeHtml(error.message || 'Unknown error')}</p>
          ${showTips ? `
            <p style="margin-top: 1rem;">
              <strong>Possible solutions:</strong><br>
              • Check your internet connection<br>
              • Try selecting fewer segments<br>
              • Wait a moment and try again
            </p>` : ''}
          <button data-action="dismiss-status" style="margin-top: 1rem; padding: 0.5rem 1rem; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
            Dismiss
          </button>
        </div>
      `, 'error');
    }
    updateGenerateVideoButton();
  }
}

// ===== EMAIL VERIFICATION =====
// createVideoJob requires a verified email. Google accounts always are; email/password
// users get a verification link (sent at sign-up, resendable here).
async function ensureEmailVerified() {
  const user = firebase.auth().currentUser;
  if (!user) return false;
  if (user.emailVerified) return true;
  try {
    await user.reload(); // the link may have been clicked in another tab
  } catch (error) {
    console.error('Could not refresh the user record:', error);
  }
  if (!firebase.auth().currentUser?.emailVerified) return false;
  await user.getIdToken(true); // the server reads email_verified from the ID token
  return true;
}

function showVerifyEmailStatus() {
  const email = firebase.auth().currentUser?.email || 'your email address';
  showGenerationStatus(`
    <div>
      <h4>📧 Please verify your email</h4>
      <p>Video generation needs a verified email address. Click the link we sent to <strong>${escapeHtml(email)}</strong>, then try again.</p>
      <p class="verify-email-result" hidden></p>
      <div class="verify-email-actions">
        <button data-action="generate">I've verified, try again</button>
        <button class="secondary" data-action="resend-verification">Resend the email</button>
        <button class="secondary" data-action="dismiss-status">Dismiss</button>
      </div>
    </div>
  `, 'error');
}

async function resendVerificationEmail(button) {
  const user = firebase.auth().currentUser;
  const result = document.querySelector('#generation-status .verify-email-result');
  if (!user || !result) return;
  button.disabled = true;
  try {
    await user.sendEmailVerification();
    result.textContent = `Sent. Check your inbox (and spam folder) for ${user.email}.`;
  } catch (error) {
    console.error('sendEmailVerification failed:', error);
    result.textContent = error.code === 'auth/too-many-requests'
      ? 'An email was sent recently. Please wait a few minutes before asking for another.'
      : `Could not send the email: ${error.message || 'Unknown error'}`;
    button.disabled = false;
  }
  result.hidden = false;
}

// ===== SIGN-IN MODAL =====
// Signing in with a popup keeps the user's current selection on the page.
function showSignInModal() {
  document.querySelectorAll('.auth-modal').forEach(modal => modal.remove());
  track('signin_prompt', { context: 'compile' });

  const nextUrl = '/index.html' + (lastSearch?.query ? `?q=${encodeURIComponent(lastSearch.query)}` : '');
  const modal = document.createElement('div');
  modal.className = 'auth-modal';
  modal.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="signin-modal-title">
      <div class="modal-header">
        <h2 id="signin-modal-title">🔐 Sign In Required</h2>
        <button class="close-modal" data-modal-close aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <p><strong>Video generation is free.</strong> Sign in so we can keep track of your videos.</p>
        <ul>
          <li>✅ Up to ${DAILY_VIDEO_LIMIT} compilation videos per day</li>
          <li>✅ Up to ${MAX_SEGMENTS} segments / ${MAX_TOTAL_SECONDS / 60} minutes per video</li>
          <li>✅ Your videos stay available under My videos</li>
        </ul>
        <p class="modal-error" hidden></p>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-modal-close>Maybe Later</button>
        <a class="btn-secondary" href="signin.html?next=${encodeURIComponent(nextUrl)}">Other sign-in options</a>
        <button class="btn-primary" data-modal-action="google-signin">Continue with Google</button>
      </div>
    </div>
  `;

  const onKeydown = (event) => {
    if (event.key === 'Escape') closeModal();
  };
  const closeModal = () => {
    document.removeEventListener('keydown', onKeydown);
    modal.remove();
  };

  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('[data-modal-close]')) {
      closeModal();
    } else if (event.target.closest('[data-modal-action="google-signin"]')) {
      signInWithGoogle(modal, closeModal);
    }
  });
  document.addEventListener('keydown', onKeydown);
  document.body.appendChild(modal);
}

async function signInWithGoogle(modal, closeModal) {
  const button = modal.querySelector('[data-modal-action="google-signin"]');
  const errorBox = modal.querySelector('.modal-error');
  button.disabled = true;
  button.textContent = 'Signing in...';
  errorBox.hidden = true;

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await firebase.auth().signInWithPopup(provider);
    track('signin_complete', { method: 'google_popup' });
    closeModal();
    initiateVideoGeneration();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Continue with Google';
    if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') return;
    console.error('Google sign-in failed:', error);
    errorBox.textContent = error.code === 'auth/popup-blocked'
      ? 'Your browser blocked the sign-in popup. Use "Other sign-in options" instead.'
      : `Sign-in failed: ${error.message || 'Unknown error'}`;
    errorBox.hidden = false;
  }
}

// ===== UTILITY FUNCTIONS =====
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function formatTime(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function formatTimeHMS(seconds) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
