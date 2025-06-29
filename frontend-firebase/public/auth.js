// Auth.js - Handles Firebase Authentication for the sign-in page

document.addEventListener('DOMContentLoaded', function () {
  // Check if user is already signed in
  firebase.auth().onAuthStateChanged(user => {
    if (user) {
      // User is already signed in, redirect to main page
      window.location.href = 'index.html';
    } else {
      // User is not signed in, show the sign-in widget
      initializeSignInWidget();
    }
  });
});

function initializeSignInWidget() {
  // FirebaseUI config
  const uiConfig = {
    signInSuccessUrl: 'index.html', // Redirect to main page on success
    signInOptions: [
      // Only Google Sign-In
      {
        provider: firebase.auth.GoogleAuthProvider.PROVIDER_ID,
        customParameters: {
          // Force account selection even if one account is available
          prompt: 'select_account'
        }
      }
    ],
    // Terms of service url/callback
    tosUrl: '/404.html', // You can replace this with your actual ToS URL
    // Privacy policy url/callback
    privacyPolicyUrl: '/404.html', // You can replace this with your actual Privacy Policy URL
    callbacks: {
      signInSuccessWithAuthResult: function(authResult, redirectUrl) {
        // User successfully signed in
        console.log('User signed in successfully:', authResult.user);
        
        // You can perform additional actions here before redirect
        // For example, create user profile, send analytics event, etc.
        
        // Return true to continue the redirect automatically
        return true;
      },
      uiShown: function() {
        // The widget is rendered
        console.log('FirebaseUI widget rendered');
      },
      signInFailure: function(error) {
        // Handle sign-in errors
        console.error('Sign-in error:', error);
        return Promise.resolve();
      }
    }
  };

  // Initialize the FirebaseUI Widget using Firebase
  const ui = new firebaseui.auth.AuthUI(firebase.auth());
  
  // Start the FirebaseUI widget
  ui.start('#firebaseui-auth-container', uiConfig);
}
