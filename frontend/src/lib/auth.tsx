import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { onAuthStateChanged, getRedirectResult, type User } from 'firebase/auth';
import { auth, saveGoogleUserProfile, hasFirebaseConfig } from './firebase';

const SESSION_KEY = 'cf_has_session';
const MOCK_USER_KEY = 'cf_mock_user';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  freshSignIn: boolean;
  signingOut: boolean;
  // signingIn: true while the OAuth browser window is open. LoginPage uses
  // this to keep the loading spinner alive throughout the flow so the button
  // never resets mid-auth and the UX clearly shows "waiting for browser".
  signingIn: boolean;
  setSigningIn: (v: boolean) => void;
  mockSignIn: () => void;
  mockSignOut: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  freshSignIn: false,
  signingOut: false,
  signingIn: false,
  setSigningIn: () => {},
  mockSignIn: () => {},
  mockSignOut: () => {},
});

function createMockUser(): User {
  return {
    uid: 'dev-user-001',
    email: 'dev@context-fence.local',
    displayName: 'Dev User',
    photoURL: '',
    emailVerified: true,
    isAnonymous: false,
    metadata: {},
    providerData: [],
    refreshToken: '',
    tenantId: null,
    delete: async () => {},
    getIdToken: async () => 'mock-token',
    getIdTokenResult: async () => ({ token: 'mock-token', signInProvider: null, expirationTime: '', issuedAtTime: '', authTime: '', claims: {} }),
    reload: async () => {},
    toJSON: () => ({}),
    providerId: '',
  } as unknown as User;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    if (!hasFirebaseConfig && localStorage.getItem(MOCK_USER_KEY)) {
      return createMockUser();
    }
    return null;
  });
  const [loading, setLoading] = useState(true);
  const [freshSignIn, setFreshSignIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const prevUserRef = useRef<User | null>(null);
  const profileSavedRef = useRef(false);

  function mockSignIn() {
    localStorage.setItem(MOCK_USER_KEY, 'true');
    localStorage.setItem(SESSION_KEY, 'true');
    setUser(createMockUser());
    setFreshSignIn(true);
    setTimeout(() => setFreshSignIn(false), 800);
  }

  function mockSignOut() {
    localStorage.removeItem(MOCK_USER_KEY);
    localStorage.removeItem(SESSION_KEY);
    setSigningOut(true);
    setTimeout(() => setSigningOut(false), 400);
    setUser(null);
  }

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }

    // Clean up stale mock data on first Firebase init
    localStorage.removeItem(MOCK_USER_KEY);

    let resolved = false;

    getRedirectResult(auth).then((result) => {
      if (result?.user) {
        resolved = true;
        localStorage.setItem(SESSION_KEY, 'true');
        if (!prevUserRef.current) {
          setFreshSignIn(true);
          setTimeout(() => setFreshSignIn(false), 800);
        }
        profileSavedRef.current = true;
        saveGoogleUserProfile(result.user).catch(() => {});
      }
    }).catch(() => {});

    // Do NOT use a fallback timer here. Firebase always fires onAuthStateChanged
    // within ~1s on startup. A 5-second fallback timer caused a race condition:
    // if the timer fired before Firebase resolved a stored session, the LoginPage
    // would show. Then when the user clicked "Continue with Google", Firebase's
    // stored session resolved at that moment — making it look like Google auth
    // completed instantly when it actually used a pre-existing session.
    const unsub = onAuthStateChanged(auth, (u) => {
      const hadSession = localStorage.getItem(SESSION_KEY) === 'true';

      if (u) {
        setSigningOut(false);
        setSigningIn(false); // OAuth complete — clear the in-progress flag
        if (!hadSession) {
          localStorage.setItem(SESSION_KEY, 'true');
          if (prevUserRef.current === null && !resolved) {
            setFreshSignIn(true);
            setTimeout(() => setFreshSignIn(false), 800);
          }
        }
        if (!profileSavedRef.current && u.displayName) {
          profileSavedRef.current = true;
          saveGoogleUserProfile(u).catch(() => {});
        }
      } else {
        if (prevUserRef.current) {
          setSigningOut(true);
          setTimeout(() => setSigningOut(false), 400);
          localStorage.removeItem('cf_onboarding_seen');
        }
        localStorage.removeItem(SESSION_KEY);
        profileSavedRef.current = false;
      }

      prevUserRef.current = u;
      setUser(u);
      setLoading(false);
    });

    return () => unsub();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, freshSignIn, signingOut, signingIn, setSigningIn, mockSignIn, mockSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// v2 simplified auth without mockData
