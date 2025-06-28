// JRE Clipper - Main JavaScript Application
// This file contains all the client-side logic for the JRE Clipper application

// ===== GLOBAL VARIABLES AND CONSTANTS =====
const tokenFunctionUrl = 'https://us-central1-gen-lang-client-demo.cloudfunctions.net/getVertexAiToken';
const searchApiUrl = 'https://us-discoveryengine.googleapis.com/v1alpha/projects/408323719521/locations/us/collections/default_collection/engines/jreclipper_1750261043616/servingConfigs/default_search:search';
const answerApiUrl = 'https://us-discoveryengine.googleapis.com/v1alpha/projects/408323719521/locations/us/collections/default_collection/engines/jreclipper_1750261043616/servingConfigs/default_search:answer';
const videoProcessorUrl = 'https://jre-video-processor-py-408323719521.us-central1.run.app';

let accessToken = null;
let lastSearchResults = [];
let currentSession = null;
let currentQueryId = null;
let players = {}; // Store YouTube player instances
let userSessionId = null; // For anonymous users
let selectedSegments = []; // Store selected segments for video generation
let allSegments = []; // Store all available segments

// Rate limiting variables
let userSearchCount = 0;
const DAILY_SEARCH_LIMIT = 10;
let lastResetDate = null;
let userPlan = 'free'; // 'free' or 'pro'

// DOM element references (will be set after DOM loads)
let searchInput, searchButton, instructionInput, instructionToggleBtn, instructionContainer;
let searchResultsContainer, answerSection, videoPlayersContainer;

// ===== DOM INITIALIZATION =====
document.addEventListener('DOMContentLoaded', function () {
  // Get DOM element references
  searchInput = document.getElementById('searchInput');
  searchButton = document.getElementById('searchButton');
  instructionInput = document.getElementById('instructionInput');
  instructionToggleBtn = document.getElementById('instructionToggleBtn');
  instructionContainer = document.getElementById('instruction-container');
  searchResultsContainer = document.getElementById('search-results');
  answerSection = document.getElementById('answer-section');
  videoPlayersContainer = document.getElementById('video-players-container');

  // Initialize the application
  initializeApp();
});

// ===== APPLICATION INITIALIZATION =====
function initializeApp() {
  // Initialize Firebase Auth (optional - app works without it)
  initializeAuth();

  // Set up event listeners
  setupEventListeners();

  // Initialize rate limiting
  initializeRateLimit();

  // Initialize the app for non-authenticated users
  fetchAccessToken();
}

function setupEventListeners() {
  // Search button click
  searchButton.addEventListener('click', () => {
    const query = searchInput.value.trim();
    if (query) performSearch(query);
  });

  // Search input enter key
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const query = searchInput.value.trim();
      if (query) performSearch(query);
    }
  });

  // Instruction toggle button
  instructionToggleBtn.addEventListener('click', toggleInstructionField);
}

// ===== AUTHENTICATION =====
function initializeAuth() {
  // Listen for auth state changes
  firebase.auth().onAuthStateChanged(user => {
    const authButtonsContainer = document.getElementById('auth-buttons');
    const userInfoContainer = document.getElementById('user-info');

    if (user) {
      // User is signed in
      if (authButtonsContainer) authButtonsContainer.style.display = 'none';
      if (userInfoContainer) userInfoContainer.style.display = 'flex';

      const userPhoto = document.getElementById('user-photo');
      const userEmail = document.getElementById('user-email');
      
      if (userPhoto) userPhoto.src = user.photoURL || 'https://via.placeholder.com/40';
      if (userEmail) userEmail.textContent = user.email;

      // Set up sign-out functionality
      const signOutBtn = document.getElementById('sign-out');
      if (signOutBtn) {
        signOutBtn.addEventListener('click', () => {
          firebase.auth().signOut().then(() => {
            // Signed out successfully
            console.log('User signed out');
            // Refresh the page to reset the app state
            window.location.reload();
          });
        });
      }

      // Set user as pro (authenticated users get pro features)
      userPlan = 'pro';
      localStorage.setItem('jre_user_plan', 'pro');
      updateUsageDisplay();

    } else {
      // User is signed out - show sign-in button
      if (authButtonsContainer) authButtonsContainer.style.display = 'block';
      if (userInfoContainer) userInfoContainer.style.display = 'none';

      // Set user as free
      userPlan = 'free';
      localStorage.setItem('jre_user_plan', 'free');
      updateUsageDisplay();
    }
  });
}

function fetchAccessToken() {
  fetch(tokenFunctionUrl)
    .then(response => {
      if (!response.ok) {
        return response.json().then(err => {
          throw new Error(`Auth Error: ${err.error || 'Unknown'}`);
        });
      }
      return response.json();
    })
    .then(data => {
      if (data.accessToken) {
        accessToken = data.accessToken;
        searchInput.disabled = false;
        searchButton.disabled = false;
        searchInput.placeholder = "e.g. Jiu Jitsu, Bears, Bees, Aliens, Psychedelic Drugs";
      } else {
        searchInput.placeholder = "Authentication error. See console.";
        console.error("Could not fetch access token from backend.", data.error || '');
      }
    })
    .catch(error => {
      searchInput.placeholder = "Could not authenticate. See console.";
      console.error("Error fetching access token:", error);
    });
}

// ===== INSTRUCTION TOGGLE FUNCTIONALITY =====
function toggleInstructionField() {
  const isHidden = instructionContainer.classList.contains('hidden');

  if (isHidden) {
    instructionContainer.classList.remove('hidden');
    instructionToggleBtn.classList.add('active');
    instructionToggleBtn.textContent = '✕';
    instructionToggleBtn.title = 'Hide Instructions';
  } else {
    instructionContainer.classList.add('hidden');
    instructionToggleBtn.classList.remove('active');
    instructionToggleBtn.textContent = '⚙️';
    instructionToggleBtn.title = 'Custom Instructions';
  }
}

// ===== SESSION MANAGEMENT =====
function initializeSession() {
  if (!userSessionId) {
    userSessionId = 'session_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
}

// ===== RATE LIMITING =====
async function checkServerRateLimit() {
  try {
    initializeSession();

    const checkLimit = firebase.functions().httpsCallable('checkSearchLimit');
    const result = await checkLimit({
      sessionId: userSessionId,
      userId: null // For now, we're using anonymous sessions
    });

    return result.data;
  } catch (error) {
    console.error('Error checking rate limit:', error);
    // Fallback to client-side limit if server fails
    return checkClientRateLimit();
  }
}

async function recordServerSearch() {
  try {
    initializeSession();

    const recordSearch = firebase.functions().httpsCallable('recordSearch');
    await recordSearch({
      sessionId: userSessionId,
      userId: null // For now, we're using anonymous sessions
    });
  } catch (error) {
    console.error('Error recording search:', error);
    // Fallback to client-side increment
    incrementClientSearchCount();
  }
}

// Fallback client-side rate limiting (kept for offline scenarios)
function checkClientRateLimit() {
  const today = new Date().toDateString();
  let searchCount = parseInt(localStorage.getItem('jre_search_count') || '0');
  let lastReset = localStorage.getItem('jre_last_reset');
  let userPlan = localStorage.getItem('jre_user_plan') || 'free';

  // Reset if new day
  if (lastReset !== today) {
    searchCount = 0;
    localStorage.setItem('jre_search_count', '0');
    localStorage.setItem('jre_last_reset', today);
  }

  if (userPlan === 'pro') {
    return {
      allowed: true,
      plan: userPlan,
      remaining: null,
      message: 'Unlimited searches available'
    };
  }

  const remaining = Math.max(0, 10 - searchCount);
  return {
    allowed: remaining > 0,
    plan: userPlan,
    remaining: remaining,
    message: remaining > 0 ? `${remaining} searches remaining today` : 'Daily limit reached',
    showWarning: remaining <= 3 && remaining > 0
  };
}

function incrementClientSearchCount() {
  let userPlan = localStorage.getItem('jre_user_plan') || 'free';
  if (userPlan === 'free') {
    let searchCount = parseInt(localStorage.getItem('jre_search_count') || '0');
    localStorage.setItem('jre_search_count', (searchCount + 1).toString());
  }
}

function initializeRateLimit() {
  const today = new Date().toDateString();

  // Reset count if it's a new day
  if (lastResetDate !== today) {
    userSearchCount = 0;
    lastResetDate = today;
    localStorage.setItem('jre_search_count', '0');
    localStorage.setItem('jre_last_reset', today);
  } else {
    // Load from localStorage
    userSearchCount = parseInt(localStorage.getItem('jre_search_count') || '0');
    lastResetDate = localStorage.getItem('jre_last_reset');
  }

  // Load user plan (in real app, this would come from backend)
  userPlan = localStorage.getItem('jre_user_plan') || 'free';

  updateUsageDisplay();
}

function checkAndUpdateSearchLimit() {
  // Pro users have unlimited searches
  if (userPlan === 'pro') {
    return true;
  }

  const today = new Date().toDateString();

  // Reset count if it's a new day
  if (lastResetDate !== today) {
    userSearchCount = 0;
    lastResetDate = today;
    localStorage.setItem('jre_search_count', '0');
    localStorage.setItem('jre_last_reset', today);
    updateUsageDisplay();
  }

  return userSearchCount < DAILY_SEARCH_LIMIT;
}

function incrementSearchCount() {
  if (userPlan === 'free') {
    userSearchCount++;
    localStorage.setItem('jre_search_count', userSearchCount.toString());
    updateUsageDisplay();
  }
}

function getRemainingSearches() {
  if (userPlan === 'pro') {
    return 'Unlimited';
  }
  return Math.max(0, DAILY_SEARCH_LIMIT - userSearchCount);
}

function updateUsageDisplay() {
  const remaining = getRemainingSearches();
  const counterElement = document.getElementById('searches-remaining');

  if (!counterElement) return; // Element might not exist on all pages

  if (userPlan === 'pro') {
    counterElement.textContent = '∞';
    counterElement.parentElement.innerHTML = '<span style="color: #28a745;">⚡ Pro Plan - Unlimited</span>';
  } else {
    counterElement.textContent = remaining;

    // Change color based on remaining searches
    if (remaining <= 2) {
      counterElement.style.color = '#e74c3c';
      counterElement.parentElement.style.background = '#ffe6e6';
      counterElement.parentElement.style.padding = '0.5rem';
      counterElement.parentElement.style.borderRadius = '4px';
    } else if (remaining <= 5) {
      counterElement.style.color = '#f39c12';
    } else {
      counterElement.style.color = '#28a745';
    }
  }
}

function showRateLimitWarning(remaining = null) {
  if (userPlan === 'pro') return; // No warnings for pro users

  const actualRemaining = remaining || getRemainingSearches();

  // Remove any existing warnings
  const existingWarning = document.querySelector('.rate-limit-warning');
  if (existingWarning) {
    existingWarning.remove();
  }

  if (actualRemaining <= 3 && actualRemaining > 0) {
    const warningDiv = document.createElement('div');
    warningDiv.className = 'rate-limit-warning';
    warningDiv.innerHTML = `
      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 1rem; border-radius: 4px; margin: 1rem 0; text-align: center;">
        <strong>⚠️ Search Limit Warning</strong><br>
        You have ${actualRemaining} searches remaining today. <a href="/pricing.html" style="color: #0066cc; font-weight: bold;">Upgrade to Pro</a> for unlimited searches!
      </div>
    `;
    document.querySelector('main.container').insertBefore(warningDiv, answerSection);

    // Auto-remove warning after 8 seconds
    setTimeout(() => {
      if (warningDiv.parentNode) {
        warningDiv.remove();
      }
    }, 8000);
  }
}

function showServerRateLimitExceeded(rateLimitData) {
  searchResultsContainer.innerHTML = `
    <div style="background: #f8d7da; border: 1px solid #f5c6cb; padding: 2rem; border-radius: 8px; text-align: center; margin: 2rem 0;">
      <h3 style="color: #721c24; margin-bottom: 1rem;">🚫 Daily Search Limit Reached</h3>
      <p style="color: #721c24; margin-bottom: 1rem;">
        ${rateLimitData.message}
      </p>
      <p style="color: #721c24; margin-bottom: 1.5rem;">
        Your limit will reset at <strong>midnight UTC</strong> (${getTimeUntilReset()}).
      </p>
      <div style="margin-bottom: 1.5rem;">
        <strong>Want unlimited searches right now?</strong>
      </div>
      <a href="/pricing.html" style="display: inline-block; background: #28a745; color: white; padding: 1rem 2rem; text-decoration: none; border-radius: 6px; font-weight: bold; margin-bottom: 1rem;">
        ⚡ Upgrade to Pro - $9.99/month
      </a>
      <div style="margin-top: 1rem; font-size: 0.9rem; color: #6c757d;">
        ✓ Unlimited searches &nbsp; ✓ Advanced AI insights &nbsp; ✓ Priority support &nbsp; ✓ Cancel anytime
      </div>
      <div style="margin-top: 1rem;">
        <button onclick="simulateProUpgrade()" style="background: #007bff; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; font-size: 0.9rem; cursor: pointer;">
          🧪 Try Pro Mode (Demo)
        </button>
      </div>
    </div>
  `;
}

function getTimeUntilReset() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const timeDiff = tomorrow - now;
  const hours = Math.floor(timeDiff / (1000 * 60 * 60));
  const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

  return `${hours}h ${minutes}m`;
}

// Demo function to simulate Pro upgrade
function simulateProUpgrade() {
  userPlan = 'pro';
  localStorage.setItem('jre_user_plan', 'pro');
  updateUsageDisplay();

  // Clear rate limit message
  searchResultsContainer.innerHTML = `
    <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 2rem; border-radius: 8px; text-align: center; margin: 2rem 0;">
      <h3 style="color: #155724; margin-bottom: 1rem;">🎉 Welcome to Pro!</h3>
      <p style="color: #155724; margin-bottom: 1rem;">
        You now have unlimited searches! Try searching again.
      </p>
      <p style="color: #155724; font-size: 0.9rem;">
        <em>This is a demo mode. In production, this would require payment via Stripe.</em>
      </p>
    </div>
  `;

  // Re-enable search
  searchInput.disabled = false;
  searchButton.disabled = false;
}

// ===== SEARCH FUNCTIONALITY =====
async function performSearch(query) {
  if (!accessToken) {
    console.error("Cannot search: Not authenticated.");
    return;
  }

  // Check server-side rate limit before proceeding
  const rateLimitCheck = await checkServerRateLimit();
  if (!rateLimitCheck.allowed) {
    showServerRateLimitExceeded(rateLimitCheck);
    return;
  }

  // Show warning if near limit
  if (rateLimitCheck.showWarning) {
    showRateLimitWarning(rateLimitCheck.remaining);
  }

  searchInput.placeholder = "Searching...";
  searchButton.setAttribute('aria-busy', 'true');
  searchResultsContainer.innerHTML = '';
  answerSection.innerHTML = '';
  videoPlayersContainer.innerHTML = '';

  fetch(searchApiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: query.toLowerCase(),
      pageSize: 20,
      queryExpansionSpec: { condition: "AUTO" },
      spellCorrectionSpec: { mode: "AUTO" },
      languageCode: "en-US",
      userInfo: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      session: "projects/408323719521/locations/us/collections/default_collection/engines/jreclipper_1750261043616/sessions/-"
    })
  })
    .then(async response => {
      if (!response.ok) {
        const err = await response.json();
        throw new Error(`API Error: ${err.error.message}`);
      }
      return response.json();
    })
    .then(data => {
      // Only increment search count on successful search
      incrementSearchCount();

      lastSearchResults = data.results || [];

      // Extract session and queryId from the API response
      currentSession = data.sessionInfo?.name || null;
      currentQueryId = data.sessionInfo?.queryId || null;

      console.log('Search completed:', data);

      // Show rate limit warning if approaching limit
      showRateLimitWarning();

      if (lastSearchResults.length > 0) {
        // Generate AI answer first
        generateAnswer(query);
        // Then display search summary
        displaySearchSummary(lastSearchResults);
        // Finally load video players
        loadVideoPlayers(lastSearchResults);
      } else {
        displaySearchSummary(lastSearchResults);
      }
    })
    .catch(error => {
      console.error('Search failed:', error);
      searchResultsContainer.innerHTML = `<p style="color: red;">Search failed: ${error.message}</p>`;
    })
    .finally(() => {
      searchInput.placeholder = "e.g. Jiu Jitsu, Bears, Bees, Aliens";
      searchButton.removeAttribute('aria-busy');
    });
}

function displaySearchSummary(results) {
  if (results.length === 0) {
    searchResultsContainer.innerHTML = '<p>No results found.</p>';
    return;
  }

  // Group results by video
  const videoGroups = {};
  results.forEach(item => {
    const videoId = item.document.structData.structData.videoId;
    const videoTitle = item.document.structData.structData.videoTitle;

    if (!videoGroups[videoId]) {
      videoGroups[videoId] = {
        title: videoTitle,
        segments: []
      };
    }

    videoGroups[videoId].segments.push(item);
  });

  const uniqueVideos = Object.keys(videoGroups);

  let html = `<h3>Found ${results.length} relevant segments from ${uniqueVideos.length} JRE episodes</h3>`;

  // Show video breakdown
  html += '<div style="background: #f5f5f5; padding: 1rem; border-radius: 4px; margin: 1rem 0;">';
  Object.entries(videoGroups).forEach(([videoId, data]) => {
    html += `<div style="margin-bottom: 0.5rem; color: #2c3e50;">
      <strong>${data.title}</strong> - ${data.segments.length} segment${data.segments.length > 1 ? 's' : ''}
    </div>`;
  });
  html += '</div>';

  html += '<p style="color: #666; font-style: italic;">Watch the episode segments below...</p>';

  searchResultsContainer.innerHTML = html;
}

// ===== AI ANSWER GENERATION =====
function generateAnswer(originalQuery) {
  if (!currentSession || !currentQueryId) {
    console.error('Cannot generate answer: Missing session or queryId');
    return;
  }

  answerSection.innerHTML = `
    <div class="answer-section">
      <div class="answer-header">
        🎙️ What Joe Rogan Would Say...
      </div>
      <div class="answer-loading">
        <div class="gemini-loading">
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
        <span>AI Joe Rogan is thinking<span class="dots"></span></span>
      </div>
    </div>
  `;

  // Get custom instruction or use default
  const customInstruction = instructionInput.value.trim();
  const defaultJoeRoganStyle = "Response in Joe Rogan style, make the response funny using Joe sense of humor, use emoji if necessary.";
  
  let finalInstruction;
  if (customInstruction) {
    // Prepend the default Joe Rogan style to any custom instruction
    finalInstruction = defaultJoeRoganStyle + " " + customInstruction;
  } else {
    // Use the full default instruction if no custom input
    finalInstruction = defaultJoeRoganStyle + " You are an expert at the Joe Rogan Experience podcast and its content. You are very knowledgeable about JRE content and more importantly all of the guests that have appeared on the JRE show. Use Joe Rogan style of communication. Use the tone of professional comedians that are close to the Comedy circle of Joe Rogan. Occasionally at the end of every answer, make a joke about encouraging the users to take more psychedelic drugs and practice Martial Arts to learn more about the given topic.";
  }

  const answerPayload = {
    query: {
      text: originalQuery,
      queryId: currentQueryId
    },
    session: currentSession,
    answerGenerationSpec: {
      ignoreAdversarialQuery: false,
      ignoreNonAnswerSeekingQuery: false,
      ignoreLowRelevantContent: false,
      multimodalSpec: {},
      includeCitations: true,
      promptSpec: {
        preamble: finalInstruction
      },
      modelSpec: {
        modelVersion: "stable"
      }
    }
  };

  console.log('Generating answer with payload:', answerPayload);

  fetch(answerApiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(answerPayload)
  })
    .then(response => {
      if (!response.ok) {
        return response.json().then(err => {
          throw new Error(`Answer API Error: ${err.error?.message || 'Unknown error'}`);
        });
      }
      return response.json();
    })
    .then(data => {
      console.log('Answer response:', data);
      displayAnswer(data);
    })
    .catch(error => {
      console.error('Answer generation failed:', error);
      answerSection.innerHTML = `
        <div class="answer-section">
          <div class="answer-header">
            🎙️ What Joe Rogan Would Say...
          </div>
          <div class="answer-error">
            Failed to generate answer: ${error.message}
          </div>
        </div>
      `;
    });
}

function displayAnswer(answerData) {
  if (!answerData?.answer) {
    answerSection.innerHTML = `
      <div class="answer-section">
        <div class="answer-header">
          🎙️ What Joe Rogan Would Say...
        </div>
        <div class="answer-error">
          No answer generated. Try a different search query.
        </div>
      </div>
    `;
    return;
  }

  const answer = answerData.answer;
  let answerText = answer.answerText || 'No answer text available.';

  // Check if custom instruction was used
  const customInstruction = instructionInput.value.trim();
  const isCustomInstruction = customInstruction.length > 0;

  // Determine the header text based on instruction type
  const headerText = isCustomInstruction
    ? `🎯 AI Response About "${lastSearchResults.length > 0 ? searchInput.value : 'this topic'}" (Custom Instruction)`
    : `🎙️ What Joe Rogan Would Say About "${lastSearchResults.length > 0 ? searchInput.value : 'this topic'}"`;

  answerSection.innerHTML = `
    <div class="answer-section">
      <div class="answer-header">
        ${headerText}
      </div>
      ${isCustomInstruction ? `
        <div style="background: #e8f4fd; border: 1px solid #007bff; border-radius: 4px; padding: 0.75rem; margin-bottom: 1rem; font-size: 0.85rem;">
          <strong>🎯 Using Custom Instruction:</strong> ${customInstruction.substring(0, 100)}${customInstruction.length > 100 ? '...' : ''}
        </div>
      ` : ''}
      <div class="answer-content">${answerText}</div>
    </div>
  `;
}

// ===== VIDEO PLAYER FUNCTIONALITY =====
function loadVideoPlayers(results) {
  videoPlayersContainer.innerHTML = '<div class="loading">Loading video players...</div>';

  // Prepare segments data for the backend
  const segmentData = results.map(item => {
    const data = item.document.structData.structData;
    // Extract start and end times from id (format: "videoId_startTime_endTime")
    const idParts = data.id ? data.id.split('_') : [];
    let startTime = idParts.length >= 2 ? parseInt(idParts[1]) : data.startTime;
    let endTime = idParts.length >= 3 ? parseInt(idParts[2]) : data.endTime;

    return {
      videoId: data.videoId,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      videoTitle: data.videoTitle,
      segmentText: item.document.structData.content
    };
  });

  // Store all segments globally for selection
  allSegments = segmentData;
  selectedSegments = []; // Reset selection
  updateGenerateVideoButton();

  // Wait for Firebase to be ready
  if (typeof firebase === 'undefined') {
    console.error("Firebase is not loaded");
    videoPlayersContainer.innerHTML = '<p style="color: red;">Firebase is not ready. Please refresh the page.</p>';
    return;
  }

  try {
    const getVideoMetadata = firebase.functions().httpsCallable('getVideoMetadata');

    getVideoMetadata({ segments: segmentData })
      .then((result) => {
        console.log("Got video metadata:", result.data);

        // Validate response structure
        if (!result.data || !result.data.success) {
          throw new Error(result.data?.error || 'Invalid response from video metadata service');
        }

        renderVideoPlayers(result.data);
      })
      .catch((error) => {
        console.error("Error fetching video metadata:", error);

        // Provide more specific error messages
        let errorMessage = 'Failed to load video players';
        if (error.code === 'permission-denied') {
          errorMessage = 'YouTube API access denied. Please check API key configuration.';
        } else if (error.code === 'resource-exhausted') {
          errorMessage = 'YouTube API quota exceeded. Please try again later.';
        } else if (error.message) {
          errorMessage += ': ' + error.message;
        }

        videoPlayersContainer.innerHTML = `<p style="color: red;">${errorMessage}</p>`;
      });
  } catch (error) {
    console.error("Error setting up metadata call:", error);
    videoPlayersContainer.innerHTML = `<p style="color: red;">Failed to initialize video players: ${error.message}</p>`;
  }
}

function renderVideoPlayers(videoData) {
  // Fix: Handle the correct data structure from Firebase function
  if (!videoData || !videoData.success || !videoData.videoGroups) {
    videoPlayersContainer.innerHTML = '<p>No video data available.</p>';
    return;
  }

  const videoGroups = videoData.videoGroups;
  const videoIds = Object.keys(videoGroups);

  if (videoIds.length === 0) {
    videoPlayersContainer.innerHTML = '<p>No videos found.</p>';
    return;
  }

  let playersHtml = `
    <div class="video-generation-controls">
      <h3>🎬 Generate Custom Video Clips</h3>
      <p>Select segments below to generate a custom video compilation:</p>
      <div class="generation-buttons">
        <button id="generateVideoBtn" class="generate-video-btn" onclick="initiateVideoGeneration()" disabled>
          📹 Generate Compilation Video (0 segments selected)
        </button>
        <button class="select-all-btn" onclick="selectAllSegments()">
          ☑️ Select All Segments
        </button>
        <button class="clear-selection-btn" onclick="clearAllSelections()">
          ❌ Clear Selection
        </button>
      </div>
      <div id="generation-status" class="generation-status"></div>
    </div>
    <div class="videos-grid">`;

  // Convert videoGroups object to array format for rendering
  videoIds.forEach((videoId, index) => {
    const videoGroup = videoGroups[videoId];
    const videoMetadata = videoGroup.metadata;
    const segments = videoGroup.segments;

    // Skip if no metadata available
    if (!videoMetadata) {
      console.warn(`No metadata available for video ${videoId}`);
      return;
    }

    const embedId = `player-${videoId}`;

    playersHtml += `
      <div class="video-container">
        <div class="video-header">
          <div class="video-title">${videoMetadata.title || 'JRE Episode'}</div>
          <div class="video-controls">
            <button class="select-video-btn" onclick="toggleVideoSelection('${videoId}')">
              📋 Select All (${segments.length})
            </button>
          </div>
        </div>
        <div style="font-size: 0.9rem; color: #666; margin-bottom: 1rem;">
          ${videoMetadata.channelTitle} • ${videoMetadata.viewCount ? parseInt(videoMetadata.viewCount).toLocaleString() + ' views' : ''} • ${videoMetadata.publishedAt ? new Date(videoMetadata.publishedAt).toLocaleDateString() : ''}
        </div>
        <iframe 
          id="${embedId}"
          class="video-embed"
          src="https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0"
          allowfullscreen>
        </iframe>
        <div class="segments-list">
          <div class="segments-header">Relevant Segments (${segments.length}):</div>
          ${segments.map((segment, segIndex) => {
      const segmentId = `${videoId}_${segment.startTimeSeconds}_${segment.endTimeSeconds}`;
      return `
              <div class="segment-item">
                <div class="segment-selection">
                  <input type="checkbox" 
                         id="segment_${segmentId}" 
                         class="segment-checkbox" 
                         data-video-id="${videoId}"
                         data-start="${segment.startTimeSeconds}"
                         data-end="${segment.endTimeSeconds}"
                         data-title="${videoMetadata.title || 'JRE Episode'}"
                         onchange="updateSelectedSegments()">
                  <label for="segment_${segmentId}" class="segment-checkbox-label">Select</label>
                </div>
                <div class="segment-content">
                  <div class="segment-timestamp-text">The search topic was mentioned at: ${formatTimeHMS(segment.startTimeSeconds)}</div>
                </div>
                <button class="skip-btn" onclick="seekToTime('${videoId}', ${segment.startTimeSeconds})">
                  SKIP TO
                </button>
              </div>
            `;
    }).join('')}
        </div>
      </div>
    `;
  });

  playersHtml += '</div>';
  videoPlayersContainer.innerHTML = playersHtml;

  // Note: Removed auto-seek functionality to prevent autoplay on page load
}

// ===== VIDEO GENERATION FUNCTIONS =====
function updateSelectedSegments() {
  selectedSegments = [];
  const checkboxes = document.querySelectorAll('.segment-checkbox:checked');

  checkboxes.forEach(checkbox => {
    const segment = {
      videoId: checkbox.dataset.videoId,
      startTimeSeconds: parseInt(checkbox.dataset.start),
      endTimeSeconds: parseInt(checkbox.dataset.end),
      videoTitle: checkbox.dataset.title
    };
    selectedSegments.push(segment);

    // Add visual feedback
    checkbox.closest('.segment-item').classList.add('selected');
  });

  // Remove selected class from unchecked items
  document.querySelectorAll('.segment-checkbox:not(:checked)').forEach(checkbox => {
    checkbox.closest('.segment-item').classList.remove('selected');
  });

  updateGenerateVideoButton();
}

function updateGenerateVideoButton() {
  const button = document.getElementById('generateVideoBtn');
  if (!button) return;

  const count = selectedSegments.length;
  button.textContent = `📹 Generate Compilation Video (${count} segment${count !== 1 ? 's' : ''} selected)`;
  button.disabled = count === 0;

  if (count === 0) {
    button.title = 'Select at least one segment to generate compilation video';
  } else {
    button.title = `Generate Compilation video from ${count} selected segment${count !== 1 ? 's' : ''}`;
  }
}

function selectAllSegments() {
  const checkboxes = document.querySelectorAll('.segment-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.checked = true;
  });
  updateSelectedSegments();
}

function clearAllSelections() {
  const checkboxes = document.querySelectorAll('.segment-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.checked = false;
  });
  updateSelectedSegments();
}

function toggleVideoSelection(videoId) {
  const videoCheckboxes = document.querySelectorAll(`[data-video-id="${videoId}"]`);
  const checkedCount = document.querySelectorAll(`[data-video-id="${videoId}"]:checked`).length;
  const shouldCheck = checkedCount === 0;

  videoCheckboxes.forEach(checkbox => {
    checkbox.checked = shouldCheck;
  });

  updateSelectedSegments();

  // Update button text
  const button = document.querySelector(`button[onclick="toggleVideoSelection('${videoId}')"]`);
  if (button) {
    const totalSegments = videoCheckboxes.length;
    if (shouldCheck) {
      button.textContent = `✅ All Selected (${totalSegments})`;
    } else {
      button.textContent = `📋 Select All (${totalSegments})`;
    }
  }
}

function showGenerationStatus(message, type = 'processing') {
  const statusDiv = document.getElementById('generation-status');
  if (!statusDiv) return;

  statusDiv.className = `generation-status ${type}`;
  statusDiv.innerHTML = message;
}

function hideGenerationStatus() {
  const statusDiv = document.getElementById('generation-status');
  if (statusDiv) {
    statusDiv.style.display = 'none';
  }
}

async function initiateVideoGeneration() {
  if (selectedSegments.length === 0) {
    alert('Please select at least one segment to generate compilation video.');
    return;
  }

  const button = document.getElementById('generateVideoBtn');
  const originalText = button.textContent;

  try {
    // Initialize session if needed
    initializeSession();

    // Disable button and show processing state
    button.disabled = true;
    button.textContent = '⚙️ Processing...';

    showGenerationStatus(`
      <div style="display: flex; align-items: center; gap: 0.5rem; justify-content: center;">
        <div class="gemini-loading">
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
        <span>Initiating video generation job...</span>
      </div>
    `, 'processing');

    console.log('Sending video generation request:', {
      segments: selectedSegments,
      user_session_id: userSessionId
    });

    // Call the Cloud Run service
    const response = await fetch(`${videoProcessorUrl}/processVideoJob`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        segments: selectedSegments,
        user_session_id: userSessionId
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    console.log('Video generation job created:', result);

    // Store the search query for potential return navigation
    localStorage.setItem('lastSearchQuery', searchInput.value || '');

    // Redirect to status page with job ID
    window.location.href = `status.html?jobId=${result.jobId}`;

  } catch (error) {
    console.error('Video generation failed:', error);

    showGenerationStatus(`
      <div>
        <h4>❌ Video Generation Failed</h4>
        <p><strong>Error:</strong> ${error.message}</p>
        <p style="margin-top: 1rem;">
          <strong>Possible solutions:</strong><br>
          • Check your internet connection<br>
          • Try selecting fewer segments<br>
          • Wait a moment and try again<br>
          • Make sure videos are publicly available
        </p>
        <button onclick="hideGenerationStatus()" style="margin-top: 1rem; padding: 0.5rem 1rem; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
          Dismiss
        </button>
      </div>
    `, 'error');

  } finally {
    // Re-enable button
    button.disabled = selectedSegments.length === 0;
    button.textContent = originalText;
  }
}

// ===== UTILITY FUNCTIONS =====
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function formatTimeHMS(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}

function seekToTime(videoId, startTime) {
  console.log(`Seeking to time ${startTime} for video ${videoId}`);

  const iframe = document.getElementById(`player-${videoId}`);
  if (!iframe) {
    console.error(`Could not find iframe with id: player-${videoId}`);
    return;
  }

  // Create a new URL with the timestamp
  const baseUrl = `https://www.youtube.com/embed/${videoId}`;
  const params = new URLSearchParams({
    enablejsapi: '1',
    rel: '0',
    start: startTime,
    autoplay: '1'
  });
  const newSrc = `${baseUrl}?${params.toString()}`;

  console.log(`Updating iframe src to: ${newSrc}`);

  // Update the iframe source
  iframe.src = newSrc;

  // Scroll to the video player smoothly
  iframe.scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });

  // Optional: Add visual feedback
  const button = event?.target;
  if (button) {
    button.textContent = 'LOADING...';
    button.disabled = true;

    setTimeout(() => {
      button.textContent = 'SKIP TO';
      button.disabled = false;
    }, 2000);
  }
}

// ===== GLOBAL FUNCTION EXPOSURE =====
// Expose functions to global scope so they can be called from onclick handlers
window.simulateProUpgrade = simulateProUpgrade;
window.updateSelectedSegments = updateSelectedSegments;
window.selectAllSegments = selectAllSegments;
window.clearAllSelections = clearAllSelections;
window.toggleVideoSelection = toggleVideoSelection;
window.hideGenerationStatus = hideGenerationStatus;
window.initiateVideoGeneration = initiateVideoGeneration;
window.seekToTime = seekToTime;
