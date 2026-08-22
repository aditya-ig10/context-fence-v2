import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithCredential,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  type User,
  type Auth,
} from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';
import { getFirestore, doc, setDoc, getDoc, serverTimestamp, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCKwS1a6favNdvLzdJrrhxsAZtZ69i_Y3I",
  authDomain: "context-fence.firebaseapp.com",
  projectId: "context-fence",
  storageBucket: "context-fence.firebasestorage.app",
  messagingSenderId: "751149542813",
  appId: "1:751149542813:web:492dfd8d35d404f39c5374",
  measurementId: "G-YR78L412H1"
};

const hasFirebaseConfig = true;

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (hasFirebaseConfig) {
  app = initializeApp(firebaseConfig);
  getAnalytics(app);
  auth = getAuth(app);
  db = getFirestore(app);
}

export const googleProvider = hasFirebaseConfig ? new GoogleAuthProvider() : null;
if (googleProvider) googleProvider.setCustomParameters({ prompt: 'select_account' });

export const appleProvider = hasFirebaseConfig ? new OAuthProvider('apple.com') : null;
if (appleProvider) appleProvider.addScope('email');
if (appleProvider) appleProvider.addScope('name');

export async function loginWithGoogle() {
  if (!auth || !googleProvider) throw new Error('Firebase not configured');
  await signInWithPopup(auth, googleProvider);
}

export async function loginWithApple() {
  if (!auth || !appleProvider) throw new Error('Firebase not configured');
  await signInWithPopup(auth, appleProvider);
}

export async function loginWithEmail(email: string, password: string) {
  if (!auth) throw new Error('Firebase not configured');
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function registerWithEmail(email: string, password: string) {
  if (!auth) throw new Error('Firebase not configured');
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function loginWithGoogleSystem() {
  if (!auth) throw new Error('Firebase not configured');
  if (!window.electronAuth) throw new Error('electronAuth not available');
  const result = await window.electronAuth.startOAuth('google');
  if (!result.success || !result.oauthIdToken) {
    throw new Error(result.error || 'Google sign-in failed');
  }
  const credential = GoogleAuthProvider.credential(result.oauthIdToken, result.oauthAccessToken);
  const { user } = await signInWithCredential(auth, credential);
  return user;
}

export async function loginWithAppleSystem() {
  if (!auth) throw new Error('Firebase not configured');
  if (!window.electronAuth) throw new Error('electronAuth not available');
  const result = await window.electronAuth.startOAuth('apple');
  if (!result.success || !result.oauthIdToken) {
    throw new Error(result.error || 'Apple sign-in failed');
  }
  const cred = appleProvider!.credential({
    idToken: result.oauthIdToken,
    accessToken: result.oauthAccessToken,
  });
  const { user } = await signInWithCredential(auth, cred);
  return user;
}

export async function logout() {
  if (auth) await signOut(auth);
}

export async function resetPassword(email: string) {
  if (!auth) throw new Error('Firebase not configured');
  await sendPasswordResetEmail(auth, email);
}

export interface UserProfile {
  firstName: string;
  lastName: string;
  email: string;
  photoURL: string;
  phoneDial: string;
  phoneNumber: string;
  company: string;
  fieldOfWork: string;
  hearAbout: string;
}

export async function fetchUserProfile(uid: string): Promise<UserProfile | null> {
  if (!db) return null;
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    firstName: d.firstName || '',
    lastName: d.lastName || '',
    email: d.email || '',
    photoURL: d.photoURL || '',
    phoneDial: d.phoneDial || '',
    phoneNumber: d.phoneNumber || '',
    company: d.company || '',
    fieldOfWork: d.fieldOfWork || '',
    hearAbout: d.hearAbout || '',
  };
}

export async function saveUserProfile(uid: string, profile: Partial<UserProfile>) {
  if (!db) throw new Error('Firebase not configured');
  await setDoc(doc(db, 'users', uid), {
    ...profile,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function saveGoogleUserProfile(user: User) {
  if (!db) return;
  const nameParts = (user.displayName || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  await setDoc(doc(db, 'users', user.uid), {
    firstName,
    lastName,
    email: user.email || '',
    photoURL: user.photoURL || '',
    phoneDial: '',
    phoneNumber: '',
    company: '',
    fieldOfWork: '',
    hearAbout: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export function getFirebaseErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/email-already-in-use': 'An account already exists with this email.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/requires-recent-login': 'Please sign in again to continue.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

export { auth, db, hasFirebaseConfig };
