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
  firebase.auth().onAuthStateChanged(async user => {
    const authButtonsContainer = document.getElementById('auth-buttons');
    const userInfoContainer = document.getElementById('user-info');

    if (user) {
      // User is signed in
      console.log('User signed in:', user.email);
      
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

      // Update session to use Firebase Auth UID
      userSessionId = user.uid;
      
      // Get user plan from custom claims
      try {
        const tokenResult = await user.getIdTokenResult(true); // Force refresh
        const customClaims = tokenResult.claims;
        userPlan = customClaims.plan || 'free';
        localStorage.setItem('jre_user_plan', userPlan);
        console.log('User plan from custom claims:', userPlan);
        
        // Update video generation button if it exists
        updateGenerateVideoButton();
      } catch (error) {
        console.error('Error getting custom claims on auth change:', error);
        userPlan = 'free';
        localStorage.setItem('jre_user_plan', 'free');
        // Update video generation button with fallback
        updateGenerateVideoButton();
      }

    } else {
      // User is signed out - show sign-in button
      console.log('User signed out or not authenticated');
      
      if (authButtonsContainer) authButtonsContainer.style.display = 'block';
      if (userInfoContainer) userInfoContainer.style.display = 'none';

      // Reset to anonymous session
      userSessionId = null;
      initializeSession(); // Will create new anonymous session
      
      // Set user as free
      userPlan = 'free';
      localStorage.setItem('jre_user_plan', 'free');
      
      // Update video generation button for unauthenticated user
      updateGenerateVideoButton();
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
  // Check if user is authenticated with Firebase
  const currentUser = firebase.auth().currentUser;
  
  if (currentUser) {
    // Use Firebase Auth UID as the primary identifier
    userSessionId = currentUser.uid;
    console.log('Using Firebase Auth UID as session ID:', userSessionId);
  } else {
    // Fallback to anonymous session for non-authenticated users
    if (!userSessionId) {
      userSessionId = 'session_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      console.log('Using anonymous session ID:', userSessionId);
    }
  }
}

// Helper function to refresh user's custom claims
async function refreshUserClaims() {
  try {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) {
      console.log('No authenticated user to refresh claims for');
      return null;
    }

    // Force token refresh to get latest custom claims
    const tokenResult = await currentUser.getIdTokenResult(true);
    const customClaims = tokenResult.claims;
    
    // Update global user plan
    userPlan = customClaims.plan || 'free';
    localStorage.setItem('jre_user_plan', userPlan);
    
    console.log('User claims refreshed:', {
      plan: customClaims.plan,
      subscriptionStatus: customClaims.subscriptionStatus
    });
    
    return customClaims;
  } catch (error) {
    console.error('Error refreshing user claims:', error);
    return null;
  }
}

// Helper function to get current user identification
function getCurrentUserIdentification() {
  const currentUser = firebase.auth().currentUser;
  
  return {
    userId: currentUser ? currentUser.uid : null,
    sessionId: currentUser ? null : userSessionId, // Only use sessionId for anonymous users
    isAuthenticated: !!currentUser,
    email: currentUser ? currentUser.email : null
  };
}

async function checkUserStatus() {
  try {
    initializeSession();
    const userInfo = getCurrentUserIdentification();
    const currentUser = firebase.auth().currentUser;

    // Get subscription data from Firebase Auth custom claims
    let plan = 'free';
    let subscriptionStatus = null;
    let subscriptionId = null;
    let upgradedAt = null;
    let canceledAt = null;

    if (currentUser) {
      // Force token refresh to get latest custom claims
      const tokenResult = await currentUser.getIdTokenResult(true);
      const customClaims = tokenResult.claims;

      plan = customClaims.plan || 'free';
      subscriptionStatus = customClaims.subscriptionStatus || null;
      subscriptionId = customClaims.subscriptionId || null;
      upgradedAt = customClaims.upgradedAt || null;
      canceledAt = customClaims.canceledAt || null;

      console.log('User status from Firebase Auth custom claims:', {
        isAuthenticated: userInfo.isAuthenticated,
        plan: plan,
        subscriptionStatus: subscriptionStatus
      });
    }
    
    return {
      allowed: true, // All users have unlimited searches now
      plan: plan,
      canGenerateVideos: userInfo.isAuthenticated && plan === 'pro' && subscriptionStatus === 'active',
      message: userInfo.isAuthenticated 
        ? (plan === 'pro' ? 'Pro user - unlimited searches and video generation.' : 'Unlimited searches available. Upgrade to Pro for video generation.')
        : 'Unlimited searches available. Sign in for premium features.',
      subscriptionStatus: subscriptionStatus,
      subscriptionId: subscriptionId,
      upgradedAt: upgradedAt,
      canceledAt: canceledAt,
      isAuthenticated: userInfo.isAuthenticated,
      userEmail: userInfo.email
    };
  } catch (error) {
    console.error('Error checking user status:', error);
    const userInfo = getCurrentUserIdentification();
    
    // Fallback to free user status
    return {
      allowed: true,
      plan: 'free',
      canGenerateVideos: false,
      message: userInfo.isAuthenticated 
        ? 'Unlimited searches available. Upgrade to Pro for video generation.'
        : 'Unlimited searches available. Sign in for premium features.',
      isAuthenticated: userInfo.isAuthenticated,
      userEmail: userInfo.email
    };
  }
}

// Demo function to simulate Pro upgrade
function simulateProUpgrade() {
  userPlan = 'pro';
  localStorage.setItem('jre_user_plan', 'pro');

  // Clear rate limit message
  searchResultsContainer.innerHTML = `
    <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 2rem; border-radius: 8px; text-align: center; margin: 2rem 0;">
      <h3 style="color: #155724; margin-bottom: 1rem;">🎉 Welcome to Pro!</h3>
      <p style="color: #155724; margin-bottom: 1rem;">
        You now have unlimited searches and video generation! Try searching again.
      </p>
      <p style="color: #155724; font-size: 0.9rem;">
        <em>This is a demo mode. In production, custom claims would be updated via backend functions.</em>
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
      pageSize: 30,
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
      lastSearchResults = data.results || [];

      // Extract session and queryId from the API response
      currentSession = data.sessionInfo?.name || null;
      currentQueryId = data.sessionInfo?.queryId || null;

      console.log('Search completed:', data);

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
  const currentUser = firebase.auth().currentUser;
  
  // Check user authentication and subscription status from Firebase Auth
  if (!currentUser) {
    // User not authenticated
    button.textContent = `🔒 Generate Compilation Video (Sign In Required) - ${count} segment${count !== 1 ? 's' : ''} selected`;
    button.disabled = count === 0;
    button.title = count === 0 
      ? 'Select segments and sign in to access video generation'
      : `Sign in to generate compilation video from ${count} selected segment${count !== 1 ? 's' : ''}`;
    button.style.background = 'linear-gradient(135deg, #6c757d, #5a6268)';
    button.style.border = '2px solid #6c757d';
    return;
  }

  // User is authenticated - check custom claims for subscription status
  currentUser.getIdTokenResult().then(tokenResult => {
    const customClaims = tokenResult.claims;
    const plan = customClaims.plan || 'free';
    const subscriptionStatus = customClaims.subscriptionStatus || null;
    
    if (plan === 'pro' && subscriptionStatus === 'active') {
      // Pro user - normal functionality
      button.textContent = `📹 Generate Compilation Video (${count} segment${count !== 1 ? 's' : ''} selected)`;
      button.disabled = count === 0;
      button.title = count === 0 
        ? 'Select at least one segment to generate compilation video'
        : `Generate compilation video from ${count} selected segment${count !== 1 ? 's' : ''}`;
      button.style.background = ''; // Reset to default CSS styling
      button.style.border = '';
    } else {
      // Free user - show upgrade messaging
      button.textContent = `🔒 Generate Compilation Video (Premium Only) - ${count} segment${count !== 1 ? 's' : ''} selected`;
      button.disabled = count === 0;
      button.title = count === 0 
        ? 'Select segments and upgrade to Pro to generate compilation videos'
        : `Upgrade to Pro to generate compilation video from ${count} selected segment${count !== 1 ? 's' : ''}`;
      button.style.background = 'linear-gradient(135deg, #ffa500, #ff6b35)';
      button.style.border = '2px solid #ff6b35';
    }
  }).catch(error => {
    console.error('Error getting custom claims for button update:', error);
    // Fallback to free user display
    button.textContent = `🔒 Generate Compilation Video (Premium Only) - ${count} segment${count !== 1 ? 's' : ''} selected`;
    button.disabled = count === 0;
    button.style.background = 'linear-gradient(135deg, #ffa500, #ff6b35)';
    button.style.border = '2px solid #ff6b35';
  });
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

  const currentUser = firebase.auth().currentUser;
  
  // Check if user is authenticated
  if (!currentUser) {
    showAuthRequiredModal({
      requiresAuth: true,
      message: 'Please sign in to access video generation features.',
      signInUrl: '/signin.html',
      hasManualOption: true,
      plan: 'free'
    });
    return;
  }

  try {
    // Get user's subscription status from Firebase Auth custom claims
    const tokenResult = await currentUser.getIdTokenResult();
    const customClaims = tokenResult.claims;
    const plan = customClaims.plan || 'free';
    const subscriptionStatus = customClaims.subscriptionStatus || null;

    // Check if user has pro subscription with active status
    if (plan !== 'pro' || subscriptionStatus !== 'active') {
      // User is authenticated but needs to upgrade
      showUpgradeRequiredModal({
        requiresUpgrade: true,
        message: 'Upgrade to Pro for instant video generation',
        upgradeUrl: '/pricing.html',
        userEmail: currentUser.email,
        plan: plan,
        hasManualOption: true
      });
      return;
    }

    // User is premium - proceed with video generation
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

  } catch (error) {
    console.error('Error checking user subscription status:', error);
    
    // Fallback to requiring upgrade
    showUpgradeRequiredModal({
      requiresUpgrade: true,
      message: 'Unable to verify subscription status. Please upgrade to Pro for video generation.',
      upgradeUrl: '/pricing.html',
      userEmail: currentUser.email,
      plan: 'free',
      hasManualOption: true
    });
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
window.refreshUserClaims = refreshUserClaims;
window.updateSelectedSegments = updateSelectedSegments;
window.selectAllSegments = selectAllSegments;
window.clearAllSelections = clearAllSelections;
window.toggleVideoSelection = toggleVideoSelection;
window.hideGenerationStatus = hideGenerationStatus;
window.initiateVideoGeneration = initiateVideoGeneration;
window.seekToTime = seekToTime;

// Show modal for non-authenticated users
function showAuthRequiredModal(permission) {
  const modal = document.createElement('div');
  modal.className = 'auth-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>🔐 Sign In Required</h2>
        <button class="close-modal" onclick="this.parentElement.parentElement.parentElement.remove()">×</button>
      </div>
      <div class="modal-body">
        <p><strong>${permission.message}</strong></p>
        <div class="options-container">
          <div class="option-card premium-option">
            <h3>🚀 Premium Option</h3>
            <p>Sign in and upgrade to Pro for instant video generation</p>
            <ul>
              <li>✅ Instant video generation</li>
              <li>✅ HD quality exports</li>
              <li>✅ Priority processing</li>
              <li>✅ Advanced editing features</li>
            </ul>
            <button class="btn-primary" onclick="window.location.href='/signin.html'">
              Sign In & Upgrade
            </button>
          </div>
          <div class="option-card manual-option">
            <h3>📧 Free Manual Option</h3>
            <p>Get your video manually created within 24-48 hours</p>
            <ul>
              <li>✅ Free service</li>
              <li>✅ Manual editing by developer</li>
              <li>✅ Email delivery</li>
              <li>⏱️ 24-48 hour delivery</li>
            </ul>
            <button class="btn-secondary" onclick="showManualRequestForm()">
              Request Manual Video
            </button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.parentElement.parentElement.parentElement.remove()">
          Maybe Later
        </button>
      </div>
    </div>
  `;
  
  addModalStyles();
  document.body.appendChild(modal);
}

// Show modal for authenticated users who need to upgrade
function showUpgradeRequiredModal(permission) {
  const modal = document.createElement('div');
  modal.className = 'auth-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>⚡ Upgrade to Pro</h2>
        <button class="close-modal" onclick="this.parentElement.parentElement.parentElement.remove()">×</button>
      </div>
      <div class="modal-body">
        <p>Hi <strong>${permission.userEmail}</strong>!</p>
        <p><strong>${permission.message}</strong></p>
        <div class="options-container">
          <div class="option-card premium-option">
            <h3>🚀 Upgrade to Pro</h3>
            <p>Get instant video generation for $9.99/month</p>
            <ul>
              <li>✅ Instant video generation</li>
              <li>✅ Unlimited videos</li>
              <li>✅ HD quality exports</li>
              <li>✅ Priority processing</li>
              <li>✅ Cancel anytime</li>
            </ul>
            <button class="btn-primary" onclick="initiateProUpgrade()">
              Upgrade Now - $9.99/month
            </button>
          </div>
          <div class="option-card manual-option">
            <h3>📧 Free Manual Option</h3>
            <p>Or get your video manually created (24-48 hours)</p>
            <ul>
              <li>✅ Free service</li>
              <li>✅ Manual editing</li>
              <li>✅ Email delivery</li>
              <li>⏱️ 24-48 hour delivery</li>
            </ul>
            <button class="btn-secondary" onclick="showManualRequestForm()">
              Request Manual Video
            </button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.parentElement.parentElement.parentElement.remove()">
          Maybe Later
        </button>
      </div>
    </div>
  `;
  
  addModalStyles();
  document.body.appendChild(modal);
}

// Show manual video request form
function showManualRequestForm() {
  // Close any existing modals
  document.querySelectorAll('.auth-modal, .upgrade-modal').forEach(modal => modal.remove());
  
  const modal = document.createElement('div');
  modal.className = 'manual-request-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>📧 Manual Video Request</h2>
        <button class="close-modal" onclick="this.parentElement.parentElement.parentElement.remove()">×</button>
      </div>
      <div class="modal-body">
        <p>We'll manually create your compilation video and email it to you within 24-48 hours!</p>
        <form id="manual-request-form">
          <div class="form-group">
            <label for="request-email">Your Email Address *</label>
            <input type="email" id="request-email" required placeholder="your.email@example.com">
          </div>
          <div class="form-group">
            <label for="request-name">Your Name (Optional)</label>
            <input type="text" id="request-name" placeholder="Your name">
          </div>
          <div class="form-group">
            <label>Selected Segments</label>
            <div class="segments-summary">
              <p><strong>${selectedSegments.length} segments</strong> selected from your search results</p>
              <p class="search-query"><strong>Search:</strong> "${searchInput.value || 'Not specified'}"</p>
            </div>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" id="agree-terms" required>
              I understand this is a free service with 24-48 hour delivery
            </label>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.parentElement.parentElement.parentElement.remove()">
          Cancel
        </button>
        <button class="btn-primary" onclick="submitManualRequest()">
          Submit Request
        </button>
      </div>
    </div>
  `;
  
  addModalStyles();
  document.body.appendChild(modal);
}

// Submit manual video request
async function submitManualRequest() {
  const email = document.getElementById('request-email').value;
  const name = document.getElementById('request-name').value;
  const agreeTerms = document.getElementById('agree-terms').checked;
  
  if (!email || !agreeTerms) {
    alert('Please fill in your email and agree to the terms.');
    return;
  }
  
  if (selectedSegments.length === 0) {
    alert('No segments selected. Please select some segments first.');
    return;
  }
  
  try {
    // Show loading state
    const submitBtn = document.querySelector('.manual-request-modal .btn-primary');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;
    
    const userInfo = getCurrentUserIdentification();
    
    const requestManual = firebase.functions().httpsCallable('requestManualVideoGeneration');
    const result = await requestManual({
      userEmail: email,
      userName: name,
      segments: selectedSegments,
      searchQuery: searchInput.value || '',
      userId: userInfo.userId,
      sessionId: userInfo.sessionId,
      isAuthenticated: userInfo.isAuthenticated
    });
    
    // Show success message
    document.querySelector('.manual-request-modal').remove();
    showSuccessModal(result.data);
    
  } catch (error) {
    console.error('Error submitting manual request:', error);
    alert('Error submitting request. Please try again.');
    
    // Reset button
    const submitBtn = document.querySelector('.manual-request-modal .btn-primary');
    if (submitBtn) {
      submitBtn.textContent = 'Submit Request';
      submitBtn.disabled = false;
    }
  }
}

// Show success modal after manual request
function showSuccessModal(data) {
  const modal = document.createElement('div');
  modal.className = 'success-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>✅ Request Submitted!</h2>
      </div>
      <div class="modal-body">
        <p><strong>${data.message}</strong></p>
        <div class="request-details">
          <p><strong>Request ID:</strong> ${data.requestId}</p>
          <p><strong>Estimated Delivery:</strong> ${data.estimatedDelivery}</p>
        </div>
        <p>Save your Request ID for reference. We'll email you when your video is ready!</p>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" onclick="this.parentElement.parentElement.parentElement.remove()">
          Great, Thanks!
        </button>
      </div>
    </div>
  `;
  
  addModalStyles();
  document.body.appendChild(modal);
}

// Initiate Pro upgrade for authenticated users
async function initiateProUpgrade() {
  try {
    // Check if user is authenticated
    const user = firebase.auth().currentUser;
    if (!user) {
      alert('Please sign in first');
      window.location.href = '/signin.html';
      return;
    }

    // Check if Stripe is loaded
    if (typeof Stripe === 'undefined') {
      console.error('Stripe.js is not loaded');
      alert('Payment system not ready. Please refresh the page and try again.');
      return;
    }

    // Show loading state
    const upgradeButton = event?.target;
    if (upgradeButton) {
      upgradeButton.disabled = true;
      upgradeButton.textContent = 'Creating checkout session...';
    }
    
    // Call Firebase Function to create checkout session
    const createCheckout = firebase.functions().httpsCallable('createCheckoutSessionAuth');
    const result = await createCheckout();
    
    if (!result.data?.sessionId) {
      throw new Error('No session ID returned from server');
    }

    // Initialize Stripe and redirect to checkout
    const stripe = Stripe('pk_test_51Rco8nR9HLu4Z6TSlSjCZypyASEmikaanI10fX2UA0tQSYJZy5A2rQU7eaMNB0jATz9NHNDTPO47cXBoLGsfAnuR00GC3QLQwi');
    
    // Redirect to Stripe checkout
    const { error } = await stripe.redirectToCheckout({
      sessionId: result.data.sessionId
    });

    if (error) {
      throw new Error(`Stripe checkout error: ${error.message}`);
    }
    
  } catch (error) {
    console.error('Error creating checkout session:', error);
    
    // Reset button state
    const upgradeButton = event?.target;
    if (upgradeButton) {
      upgradeButton.disabled = false;
      upgradeButton.textContent = 'Upgrade to Pro';
    }

    // Show user-friendly error message
    if (error.message?.includes('already a Pro subscriber')) {
      alert('You are already a Pro subscriber! 🎉');
    } else if (error.message?.includes('unauthenticated')) {
      alert('Please sign in to upgrade to Pro');
      window.location.href = '/signin.html';
    } else if (error.message?.includes('Payment service not available')) {
      alert('Payment system is temporarily unavailable. Please try again later.');
    } else {
      alert('Error starting checkout. Please try again or contact support if the problem persists.');
    }
  }
}

// Add modal styles
function addModalStyles() {
  if (document.getElementById('modal-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'modal-styles';
  style.textContent = `
    .auth-modal, .manual-request-modal, .success-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10000;
    }
    .modal-content {
      background: #1a1a1a;
      border-radius: 12px;
      max-width: 700px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      border: 1px solid #333;
    }
    .modal-header {
      padding: 20px;
      border-bottom: 1px solid #333;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-header h2 {
      margin: 0;
      color: #ff6b35;
    }
    .close-modal {
      background: none;
      border: none;
      color: #ccc;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .close-modal:hover {
      color: #fff;
    }
    .modal-body {
      padding: 20px;
      color: #ccc;
    }
    .options-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin: 20px 0;
    }
    .option-card {
      background: #2a2a2a;
      padding: 20px;
      border-radius: 8px;
      border: 2px solid #444;
    }
    .premium-option {
      border-color: #ff6b35;
    }
    .manual-option {
      border-color: #28a745;
    }
    .option-card h3 {
      margin: 0 0 10px 0;
      color: #fff;
    }
    .option-card ul {
      margin: 15px 0;
      padding-left: 20px;
    }
    .option-card li {
      margin: 8px 0;
    }
    .form-group {
      margin: 15px 0;
    }
    .form-group label {
      display: block;
      margin-bottom: 5px;
      color: #ccc;
      font-weight: 500;
    }
    .form-group input {
      width: 100%;
      padding: 10px;
      border: 1px solid #555;
      border-radius: 4px;
      background: #333;
      color: #fff;
    }
    .segments-summary {
      background: #2a2a2a;
      padding: 15px;
      border-radius: 6px;
      border: 1px solid #444;
    }
    .search-query {
      font-style: italic;
      color: #aaa;
    }
    .request-details {
      background: #2a2a2a;
      padding: 15px;
      border-radius: 6px;
      margin: 15px 0;
    }
    .modal-footer {
      padding: 20px;
      border-top: 1px solid #333;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .btn-primary, .btn-secondary {
      padding: 12px 24px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #ff6b35, #ffa500);
      color: white;
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(255, 107, 53, 0.4);
    }
    .btn-secondary {
      background: #333;
      color: #ccc;
      border: 1px solid #555;
    }
    .btn-secondary:hover {
      background: #444;
      color: #fff;
    }
    @media (max-width: 768px) {
      .options-container {
        grid-template-columns: 1fr;
      }
      .modal-content {
        width: 95%;
        margin: 20px;
      }
    }
  `;
  document.head.appendChild(style);
}

// Add functions to global scope
window.showAuthRequiredModal = showAuthRequiredModal;
window.showUpgradeRequiredModal = showUpgradeRequiredModal;
window.showManualRequestForm = showManualRequestForm;
window.submitManualRequest = submitManualRequest;
window.initiateProUpgrade = initiateProUpgrade;
