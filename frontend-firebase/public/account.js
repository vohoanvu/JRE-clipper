// Account page: profile, today's video allowance and recent compilations.
// Loaded with `defer` after the Firebase compat SDK scripts.

document.addEventListener('DOMContentLoaded', function () {
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) {
        hideLoading();
        showError('Failed to initialize. Please refresh the page.');
        return;
    }

    const signOutBtn = document.getElementById('sign-out');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            try {
                await firebase.auth().signOut();
                window.location.href = 'index.html';
            } catch (error) {
                console.error('Sign out error:', error);
                showError('Failed to sign out. Please try again.');
            }
        });
    }

    firebase.auth().onAuthStateChanged((user) => {
        if (user) {
            loadUserAccount(user);
        } else {
            showAuthRequired();
        }
    });
});

function loadUserAccount(user) {
    hideLoading();
    document.getElementById('auth-required').classList.add('hidden');
    document.getElementById('account-content').classList.remove('hidden');

    updateHeaderUserInfo(user);
    updateProfileInfo(user);
    showEmailVerification(user);
    loadUsage();
}

// createVideoJob requires a verified email (Google accounts always are).
function showEmailVerification(user) {
    const note = document.getElementById('verify-email-note');
    if (!note || user.emailVerified) return;
    note.classList.remove('hidden');

    const button = document.getElementById('resend-verification');
    const result = document.getElementById('verify-email-result');
    button.addEventListener('click', async () => {
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
        result.classList.remove('hidden');
    });
}

function setPhoto(img, user) {
    if (!img) return;
    if (user.photoURL) {
        img.src = user.photoURL;
        img.alt = user.displayName || user.email || 'Profile photo';
        img.style.display = '';
    } else {
        img.style.display = 'none';
    }
}

function updateHeaderUserInfo(user) {
    const userInfo = document.getElementById('user-info');
    const userEmail = document.getElementById('user-email');
    setPhoto(document.getElementById('user-photo'), user);
    if (userEmail) userEmail.textContent = user.email || user.displayName || '';
    if (userInfo) userInfo.style.display = 'flex';
}

function updateProfileInfo(user) {
    setPhoto(document.getElementById('profile-photo'), user);
    setText('profile-email', user.email || '-');
    setText('profile-name', user.displayName || 'Not set');
    setText('profile-created', formatDate(user.metadata.creationTime));
    setText('profile-last-signin', formatDate(user.metadata.lastSignInTime));
}

async function loadUsage() {
    try {
        const result = await firebase.functions().httpsCallable('getUserUsageStats')();
        renderQuota(result.data);
        renderRecentJobs(result.data.recentJobs || []);
    } catch (error) {
        console.error('Error loading usage statistics:', error);
        setText('quota-loading', 'Could not load your video allowance.');
        document.getElementById('generated-videos-list').innerHTML =
            '<p class="muted">Could not load your videos. Please refresh the page.</p>';
    }
}

function renderQuota(stats) {
    document.getElementById('quota-loading').classList.add('hidden');
    document.getElementById('quota-content').classList.remove('hidden');

    const remainingEl = document.getElementById('quota-remaining');
    const fill = document.getElementById('usage-fill');
    const resetsAt = stats.resetsAt ? new Date(stats.resetsAt) : null;

    if (stats.unlimited) {
        remainingEl.textContent = '∞';
        setText('quota-label', `no daily limit (${stats.usedToday} generated today)`);
        document.getElementById('usage-bar').classList.add('hidden');
        setText('quota-reset', '');
        return;
    }

    const remaining = stats.remainingToday ?? 0;
    remainingEl.textContent = `${remaining} / ${stats.dailyLimit}`;
    remainingEl.classList.toggle('exhausted', remaining === 0);
    setText('quota-label', 'videos left today');
    fill.style.width = `${Math.min(100, (stats.usedToday / stats.dailyLimit) * 100)}%`;
    setText('quota-reset', resetsAt
        ? `Resets at midnight UTC (${resetsAt.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', weekday: 'short' })} your time)`
        : 'Resets at midnight UTC');
}

function renderRecentJobs(jobs) {
    const list = document.getElementById('generated-videos-list');
    if (jobs.length === 0) {
        list.innerHTML = '<p class="muted">No videos yet. Search for a topic, select segments and generate your first compilation!</p>';
        return;
    }

    list.replaceChildren(...jobs.map(renderJobItem));
}

function renderJobItem(job) {
    const item = document.createElement('div');
    item.className = 'video-item';

    const header = document.createElement('div');
    header.className = 'video-item-header';
    const title = document.createElement('div');
    title.className = 'video-item-title';
    title.textContent = 'Video Compilation';
    const pill = document.createElement('span');
    pill.className = `status-pill ${statusClass(job.status)}`;
    pill.textContent = job.status;
    title.append(' ', pill);
    const date = document.createElement('div');
    date.className = 'video-date';
    date.textContent = job.createdAt ? new Date(job.createdAt).toLocaleString() : '';
    header.append(title, date);

    const stats = document.createElement('div');
    stats.className = 'video-stats';
    const parts = [];
    if (job.segmentCount != null) parts.push(`Segments: ${job.segmentCount}`);
    if (job.totalVideos != null) parts.push(`Episodes: ${job.totalVideos}`);
    if (job.outputDurationSeconds != null) parts.push(`Length: ${formatDuration(job.outputDurationSeconds)}`);
    if (job.status !== 'Complete' && job.status !== 'Failed' && job.progress != null) parts.push(`Progress: ${job.progress}%`);
    stats.textContent = parts.join(' | ');

    const actions = document.createElement('div');
    actions.className = 'video-actions';
    if (job.finalVideoUrl) {
        const download = document.createElement('a');
        download.className = 'btn-view-video';
        download.href = job.finalVideoUrl;
        download.target = '_blank';
        download.rel = 'noopener';
        download.textContent = '🎬 Watch / Download';
        actions.appendChild(download);
    }
    const statusLink = document.createElement('a');
    statusLink.className = 'btn-job-status';
    statusLink.href = `status.html?jobId=${encodeURIComponent(job.jobId)}`;
    statusLink.textContent = 'View details';
    actions.appendChild(statusLink);

    item.append(header, stats, actions);
    return item;
}

function statusClass(status) {
    if (status === 'Complete') return 'complete';
    if (status === 'Failed') return 'failed';
    if (status === 'Queued' || status === 'Processing' || status === 'Uploading') return 'active';
    return '';
}

// UI Helper Functions
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function hideLoading() {
    document.getElementById('loading-section')?.classList.add('hidden');
}

function showAuthRequired() {
    hideLoading();
    document.getElementById('account-content').classList.add('hidden');
    document.getElementById('auth-required').classList.remove('hidden');
}

function showError(message) {
    const alertContainer = document.getElementById('alert-container');
    const target = alertContainer && !document.getElementById('account-content').classList.contains('hidden')
        ? alertContainer
        : document.querySelector('main');
    if (!target) return;

    const alertDiv = document.createElement('div');
    alertDiv.className = 'alert alert-error';
    alertDiv.textContent = message;
    target.prepend(alertDiv);
    setTimeout(() => alertDiv.remove(), 5000);
}

function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
