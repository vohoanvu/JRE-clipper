// Account Management JavaScript
// Handles user profile, subscription management, and billing

let currentUser = null;
let userSubscriptionData = null;
let functions = null;
let stripe = null;

// Initialize Stripe
if (typeof Stripe !== 'undefined') {
    stripe = Stripe('pk_test_51Rco8nR9HLu4Z6TSlSjCZypyASEmikaanI10fX2UA0tQSYJZy5A2rQU7eaMNB0jATz9NHNDTPO47cXBoLGsfAnuR00GC3QLQwi');
}

document.addEventListener('DOMContentLoaded', function() {
    console.log('Account page loaded, initializing...');
    
    // Wait for Firebase to be ready
    waitForFirebase().then(() => {
        initializeAccountPage();
    }).catch(error => {
        console.error('Failed to initialize Firebase:', error);
        showError('Failed to initialize. Please refresh the page.');
    });
});

function waitForFirebase() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 20;
        
        const checkFirebase = () => {
            attempts++;
            
            if (typeof firebase !== 'undefined' && firebase.auth && firebase.functions) {
                console.log('Firebase ready');
                functions = firebase.functions();
                resolve();
            } else if (attempts >= maxAttempts) {
                reject(new Error('Firebase failed to load'));
            } else {
                console.log(`Waiting for Firebase... attempt ${attempts}`);
                setTimeout(checkFirebase, 500);
            }
        };
        
        checkFirebase();
    });
}

function initializeAccountPage() {
    console.log('Initializing account page...');
    
    // Set up auth state listener
    firebase.auth().onAuthStateChanged(async (user) => {
        console.log('Auth state changed:', user ? user.email : 'No user');
        
        if (user) {
            currentUser = user;
            await loadUserAccount(user);
        } else {
            showAuthRequired();
        }
    });
    
    // Set up event listeners
    setupEventListeners();
}

function setupEventListeners() {
    // Sign out button
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
    
    // Upgrade button
    const upgradeBtn = document.getElementById('upgrade-btn');
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', initiateUpgrade);
    }
    
    // Manage subscription button
    const manageBtn = document.getElementById('manage-subscription-btn');
    if (manageBtn) {
        manageBtn.addEventListener('click', openStripeCustomerPortal);
    }
    
    // Cancel subscription button
    const cancelBtn = document.getElementById('cancel-subscription-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', showCancelModal);
    }
    
    // Modal buttons
    const confirmCancelBtn = document.getElementById('confirm-cancel');
    const modalCancelBtn = document.getElementById('modal-cancel');
    const cancelModal = document.getElementById('cancel-modal');
    
    if (confirmCancelBtn) {
        confirmCancelBtn.addEventListener('click', confirmCancelSubscription);
    }
    
    if (modalCancelBtn) {
        modalCancelBtn.addEventListener('click', hideCancelModal);
    }
    
    // Close modal when clicking outside
    if (cancelModal) {
        cancelModal.addEventListener('click', (e) => {
            if (e.target === cancelModal) {
                hideCancelModal();
            }
        });
    }
}

async function loadUserAccount(user) {
    console.log('Loading account for user:', user.email);
    
    try {
        // Hide loading and show content
        hideLoading();
        showAccountContent();
        
        // Update header user info
        updateHeaderUserInfo(user);
        
        // Load profile information
        updateProfileInfo(user);
        
        // Load subscription status
        await loadSubscriptionStatus();
        
        // Load usage statistics (placeholder for now)
        updateUsageStats();
        
        // Set up real-time claims monitoring
        setupClaimsWatcher();
        
    } catch (error) {
        console.error('Error loading user account:', error);
        showError('Failed to load account information. Please refresh the page.');
    }
}

function updateHeaderUserInfo(user) {
    const userInfo = document.getElementById('user-info');
    const userPhoto = document.getElementById('user-photo');
    const userEmail = document.getElementById('user-email');
    
    if (userInfo && userPhoto && userEmail) {
        userPhoto.src = user.photoURL || 'https://via.placeholder.com/40/2c3e50/ffffff?text=👤';
        userPhoto.alt = user.displayName || user.email;
        userEmail.textContent = user.email;
        userInfo.style.display = 'flex';
    }
}

function updateProfileInfo(user) {
    // Profile photo
    const profilePhoto = document.getElementById('profile-photo');
    if (profilePhoto) {
        profilePhoto.src = user.photoURL || 'https://via.placeholder.com/80/2c3e50/ffffff?text=👤';
        profilePhoto.alt = user.displayName || user.email;
    }
    
    // Profile details
    const profileEmail = document.getElementById('profile-email');
    const profileName = document.getElementById('profile-name');
    const profileCreated = document.getElementById('profile-created');
    const profileLastSignin = document.getElementById('profile-last-signin');
    
    if (profileEmail) profileEmail.textContent = user.email;
    if (profileName) profileName.textContent = user.displayName || 'Not set';
    if (profileCreated) profileCreated.textContent = formatDate(user.metadata.creationTime);
    if (profileLastSignin) profileLastSignin.textContent = formatDate(user.metadata.lastSignInTime);
}

async function loadSubscriptionStatus() {
    console.log('Loading subscription status from Firebase Auth custom claims...');
    
    try {
        if (!currentUser) {
            throw new Error('No authenticated user');
        }
        
        // Get subscription data from Firebase Auth custom claims
        const tokenResult = await currentUser.getIdTokenResult(true); // Force refresh
        const customClaims = tokenResult.claims;
        
        userSubscriptionData = {
            plan: customClaims.plan || 'free',
            subscriptionStatus: customClaims.subscriptionStatus || null,
            subscriptionId: customClaims.subscriptionId || null,
            upgradedAt: customClaims.upgradedAt || null,
            canceledAt: customClaims.canceledAt || null
        };
        
        console.log('Subscription data from custom claims:', userSubscriptionData);
        updateSubscriptionUI(userSubscriptionData);
        
    } catch (error) {
        console.error('Error loading subscription status:', error);
        
        // Show default free plan
        userSubscriptionData = {
            plan: 'free',
            subscriptionStatus: null,
            subscriptionId: null,
            upgradedAt: null,
            canceledAt: null
        };
        updateSubscriptionUI(userSubscriptionData);
    }
}

function updateSubscriptionUI(data) {
    const planStatus = document.getElementById('plan-status');
    const subscriptionStatus = document.getElementById('subscription-status');
    const upgradeDate = document.getElementById('upgrade-date');
    const nextBilling = document.getElementById('next-billing');
    const upgradeDateItem = document.getElementById('upgrade-date-item');
    const nextBillingItem = document.getElementById('next-billing-item');
    const freeFeatures = document.getElementById('free-features');
    const proFeatures = document.getElementById('pro-features');
    const cancelSubscriptionBtn = document.getElementById('cancel-subscription-btn');

    if (cancelSubscriptionBtn) {
        if (data.subscriptionStatus === 'canceled' || 
            data.subscriptionStatus === 'cancel_at_period_end' || 
            data.plan === 'free') {
            cancelSubscriptionBtn.disabled = true;
            cancelSubscriptionBtn.classList.add('disabled');
            cancelSubscriptionBtn.setAttribute('title', 'Subscription already canceled or not active');
        } else {
            cancelSubscriptionBtn.disabled = false;
            cancelSubscriptionBtn.classList.remove('disabled');
            cancelSubscriptionBtn.removeAttribute('title');
        }
    }
    
    // Update plan status badge
    if (planStatus) {
        planStatus.textContent = data.plan === 'pro' ? 'Pro' : 'Free';
        planStatus.className = 'status-badge ' + (data.plan === 'pro' ? 'status-pro' : 'status-free');
    }
    
    // Update subscription status
    if (subscriptionStatus) {
        if (data.plan === 'free') {
            subscriptionStatus.textContent = 'Free Plan';
        } else if (data.subscriptionStatus === 'active') {
            subscriptionStatus.textContent = 'Active';
        } else if (data.subscriptionStatus === 'canceled') {
            subscriptionStatus.textContent = 'Canceled';
        } else {
            subscriptionStatus.textContent = data.subscriptionStatus || 'Unknown';
        }
    }
    
    // Show/hide date information for pro users
    if (data.plan === 'pro' && data.upgradedAt) {
        if (upgradeDate) upgradeDate.textContent = formatDate(data.upgradedAt);
        if (upgradeDateItem) upgradeDateItem.style.display = 'flex';
        
        // Show next billing (placeholder - in real app, would fetch from Stripe)
        if (nextBilling) nextBilling.textContent = 'Contact support for billing info';
        if (nextBillingItem) nextBillingItem.style.display = 'flex';
    } else {
        if (upgradeDateItem) upgradeDateItem.style.display = 'none';
        if (nextBillingItem) nextBillingItem.style.display = 'none';
    }
    
    // Show appropriate features section
    if (data.plan === 'pro') {
        if (freeFeatures) freeFeatures.classList.add('hidden');
        if (proFeatures) proFeatures.classList.remove('hidden');
    } else {
        if (freeFeatures) freeFeatures.classList.remove('hidden');
        if (proFeatures) proFeatures.classList.add('hidden');
    }
}

async function updateUsageStats() {
    try {
        if (!functions) {
            console.log('Firebase functions not available, using placeholder stats');
            updateUsageStatsUI({
                searchesThisMonth: 'Unlimited',
                videosGenerated: userSubscriptionData?.plan === 'pro' ? '0 this month' : 'Pro feature',
                totalSearches: '-',
                accountCreated: currentUser?.metadata?.creationTime
            });
            return;
        }
        
        const getUserUsage = functions.httpsCallable('getUserUsageStats');
        const result = await getUserUsage();
        
        if (result.data) {
            const stats = result.data;
            updateUsageStatsUI({
                searchesThisMonth: stats.searchesThisMonth || 0,
                videosGenerated: userSubscriptionData?.plan === 'pro' 
                    ? `${stats.videosGenerated || 0} this month` 
                    : 'Pro feature',
                totalSearches: stats.totalSearches || 0,
                accountCreated: stats.accountCreated
            });
        }
        
    } catch (error) {
        console.error('Error loading usage statistics:', error);
        // Use fallback stats
        updateUsageStatsUI({
            searchesThisMonth: 'Unlimited',
            videosGenerated: userSubscriptionData?.plan === 'pro' ? '0 this month' : 'Pro feature',
            totalSearches: '-',
            accountCreated: currentUser?.metadata?.creationTime
        });
    }
}

function updateUsageStatsUI(stats) {
    const searchesCount = document.getElementById('searches-count');
    const videosGenerated = document.getElementById('videos-generated');
    
    if (searchesCount) {
        searchesCount.textContent = stats.searchesThisMonth === 0 ? 'Unlimited' : stats.searchesThisMonth;
    }
    
    if (videosGenerated) {
        videosGenerated.textContent = stats.videosGenerated;
    }
}

async function initiateUpgrade() {
    console.log('Initiating upgrade to Pro...');
    
    const upgradeBtn = document.getElementById('upgrade-btn');
    
    try {
        // Show loading state
        if (upgradeBtn) {
            upgradeBtn.disabled = true;
            upgradeBtn.innerHTML = '<div class="loading-spinner"></div> Processing...';
        }
        
        if (!functions) {
            throw new Error('Firebase functions not initialized');
        }
        
        const createCheckout = functions.httpsCallable('createCheckoutSessionAuth');
        const result = await createCheckout();
        
        if (result.data && result.data.sessionId) {
            // Redirect to Stripe Checkout
            if (stripe) {
                await stripe.redirectToCheckout({
                    sessionId: result.data.sessionId
                });
            } else {
                throw new Error('Stripe not initialized');
            }
        } else {
            throw new Error('Failed to create checkout session');
        }
        
    } catch (error) {
        console.error('Upgrade error:', error);
        
        // Reset button state
        if (upgradeBtn) {
            upgradeBtn.disabled = false;
            upgradeBtn.innerHTML = '🚀 UPGRADE TO PRO';
        }
        
        if (error.code === 'failed-precondition') {
            showError('You are already a Pro subscriber!');
        } else if (error.code === 'unauthenticated') {
            showError('Please sign in to upgrade to Pro.');
        } else {
            showError('Failed to initiate upgrade. Please try again.');
        }
    }
}

async function openStripeCustomerPortal() {
    console.log('Opening Stripe Customer Portal...');
    
    const manageBtn = document.getElementById('manage-subscription-btn');
    
    try {
        // Show loading state
        if (manageBtn) {
            manageBtn.disabled = true;
            manageBtn.innerHTML = '<div class="loading-spinner"></div> Loading...';
        }
        
        if (!functions) {
            throw new Error('Firebase functions not initialized');
        }
        
        const createPortalSession = functions.httpsCallable('createCustomerPortalSession');
        const result = await createPortalSession();
        
        if (result.data && result.data.success && result.data.url) {
            // Redirect to Stripe Customer Portal
            window.location.href = result.data.url;
        } else {
            throw new Error('Failed to create customer portal session');
        }
        
    } catch (error) {
        console.error('Error opening customer portal:', error);
        
        // Reset button state
        if (manageBtn) {
            manageBtn.disabled = false;
            manageBtn.innerHTML = 'Manage Billing';
        }
        
        if (error.code === 'not-found') {
            showError('No subscription found. Please contact support if you believe this is an error.');
        } else if (error.code === 'unauthenticated') {
            showError('Please sign in to access billing management.');
        } else {
            showError('Failed to open billing management. Please contact support.');
        }
    }
}

function showCancelModal() {
    const cancelModal = document.getElementById('cancel-modal');
    if (cancelModal) {
        cancelModal.classList.add('show');
    }
}

function hideCancelModal() {
    const cancelModal = document.getElementById('cancel-modal');
    if (cancelModal) {
        cancelModal.classList.remove('show');
    }
}

async function confirmCancelSubscription() {
    console.log('Confirming subscription cancellation...');
    
    const confirmBtn = document.getElementById('confirm-cancel');
    const spinner = confirmBtn ? confirmBtn.querySelector('.loading-spinner') : null;
    
    try {
        // Show loading state
        if (confirmBtn) {
            confirmBtn.disabled = true;
            if (spinner) spinner.classList.remove('hidden');
        }
        
        if (!functions) {
            throw new Error('Firebase functions not initialized');
        }
        
        const cancelSubscription = functions.httpsCallable('cancelSubscription');
        const result = await cancelSubscription();
        
        if (result.data && result.data.success) {
            hideCancelModal();
            showSuccess('Subscription canceled successfully. You will continue to have Pro access until the end of your billing period.');
            
            // Reload subscription status
            await loadSubscriptionStatus();
        } else {
            throw new Error(result.data?.message || 'Failed to cancel subscription');
        }
        
    } catch (error) {
        console.error('Cancel subscription error:', error);
        
        if (error.code === 'not-found') {
            showError('No active subscription found to cancel.');
        } else if (error.code === 'failed-precondition') {
            showError('Subscription is already canceled.');
        } else if (error.code === 'unauthenticated') {
            showError('Please sign in to cancel your subscription.');
        } else {
            showError('Failed to cancel subscription. Please contact support.');
        }
    } finally {
        // Reset button state
        if (confirmBtn) {
            confirmBtn.disabled = false;
            if (spinner) spinner.classList.add('hidden');
        }
    }
}

// Listen for custom claims changes (when user upgrades/cancels)
function setupClaimsWatcher() {
    if (!currentUser) return;
    
    // Check for claims changes every 30 seconds
    const claimsWatcher = setInterval(async () => {
        try {
            const tokenResult = await currentUser.getIdTokenResult(true);
            const newClaims = tokenResult.claims;
            
            // Check if subscription status changed
            if (userSubscriptionData && 
                (newClaims.plan !== userSubscriptionData.plan || 
                 newClaims.subscriptionStatus !== userSubscriptionData.subscriptionStatus)) {
                
                console.log('Subscription status changed, refreshing UI');
                await loadSubscriptionStatus();
                showSuccess('Your subscription status has been updated!');
            }
        } catch (error) {
            console.error('Error checking for claims changes:', error);
        }
    }, 30000); // Check every 30 seconds
    
    // Clean up interval when user leaves the page
    window.addEventListener('beforeunload', () => {
        clearInterval(claimsWatcher);
    });
}

// UI Helper Functions
function hideLoading() {
    const loadingSection = document.getElementById('loading-section');
    if (loadingSection) {
        loadingSection.classList.add('hidden');
    }
}

function showAccountContent() {
    const accountContent = document.getElementById('account-content');
    if (accountContent) {
        accountContent.classList.remove('hidden');
    }
}

function showAuthRequired() {
    hideLoading();
    const authRequired = document.getElementById('auth-required');
    if (authRequired) {
        authRequired.classList.remove('hidden');
    }
}

function showAlert(message, type) {
    const alertContainer = document.getElementById('alert-container');
    if (!alertContainer) return;
    
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    alertContainer.appendChild(alertDiv);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertDiv.parentNode.removeChild(alertDiv);
        }
    }, 5000);
}

function showSuccess(message) {
    showAlert(message, 'success');
}

function showError(message) {
    showAlert(message, 'error');
}

function showWarning(message) {
    showAlert(message, 'warning');
}

function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    } catch (error) {
        console.error('Date formatting error:', error);
        return 'Invalid date';
    }
}

// Expose functions to global scope for debugging
window.loadSubscriptionStatus = loadSubscriptionStatus;
window.initiateUpgrade = initiateUpgrade;
window.showCancelModal = showCancelModal;
window.refreshUserClaims = async function() {
    if (currentUser) {
        await loadSubscriptionStatus(); // This will refresh custom claims
        console.log('User claims refreshed from account page');
    }
};

setupClaimsWatcher();
