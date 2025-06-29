// Auth.js - Handles Firebase Authentication for the sign-in page

let authInitialized = false;
let isSigningIn = false;
let authStateListener = null;
let redirectTimeout = null;

document.addEventListener('DOMContentLoaded', function () {
  console.log('Auth page loaded, initializing...');
  
  // Wait for Firebase to be properly loaded
  waitForFirebase().then(() => {
    initializeSignInPage();
  }).catch(error => {
    console.error('Failed to initialize Firebase:', error);
  });
});

function waitForFirebase() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 20; // 10 seconds max wait
    
    const checkFirebase = () => {
      attempts++;
      
      if (typeof firebase !== 'undefined' && firebase.auth && typeof firebaseui !== 'undefined') {
        console.log('Firebase and FirebaseUI ready');
        
        // Set auth persistence to LOCAL (browser storage)
        firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
          .then(() => {
            console.log('Auth persistence set to LOCAL');
          })
          .catch((error) => {
            console.error('Error setting auth persistence:', error);
          });
        
        resolve();
      } else if (attempts >= maxAttempts) {
        reject(new Error('Firebase/FirebaseUI failed to load within timeout'));
      } else {
        console.log(`Waiting for Firebase... attempt ${attempts}`);
        setTimeout(checkFirebase, 500);
      }
    };
    
    checkFirebase();
  });
}

function initializeSignInPage() {
  if (authInitialized) return;
  authInitialized = true;
  
  console.log('Initializing sign-in page with popup flow...');
  
  // Clear any existing redirect timeout
  if (redirectTimeout) {
    clearTimeout(redirectTimeout);
    redirectTimeout = null;
  }
  
  // Remove any existing auth state listener
  if (authStateListener) {
    authStateListener();
    authStateListener = null;
  }
  
  // Check current auth state first
  const currentUser = firebase.auth().currentUser;
  if (currentUser) {
    console.log('User already authenticated on page load:', currentUser.email);
    scheduleRedirectToHome();
    return;
  }
  
  // Set up single auth state listener for popup flow
  authStateListener = firebase.auth().onAuthStateChanged(user => {
    console.log('Auth state changed:', user ? `User: ${user.email}` : 'No user', 'isSigningIn:', isSigningIn);
    
    if (user && !isSigningIn) {
      console.log('User authenticated, initiating redirect flow');
      isSigningIn = true;
      
      // Show loading during user record creation
      showLoadingState();
      
      // Create user record and redirect
      handleSuccessfulSignIn(user);
      
    } else if (!user && !isSigningIn) {
      console.log('No user authenticated, showing sign-in widget');
      hideLoadingState();
      initializeSignInWidget();
    }
  });
}

function showLoadingState() {
  const loadingDiv = document.getElementById('loading-message');
  if (loadingDiv) {
    loadingDiv.style.display = 'block';
  }
  
  const authContainer = document.getElementById('firebaseui-auth-container');
  if (authContainer) {
    authContainer.style.display = 'none';
  }
}

function hideLoadingState() {
  const loadingDiv = document.getElementById('loading-message');
  if (loadingDiv) {
    loadingDiv.style.display = 'none';
  }
  
  const authContainer = document.getElementById('firebaseui-auth-container');
  if (authContainer) {
    authContainer.style.display = 'block';
  }
}

async function handleSuccessfulSignIn(user) {
  try {
    console.log('Creating/verifying user record in Firestore for:', user.email);
    
    // Call getUserSubscriptionStatus to ensure user record is created
    const getUserStatus = firebase.functions().httpsCallable('getUserSubscriptionStatus');
    const result = await getUserStatus({
      userId: user.uid,
      sessionId: null
    });
    
    console.log('User record created/verified:', result.data);
    
  } catch (error) {
    console.error('Error creating user record:', error);
    // Continue anyway
  }
  
  // Schedule redirect with delay to prevent race conditions
  console.log('Scheduling redirect to home page...');
  scheduleRedirectToHome();
}

function scheduleRedirectToHome() {
  // Clear any existing redirect timeout
  if (redirectTimeout) {
    clearTimeout(redirectTimeout);
  }
  
  // Schedule redirect with a short delay
  redirectTimeout = setTimeout(() => {
    redirectToHome();
  }, 1000);
}

function redirectToHome() {
  // Get current origin to build absolute URL
  const baseUrl = window.location.origin;
  const redirectUrl = `${baseUrl}/index.html`;
  
  console.log('Executing redirect to:', redirectUrl);
  
  // Clear the redirect timeout
  if (redirectTimeout) {
    clearTimeout(redirectTimeout);
    redirectTimeout = null;
  }
  
  // Remove auth state listener to prevent interference
  if (authStateListener) {
    authStateListener();
    authStateListener = null;
  }
  
  // Use replace to prevent back button loop
  window.location.replace(redirectUrl);
}

function initializeSignInWidget() {
  console.log('Initializing FirebaseUI widget...');
  
  // Get current origin for absolute URLs
  const baseUrl = window.location.origin;
  
  const uiConfig = {
    signInFlow: 'popup', // Use popup flow instead of redirect - this works!
    signInOptions: [
      {
        provider: firebase.auth.GoogleAuthProvider.PROVIDER_ID,
        customParameters: {
          prompt: 'select_account'
        }
      }
    ],
    tosUrl: `/404.html`,
    privacyPolicyUrl: `/404.html`,
    callbacks: {
      signInSuccessWithAuthResult: function(authResult, redirectUrl) {
        console.log('FirebaseUI popup sign-in success callback triggered');
        console.log('Auth result:', {
          user: authResult.user.email,
          uid: authResult.user.uid,
          additionalUserInfo: authResult.additionalUserInfo
        });
        
        // The auth state listener will handle the redirect
        // Just return false to prevent FirebaseUI from handling redirect
        console.log('FirebaseUI callback complete, letting auth state listener handle redirect');
        return false;
      },
      uiShown: function() {
        console.log('FirebaseUI widget shown');
        // Ensure loading is hidden and auth container is shown
        hideLoadingState();
      },
      signInFailure: function(error) {
        console.error('Sign-in failure:', error);
        isSigningIn = false;
        hideLoadingState();
        return Promise.resolve();
      }
    }
  };

  try {
    // Get or create the auth container
    let authContainer = document.getElementById('firebaseui-auth-container');
    if (!authContainer) {
      console.error('Auth container not found');
      return;
    }
    
    // Clear any existing content
    authContainer.innerHTML = '';
    
    // Initialize the FirebaseUI Widget
    const ui = new firebaseui.auth.AuthUI(firebase.auth());
    
    // Start the FirebaseUI widget
    ui.start('#firebaseui-auth-container', uiConfig);
    console.log('FirebaseUI widget started successfully');
    
  } catch (error) {
    console.error('Error starting FirebaseUI:', error);
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', function() {
  console.log('Page unloading, cleaning up auth listeners');
  
  if (authStateListener) {
    authStateListener();
    authStateListener = null;
  }
  
  if (redirectTimeout) {
    clearTimeout(redirectTimeout);
    redirectTimeout = null;
  }
  
  isSigningIn = false;
  authInitialized = false;
});

// Reset state if user navigates back to this page
window.addEventListener('pageshow', function(event) {
  if (event.persisted) {
    console.log('Page restored from cache, resetting auth state');
    isSigningIn = false;
    authInitialized = false;
    
    // Re-initialize if Firebase is ready
    if (typeof firebase !== 'undefined' && firebase.auth) {
      initializeSignInPage();
    }
  }
});
