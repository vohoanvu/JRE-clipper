// My Videos page: every compilation the signed-in user generated, newest first, each finished
// one playable in place. listMyVideos returns 12 at a time with fresh signed URLs (valid 12 h).
// Loaded with `defer` after the Firebase compat SDK scripts.

let nextCursor = null;
let loadingPage = false;

document.addEventListener('DOMContentLoaded', function () {
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) {
        hideLoading();
        showError('Failed to initialize. Please refresh the page.');
        return;
    }

    document.getElementById('sign-out')?.addEventListener('click', async () => {
        await firebase.auth().signOut();
        window.location.href = 'index.html';
    });
    document.getElementById('load-more').addEventListener('click', () => loadPage());

    // Only one video plays at a time.
    document.getElementById('videos-grid').addEventListener('play', (event) => {
        document.querySelectorAll('#videos-grid video').forEach((video) => {
            if (video !== event.target) video.pause();
        });
    }, true);

    firebase.auth().onAuthStateChanged((user) => {
        if (user) {
            updateHeaderUserInfo(user);
            loadPage();
        } else {
            hideLoading();
            document.getElementById('auth-required').classList.remove('hidden');
        }
    });
});

async function loadPage() {
    if (loadingPage) return;
    loadingPage = true;
    const button = document.getElementById('load-more');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;

    try {
        const result = await firebase.functions().httpsCallable('listMyVideos', { timeout: 30000 })(
            nextCursor ? { cursor: nextCursor } : {});
        const { videos = [], nextCursor: cursor = null } = result.data || {};
        const grid = document.getElementById('videos-grid');
        grid.append(...videos.map(renderVideoCard));
        nextCursor = cursor;

        hideLoading();
        document.getElementById('videos-empty').classList.toggle('hidden', grid.children.length > 0);
        document.getElementById('load-more-row').classList.toggle('hidden', !nextCursor);
    } catch (error) {
        console.error('listMyVideos failed:', error);
        hideLoading();
        showError(`Could not load your videos: ${error.message || 'Unknown error'}`);
    } finally {
        loadingPage = false;
        button.removeAttribute('aria-busy');
        button.disabled = false;
    }
}

function renderVideoCard(video) {
    const card = document.createElement('article');
    card.className = 'my-video-card';

    const media = document.createElement('div');
    media.className = 'my-video-media';
    const expired = video.status === 'Complete' && !video.videoUrl;
    if (video.videoUrl) {
        const player = document.createElement('video');
        player.controls = true;
        player.preload = 'metadata';
        player.playsInline = true;
        player.src = video.videoUrl;
        // The signed URL lasts 12 h; a page left open longer needs a reload.
        player.addEventListener('error', () => {
            media.replaceChildren(placeholder('This video could not be loaded. ', 'Reload the page', 'videos.html'));
        });
        media.appendChild(player);
    } else if (expired) {
        media.appendChild(placeholder('This video is no longer available. Videos made before Oct 27, 2026 were only kept for 8 days.'));
    } else if (video.status === 'Failed') {
        media.appendChild(placeholder(`Generation failed${video.error ? `: ${video.error}` : '.'}`));
    } else {
        const progress = video.progress != null ? ` (${video.progress}%)` : '';
        media.appendChild(placeholder(`Still being generated${progress}. `, 'Track progress',
            `status.html?jobId=${encodeURIComponent(video.jobId)}`));
    }

    const body = document.createElement('div');
    body.className = 'my-video-body';

    const title = document.createElement('div');
    title.className = 'my-video-title';
    const name = document.createElement('span');
    name.textContent = `${video.segmentCount ?? '?'} segment${video.segmentCount === 1 ? '' : 's'} from `
        + `${video.totalVideos ?? video.episodes.length} episode${(video.totalVideos ?? video.episodes.length) === 1 ? '' : 's'}`;
    const pill = document.createElement('span');
    pill.className = `status-pill ${expired ? 'expired' : statusClass(video.status)}`;
    pill.textContent = expired ? 'Expired' : video.status;
    title.append(name, pill);

    const meta = document.createElement('div');
    meta.className = 'my-video-meta';
    const parts = [];
    if (video.createdAt) parts.push(new Date(video.createdAt).toLocaleString());
    if (video.outputDurationSeconds != null) parts.push(formatDuration(video.outputDurationSeconds));
    if (video.outputSizeBytes != null) parts.push(`${(video.outputSizeBytes / 1048576).toFixed(1)} MB`);
    meta.textContent = parts.join(' • ');

    body.append(title, meta);

    if (video.episodes.length > 0) {
        const episodes = document.createElement('details');
        episodes.className = 'my-video-episodes';
        const summary = document.createElement('summary');
        summary.textContent = video.episodes.length === 1
            ? video.episodes[0].title || 'Episode'
            : `${video.episodes.length} episodes`;
        const list = document.createElement('ul');
        for (const episode of video.episodes) {
            const item = document.createElement('li');
            item.textContent = episode.title || episode.videoId;
            list.appendChild(item);
        }
        episodes.append(summary, list);
        body.appendChild(episodes);
    }

    const actions = document.createElement('div');
    actions.className = 'my-video-actions';
    if (video.videoUrl) {
        // The object is stored with Content-Disposition: attachment, so this link downloads.
        actions.appendChild(link('⬇ Download', video.videoUrl, 'download'));
    }
    actions.appendChild(link('Details', `status.html?jobId=${encodeURIComponent(video.jobId)}`));
    body.appendChild(actions);

    card.append(media, body);
    return card;
}

function placeholder(text, linkText, href) {
    const box = document.createElement('div');
    box.className = 'my-video-placeholder';
    box.textContent = text;
    if (linkText) {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = linkText;
        box.appendChild(a);
    }
    return box;
}

function link(text, href, className) {
    const a = document.createElement('a');
    a.textContent = text;
    a.href = href;
    if (className) a.className = className;
    return a;
}

function statusClass(status) {
    if (status === 'Complete') return 'complete';
    if (status === 'Failed') return 'failed';
    if (status === 'Queued' || status === 'Processing' || status === 'Uploading') return 'active';
    return '';
}

function updateHeaderUserInfo(user) {
    const photo = document.getElementById('user-photo');
    if (user.photoURL) {
        photo.src = user.photoURL;
    } else {
        photo.style.display = 'none';
    }
    document.getElementById('user-email').textContent = user.email || user.displayName || '';
    document.getElementById('user-info').style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loading-section').classList.add('hidden');
}

function showError(message) {
    const el = document.getElementById('videos-error');
    el.textContent = message;
    el.classList.remove('hidden');
}

function formatDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
