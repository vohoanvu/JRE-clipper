// firebase-config.js - Firebase Web SDK Configuration

// Import the functions you need from the SDKs
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-functions.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-analytics.js';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDnuPflwDM_Him7KozhdR4QZruQSiObay0",
  authDomain: "gen-lang-client-demo.firebaseapp.com",
  projectId: "gen-lang-client-demo",
  storageBucket: "gen-lang-client-demo.firebasestorage.app",
  messagingSenderId: "408323719521",
  appId: "1:408323719521:web:cb81b241c0eb131c224520",
  measurementId: "G-28DR17HF9R"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase services
export const auth = getAuth(app);
export const functions = getFunctions(app);
export const analytics = getAnalytics(app);

// Make Firebase globally available for compatibility with existing code
window.firebase = {
  auth: () => auth,
  functions: () => functions,
  analytics: () => analytics
};
