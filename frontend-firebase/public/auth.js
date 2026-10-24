// Auth.js - Handles Firebase Authentication for the sign-in page
// Sign-in is free; it is only required for video generation.

let authInitialized = false;
let isSigningIn = false;
let authStateListener = null;
let redirectTimeout = null;
let verificationEmailPromise = null; // the redirect waits for it so the request isn't cut off

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

function handleSuccessfulSignIn(user) {
  console.log('Signed in as:', user.email);
  // Schedule redirect with delay to prevent race conditions
  scheduleRedirectToHome();
}

// Where to go after sign-in: ?next=<same-origin path>, defaulting to the home page.
function getRedirectPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    return next;
  }
  return '/index.html';
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
  const redirectUrl = window.location.origin + getRedirectPath();
  
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
  Promise.resolve(verificationEmailPromise)
    .catch(error => console.error('Could not send the verification email:', error))
    .finally(() => window.location.replace(redirectUrl));
}

function initializeSignInWidget() {
  console.log('Initializing FirebaseUI widget...');
  
  const authContainer = document.getElementById('firebaseui-auth-container');
  if (!authContainer) {
    console.error('Auth container not found');
    return;
  }
  
  // Clear any existing content
  authContainer.innerHTML = '';
  
  // Delete any existing AuthUI instance
  if (firebaseui.auth.AuthUI.getInstance()) {
    firebaseui.auth.AuthUI.getInstance().delete();
  }
  
  const uiConfig = {
    signInFlow: 'popup',
    signInOptions: [
      {
        provider: firebase.auth.GoogleAuthProvider.PROVIDER_ID,
        customParameters: {
          prompt: 'select_account'
        }
      },
      {
        provider: firebase.auth.EmailAuthProvider.PROVIDER_ID,
      }
    ],
    signInSuccessUrl: window.location.origin + getRedirectPath(),
    credentialHelper: firebaseui.auth.CredentialHelper.NONE,
    tosUrl: `/404.html`,
    privacyPolicyUrl: `/404.html`,
    callbacks: {
      signInSuccessWithAuthResult: function(authResult, redirectUrl) {
        console.log('FirebaseUI sign-in success callback triggered');
        console.log('Auth result:', {
          user: authResult.user.email,
          uid: authResult.user.uid,
          additionalUserInfo: authResult.additionalUserInfo,
          isNewUser: authResult.additionalUserInfo ? authResult.additionalUserInfo.isNewUser : false
        });
        
        // Video generation requires a verified email; Google accounts already are.
        const user = authResult.user;
        if (authResult.additionalUserInfo?.isNewUser && !user.emailVerified
            && user.providerData.some(p => p.providerId === 'password')) {
          verificationEmailPromise = user.sendEmailVerification();
        }

        // Let the auth state listener handle the redirect
        return false;
      },
      uiShown: function() {
        console.log('FirebaseUI widget shown');
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
    const ui = new firebaseui.auth.AuthUI(firebase.auth());
    
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
