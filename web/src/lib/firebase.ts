import { initializeApp } from 'firebase/app'
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence
} from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { getMessaging, getToken, isSupported } from 'firebase/messaging'
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean)

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null

// App Check — attests that calls come from OUR app, not a script replaying the
// (public, by design) Firebase config. This is what protects the shared Gemini
// quota and the Cloud Run bill from scripted abuse.
//
// Setup: Firebase console → App Check → register the web app with reCAPTCHA v3,
// then put the site key in web/.env as VITE_RECAPTCHA_SITE_KEY. Until that
// exists we simply don't attest (the backend runs in monitor mode, so nothing
// breaks); once it does, set APP_CHECK_ENFORCED=true in functions/.env.
if (app) {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY
  if (siteKey) {
    if (import.meta.env.DEV && import.meta.env.VITE_APPCHECK_DEBUG_TOKEN) {
      // Lets a dev machine pass enforcement (token registered in the console)
      ;(self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
        import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
    }
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(siteKey),
        isTokenAutoRefreshEnabled: true,
      })
    } catch (error) {
      console.error('App Check init failed:', error)
    }
  }
}

export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null

// Configure Auth Persistence (Keep users logged in after page refresh)
if (auth) {
  setPersistence(auth, browserLocalPersistence).catch((error) => {
    console.error('Failed to enable auth persistence:', error)
  })
}

export const firebaseFunctions = app
  ? getFunctions(app, import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'asia-south1')
  : null

const provider = new GoogleAuthProvider()

if (import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  try {
    if (firebaseFunctions) connectFunctionsEmulator(firebaseFunctions, '127.0.0.1', 5001)
    if (db) connectFirestoreEmulator(db, '127.0.0.1', 8080)
    if (auth) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  } catch (error) {
    console.error('Failed to connect to emulators:', error)
  }
}

export async function signInWithGoogle() {
  if (!auth) throw new Error('Firebase auth is not configured.')
  return signInWithPopup(auth, provider)
}

export async function signOutUser() {
  if (!auth) throw new Error('Firebase auth is not configured.')
  return signOut(auth)
}

// Emulator testing: Email/Password authentication
export async function signInWithEmail(email: string, password: string) {
  if (!auth) throw new Error('Firebase auth is not configured.')
  return signInWithEmailAndPassword(auth, email, password)
}

export async function signUpWithEmail(email: string, password: string) {
  if (!auth) throw new Error('Firebase auth is not configured.')
  return createUserWithEmailAndPassword(auth, email, password)
}

export async function requestPushToken() {
  if (!app) throw new Error('Firebase app is not configured.')

  const supported = await isSupported()
  if (!supported) return null

  const messaging = getMessaging(app)
  return getToken(messaging, {
    vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: await navigator.serviceWorker.getRegistration(),
  })
}