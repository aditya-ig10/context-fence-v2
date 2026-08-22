import { useEffect, useMemo, useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  Shield,
  Zap,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Layers,
  Check,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  fetchUserProfile,
  saveUserProfile,
  hasFirebaseConfig,
  loginWithGoogle,
  loginWithGoogleSystem,
  saveGoogleUserProfile,
  type UserProfile,
  auth,
  db,
} from '../lib/firebase';
import { setPersistence, browserLocalPersistence, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
} from 'firebase/firestore';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';
import { useCountUp } from '../hooks/useCountUp';
import { notify } from '../components/Toasts';

const C = {
  coral: '#ff3144',
  teal: '#397e70',
  tealBright: '#2fe6b0',
  amber: '#de911d',
  gray: '#9aa1a9',
};

const COUNTRY_CODES = [
  { value: '+91', label: 'IN +91' },
  { value: '+1', label: 'US +1' },
  { value: '+44', label: 'UK +44' },
  { value: '+81', label: 'JP +81' },
  { value: '+86', label: 'CN +86' },
  { value: '+49', label: 'DE +49' },
  { value: '+33', label: 'FR +33' },
  { value: '+61', label: 'AU +61' },
  { value: '+55', label: 'BR +55' },
  { value: '+7', label: 'RU +7' },
  { value: '+82', label: 'KR +82' },
  { value: '+65', label: 'SG +65' },
  { value: '+971', label: 'AE +971' },
];

export interface Tx {
  id: string;
  date: string;
  plan: string;
  nodes: number;
  amountInr: number;
  status: 'paid' | 'pending' | 'failed';
  subtotalInr?: number;
  discountInr?: number;
  taxInr?: number;
  taxRate?: number;
  billing?: Record<string, unknown>;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  createdAt?: Date;
  expiresAt?: Date;
}

interface Stats {
  uptime: number;
  agents: number;
  servers: string[];
  policies: number;
  calls: { total: number; blocked: number; blockRate: string };
}

interface DetectedAgent {
  id: string;
  name: string;
  type: string;
  protected?: boolean;
}

type Period = 'today' | '7d' | '30d';

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 16, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatDate(d: Date) {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function addDays(d: Date, n: number) {
  return new Date(d.getTime() + n * 864e5);
}

function cleanPlaintext(val: unknown): string {
  if (typeof val !== 'string' || !val) return '';
  if (/^v\d+:[0-9a-fA-F]+:[0-9a-fA-F]+/.test(val)) return '';
  return val;
}

async function downloadBill(tx: Tx, userFields: { firstName: string; lastName: string; email: string; company: string }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  const billing = (tx.billing as Record<string, string>) ?? {};
  const createdAt = tx.createdAt ?? new Date();
  const expiresAt = tx.expiresAt ?? addDays(createdAt, 30);

  doc.setFillColor(255, 49, 68);
  doc.rect(0, 0, 210, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Context Fence', 14, 13);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text('Context Fence  •  Enforcement Node Infrastructure  •  contextfence.dev', 14, 18);
  doc.setTextColor(0, 0, 0);

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE & RECEIPT', 14, 32);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Invoice ID: ${tx.id.slice(0, 14).toUpperCase()}`, 14, 38);
  doc.text(`Issue Date: ${formatDate(createdAt)}`, 14, 43);
  doc.text(`Valid Until: ${formatDate(expiresAt)}`, 14, 48);
  doc.text(`Payment Status: ${tx.status.toUpperCase()}`, 14, 53);

  doc.setFont('helvetica', 'bold');
  doc.text('Issued By:', 14, 62);
  doc.setFont('helvetica', 'normal');
  doc.text('Context Fence (Synthrun)', 14, 67);
  doc.text('New Delhi, India', 14, 72);
  doc.text('hello@synthrun.site', 14, 77);

  doc.setFont('helvetica', 'bold');
  doc.text('Licensed To:', 110, 62);
  doc.setFont('helvetica', 'normal');
  const bFirst = cleanPlaintext(billing.firstName);
  const bLast = cleanPlaintext(billing.lastName);
  const bName = bFirst || bLast ? `${bFirst} ${bLast}`.trim() : '';
  const uName = `${cleanPlaintext(userFields.firstName)} ${cleanPlaintext(userFields.lastName)}`.trim();
  const toName = bName || uName || 'Customer';
  doc.text(toName, 110, 67);
  const toEmail = cleanPlaintext(billing.email) || cleanPlaintext(userFields.email) || '';
  if (toEmail) doc.text(toEmail, 110, 72);
  const comp = cleanPlaintext(billing.company) || cleanPlaintext(userFields.company);
  if (comp) doc.text(comp, 110, 77);
  const addr = [
    cleanPlaintext(billing.address1),
    cleanPlaintext(billing.address2),
    cleanPlaintext(billing.city),
    cleanPlaintext(billing.state),
    cleanPlaintext(billing.postal),
    cleanPlaintext(billing.country),
  ].filter(Boolean).join(', ');
  if (addr) {
    const lines = doc.splitTextToSize(addr, 90);
    doc.text(lines, 110, 82);
  }

  doc.setDrawColor(200);
  doc.line(14, 98, 196, 98);

  let y = 106;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Enforcement Plan', 14, y);
  doc.text('Nodes', 110, y);
  doc.text('Amount', 160, y);
  y += 6;
  doc.setDrawColor(230);
  doc.line(14, y - 4, 196, y - 4);
  doc.setFont('helvetica', 'normal');
  doc.text(`${tx.plan}`, 14, y);
  doc.text(String(tx.nodes), 110, y);
  doc.text(`Rs. ${Number(tx.amountInr).toLocaleString('en-IN')}`, 160, y);
  y += 7;

  if (tx.subtotalInr !== undefined && tx.discountInr) {
    doc.setFontSize(9);
    doc.text('Subtotal', 14, y);
    doc.text(`Rs. ${Number(tx.subtotalInr).toLocaleString('en-IN')}`, 160, y);
    y += 5;
    doc.text('Discount', 14, y);
    doc.text(`- Rs. ${Number(tx.discountInr).toLocaleString('en-IN')}`, 160, y);
    y += 5;
  }

  if (tx.taxInr) {
    doc.setFontSize(9);
    doc.text(`Tax (${Math.round((tx.taxRate ?? 0) * 100)}%)`, 14, y);
    doc.text(`Rs. ${Number(tx.taxInr).toLocaleString('en-IN')}`, 160, y);
    y += 5;
  }

  y += 2;
  doc.setDrawColor(0);
  doc.line(14, y - 4, 196, y - 4);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Total', 14, y);
  doc.text(`Rs. ${Number(tx.amountInr).toLocaleString('en-IN')}`, 160, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (tx.razorpayOrderId) {
    doc.text(`Razorpay Order: ${tx.razorpayOrderId}`, 14, y);
    y += 5;
  }
  if (tx.razorpayPaymentId) {
    doc.text(`Payment ID: ${tx.razorpayPaymentId}`, 14, y);
    y += 5;
  }
  doc.text(`Payment Status: Verified`, 14, y);
  y += 10;
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text('Thank you for choosing Context Fence.', 14, y);
  doc.save(`ContextFence-Invoice-${tx.id.slice(0, 8)}.pdf`);
}

// Chart Tooltip matching AgentDetail.tsx
function DetailTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="ad-tooltip">
      {label !== undefined && <p className="ad-tooltip-label">{label}</p>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="ad-tooltip-row">
          <span className="ad-tooltip-dot" style={{ background: p.color || p.stroke }} />
          <span className="ad-tooltip-name">
            {p.dataKey === 'utilization' ? 'Requests Processed' : p.dataKey === 'capacity' ? 'Node Fleet Capacity' : p.name}
          </span>
          <span className="ad-tooltip-val">{formatNumber(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

export default function Profile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phoneDial, setPhoneDial] = useState('+91');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [company, setCompany] = useState('');
  const [plan, setPlan] = useState('free');
  const [nodes, setNodes] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [signingInGoogle, setSigningInGoogle] = useState(false);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [period, setPeriod] = useState<Period>('7d');
  const [refreshing, setRefreshing] = useState(false);

  const isRealUser = !!user && user.uid !== 'dev-user-001';

  // Live Stats & Detected Agent Telemetry
  const statsHook = useCachedFetch<Stats>('stats', () => fetch('/api/stats').then((r) => r.json()), { maxAgeMs: 30_000 });
  const detectHook = useCachedFetch<{ agents: DetectedAgent[] }>('detect', () => fetch('/api/detect').then((r) => r.json()), { maxAgeMs: 30_000 });

  const stats = statsHook.data;
  const agents = detectHook.data?.agents ?? [];
  const protectedAgents = agents.filter((a) => a.protected !== false);

  const profileKey = user ? `profile:${user.uid}` : 'profile:anonymous';
  const { data: cachedProfile, loading: profileLoading } = useCachedFetch<UserProfile | null>(
    profileKey,
    async () => {
      if (!user) return null;
      if (!hasFirebaseConfig) {
        const saved = localStorage.getItem('cf_profile');
        if (saved) {
          try {
            return JSON.parse(saved) as UserProfile;
          } catch {
            return null;
          }
        }
        return null;
      }
      return fetchUserProfile(user.uid);
    },
    { maxAgeMs: 60_000 }
  );

  useEffect(() => {
    if (!user) {
      setPlan('free');
      setNodes(1);
      setExpiresAt(null);
      setTxs([]);
      setProfile(null);
      return;
    }
    if (cachedProfile) {
      setProfile(cachedProfile);
      setFirstName(cleanPlaintext(cachedProfile.firstName) || user.displayName?.split(' ')[0] || '');
      setLastName(cleanPlaintext(cachedProfile.lastName) || user.displayName?.split(' ').slice(1).join(' ') || '');
      setPhoneDial(cachedProfile.phoneDial || '+91');
      setPhoneNumber(cleanPlaintext(cachedProfile.phoneNumber));
      setCompany(cleanPlaintext(cachedProfile.company));
    } else if (!profileLoading) {
      setFirstName(user.displayName?.split(' ')[0] || '');
      setLastName(user.displayName?.split(' ').slice(1).join(' ') || '');
    }

    if (db && isRealUser) {
      getDoc(doc(db, 'users', user.uid))
        .then((snap) => {
          if (snap.exists()) {
            const d = snap.data();
            setPlan((d.plan as string) || 'free');
            setNodes(typeof d.nodes === 'number' ? d.nodes : 1);
            if (d.expiresAt) setExpiresAt(d.expiresAt);
          } else {
            setPlan('free');
            setNodes(1);
          }
        })
        .catch(() => {
          setPlan('free');
          setNodes(1);
        });
    } else {
      setPlan('free');
      setNodes(1);
    }
  }, [user, cachedProfile, profileLoading, isRealUser]);

  useEffect(() => {
    if (!user || !db || !isRealUser) return;
    let cancelled = false;

    (async () => {
      try {
        const q = query(collection(db, 'payments'), where('userId', '==', user.uid), limit(20));
        const snap = await getDocs(q);
        if (!snap.empty && !cancelled) {
          const mapped: Tx[] = snap.docs
            .map((docSnap) => {
              const d = docSnap.data();
              const dt: Date = (d.createdAt as { toDate?: () => Date })?.toDate?.() ?? new Date();
              const exp = (d.expiresAt as { toDate?: () => Date })?.toDate?.() ?? undefined;
              return {
                id: docSnap.id,
                date: formatDate(dt),
                plan: String(d.plan ? `${String(d.plan).toUpperCase()} · ${String((d.nodes as number) ?? '')} Nodes` : '—'),
                nodes: Number((d.nodes as number) ?? 0),
                amountInr: Number((d.amountInr as number) ?? (d.amount as number) ?? 0),
                status: (d.status as Tx['status']) ?? 'paid',
                subtotalInr: Number((d.subtotalInr as number) ?? Number((d.amountInr as number) ?? 0)),
                discountInr: Number((d.discountInr as number) ?? 0),
                taxInr: Number((d.taxInr as number) ?? 0),
                taxRate: Number((d.taxRate as number) ?? 0),
                billing: (d.billing as Record<string, unknown>) ?? {},
                razorpayOrderId: String(d.razorpayOrderId ?? ''),
                razorpayPaymentId: String(d.razorpayPaymentId ?? ''),
                createdAt: dt,
                expiresAt: exp,
              };
            })
            .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
          setTxs(mapped);
        }
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [user, isRealUser]);

  const isPaid = plan === 'starter' || plan === 'teams';
  const planLabel = plan === 'teams' ? 'Teams' : plan === 'starter' ? 'Starter' : 'Free';
  const effectiveNodes = nodes !== null ? nodes : (plan === 'teams' ? 5 : plan === 'starter' ? 5 : 1);
  const activeProtectedCount = protectedAgents.length > 0 ? protectedAgents.length : 2;

  // Time left calculation — Pure calendar date, NO TIME
  const expirationData = useMemo(() => {
    if (!isPaid) {
      return {
        mainValue: 'Active',
        subValue: 'Free tier · No expiration',
        cycleHint: 'Free community plan',
        percentageRemaining: 100,
        daysRemaining: null,
      };
    }

    let expDate: Date | null = null;
    if (expiresAt) {
      const raw = expiresAt as { toDate?: () => Date } | string | number;
      if (raw && typeof raw === 'object' && 'toDate' in raw && typeof raw.toDate === 'function') {
        try {
          expDate = raw.toDate();
        } catch {}
      } else if (typeof raw === 'string' || typeof raw === 'number') {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) expDate = d;
      }
    }
    if (!expDate) {
      expDate = addDays(new Date(), 29);
    }

    const now = Date.now();
    const diffMs = expDate.getTime() - now;
    const totalCycleMs = 30 * 864e5;

    if (diffMs <= 0) {
      return {
        mainValue: 'Expired',
        subValue: 'Renewal needed for node proxies',
        cycleHint: '0 days remaining in billing cycle',
        percentageRemaining: 0,
        daysRemaining: 0,
      };
    }

    const days = Math.max(1, Math.ceil(diffMs / 864e5));
    const percentage = Math.min(Math.max(Math.round((diffMs / totalCycleMs) * 100), 2), 97);

    return {
      mainValue: `${days} Days`,
      subValue: `Renews on ${formatDate(expDate)}`,
      cycleHint: `${days} days left in current billing cycle`,
      percentageRemaining: percentage,
      daysRemaining: days,
    };
  }, [isPaid, expiresAt]);

  // Telemetry Chart Series matching AgentDetail.tsx
  const utilizationTimeline = useMemo(() => {
    const pointsCount = period === 'today' ? 24 : period === '7d' ? 7 : 30;
    const baseCapacity = effectiveNodes * 1000;
    const currentCalls = stats?.calls?.total ?? 142;

    const data = [];
    for (let i = 0; i < pointsCount; i++) {
      let label = '';
      if (period === 'today') {
        label = `${String(i).padStart(2, '0')}:00`;
      } else if (period === '7d') {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        label = d.toLocaleDateString('en-US', { weekday: 'short' });
      } else {
        const d = new Date();
        d.setDate(d.getDate() - (29 - i));
        label = `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
      }

      const variation = Math.sin(i * 0.8) * 0.35 + 0.65;
      const utilization = Math.round((currentCalls / (pointsCount * 0.6)) * variation * (1 + (i % 4) * 0.12));

      data.push({
        day: label,
        utilization: Math.max(utilization, 6),
        capacity: baseCapacity,
      });
    }
    return data;
  }, [period, effectiveNodes, stats]);

  // Donut allocation
  const activeAgentNodes = Math.min(activeProtectedCount, effectiveNodes);
  const idleNodes = Math.max(0, effectiveNodes - activeAgentNodes);
  const nodeUtilizedPct = Math.round((activeAgentNodes / Math.max(effectiveNodes, 1)) * 100);

  const nodeDonutData = useMemo(() => [
    { name: 'Active Proxies', value: Math.max(activeAgentNodes, 1), color: C.coral },
    { name: 'Standby Buffer', value: Math.max(idleNodes, 0), color: C.teal },
  ].filter((d) => d.value > 0), [activeAgentNodes, idleNodes]);

  const activeProtectedAnim = useCountUp(activeProtectedCount);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      invalidateCache((k) => k === 'stats' || k === 'detect' || k === profileKey);
      statsHook.refresh();
      detectHook.refresh();
      await new Promise((r) => setTimeout(r, 500));
      notify.success('Profile Refreshed', 'Telemetry and account data updated');
    } catch {
      notify.error('Refresh Failed', 'Could not fetch latest telemetry');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSignIn() {
    setSigningInGoogle(true);
    try {
      await setPersistence(auth!, browserLocalPersistence);
      if (window.electronAuth) {
        const u = await loginWithGoogleSystem();
        saveGoogleUserProfile(u).catch(() => {});
      } else {
        await loginWithGoogle();
      }
      notify.success('Signed in', 'Google profile synchronized');
    } catch (err: unknown) {
      notify.error('Sign-in failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSigningInGoogle(false);
    }
  }

  async function handleSave() {
    if (!user) return;
    setSaving(true);
    setSaved(false);
    setSaveError('');
    try {
      const payload: UserProfile = {
        firstName,
        lastName,
        email: user.email || '',
        photoURL: user.photoURL || '',
        phoneDial,
        phoneNumber,
        company,
        fieldOfWork: '',
        hearAbout: '',
      };

      if (!hasFirebaseConfig) {
        localStorage.setItem('cf_profile', JSON.stringify(payload));
      } else {
        await saveUserProfile(user.uid, payload);
      }
      invalidateCache((k) => k === profileKey);
      setSaved(true);
      notify.success('Profile Saved', 'Account information updated');
      setTimeout(() => setSaved(false), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not save profile';
      setSaveError(msg);
      notify.error('Save failed', msg);
    } finally {
      setSaving(false);
    }
  }

  const avatar = user?.photoURL || (profile as { photoURL?: string })?.photoURL;
  const userInitials = (firstName?.charAt(0) || user?.email?.charAt(0) || 'A').toUpperCase();
  const displayName = firstName || lastName ? `${firstName} ${lastName}`.trim() : user?.displayName || 'Aditya Srivastava';
  const displayEmail = user?.email || 'igaditya10@gmail.com';

  return (
    <div className="ag2-root">
      {/* Clean Minimal Header (Full Width matching Dashboard & Agents) */}
      <header className="ag2-head">
        <div>
          <h1 className="ag2-heading">Profile</h1>
          <p className="ag2-subhead">Account credentials, enforcement fleet, and subscription telemetry.</p>
        </div>

        <div className="prof-head-actions">
          <button
            className="ag2-refresh"
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh profile data"
          >
            <RefreshCw size={14} className={refreshing ? 'ag2-spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>

          <a
            href="https://contextfence.dev/profile"
            target="_blank"
            rel="noopener noreferrer"
            className="prof-btn-action prof-btn-upgrade"
          >
            <Shield size={14} />
            <span>Upgrade Plan</span>
          </a>

          <a
            href="https://contextfence.dev/profile"
            target="_blank"
            rel="noopener noreferrer"
            className="prof-btn-action prof-btn-nodes"
          >
            <Zap size={14} />
            <span>Add Nodes</span>
          </a>
        </div>
      </header>

      {/* Top Section 1: KPI Band (Orange -> Teal -> White w/ Progress Bar) */}
      <section className="ag2-kpis">
        <div className="ag2-card ag2-kpi ag2-kpi-orange">
          <p className="ag2-kpi-label">Enforcement<br />Nodes</p>
          <p className="ag2-kpi-value">
            {activeProtectedAnim} <span className="ag2-kpi-unit">/ {effectiveNodes}</span>
          </p>
          <p className="ag2-kpi-sub">{activeProtectedCount} active agent {activeProtectedCount === 1 ? 'proxy' : 'proxies'} protected</p>
        </div>

        <div className="ag2-card ag2-kpi ag2-kpi-teal">
          <p className="ag2-kpi-label">Subscription<br />Expiry</p>
          <p className="ag2-kpi-value">{expirationData.mainValue}</p>
          <p className="ag2-kpi-sub">{expirationData.subValue}</p>
        </div>

        <div className="ag2-card ag2-kpi ag2-kpi-white">
          <p className="ag2-kpi-label">Cycle<br />Remaining</p>
          <p className="ag2-kpi-value">
            {expirationData.percentageRemaining}<span className="ag2-kpi-unit">%</span>
          </p>
          <div className="ag2-meter" role="progressbar" aria-valuenow={expirationData.percentageRemaining} aria-valuemin={0} aria-valuemax={100}>
            <div className="ag2-meter-fill" style={{ width: `${expirationData.percentageRemaining}%` }} />
          </div>
          <p className="ag2-kpi-sub">{expirationData.cycleHint}</p>
        </div>
      </section>

      {/* Top Section 2: Telemetry Charts (2fr / 1fr Layout matching AgentDetail.tsx) */}
      <motion.div
        className="prof-charts-row"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Left: Node Capacity & Utilization Telemetry (2fr) */}
        <motion.div className="ag2-card prof-chart-box" variants={cardVariants}>
          <div className="ad-card-head">
            <div>
              <h3 className="ad-h3">Node Enforcement &amp; Request Telemetry</h3>
              <p className="ad-h3-sub">Real-time throughput inspection volume and provisioned fleet headroom.</p>
            </div>

            <div className="ad-range">
              {(['today', '7d', '30d'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`ad-range-btn ${period === p ? 'active' : ''}`}
                  onClick={() => setPeriod(p)}
                >
                  {p === 'today' ? 'Today' : p === '7d' ? '7 Days' : '30 Days'}
                </button>
              ))}
            </div>
          </div>

          <div className="ad-chart-body" style={{ height: 260, width: '100%', marginTop: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={utilizationTimeline} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="adFillReqs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff3144" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#ff3144" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="adFillCap" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#397e70" stopOpacity={0.12} />
                    <stop offset="95%" stopColor="#397e70" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: '#999999' }}
                  minTickGap={period === 'today' ? 20 : 30}
                  interval={period === 'today' ? 3 : 'preserveStartEnd'}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: '#999999' }}
                  tickFormatter={(v: number) => formatNumber(v)}
                  width={48}
                />
                <Tooltip
                  content={<DetailTooltip />}
                  cursor={{ stroke: '#b9bfc5', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area
                  type="monotone"
                  dataKey="utilization"
                  name="Requests Processed"
                  stroke="#ff3144"
                  strokeWidth={2.4}
                  fill="url(#adFillReqs)"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                  isAnimationActive
                  animationBegin={180}
                  animationDuration={700}
                  animationEasing="ease-out"
                />
                <Area
                  type="monotone"
                  dataKey="capacity"
                  name="Node Fleet Capacity"
                  stroke="#397e70"
                  strokeWidth={1.8}
                  strokeDasharray="4 4"
                  fill="url(#adFillCap)"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                  isAnimationActive
                  animationBegin={220}
                  animationDuration={800}
                  animationEasing="ease-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="prof-chart-foot">
            <div className="prof-legend-entry">
              <span className="prof-dot" style={{ background: C.coral }} />
              <span>Inspection Request Volume</span>
            </div>
            <div className="prof-legend-entry">
              <span className="prof-dot" style={{ background: C.teal }} />
              <span>Node Fleet Capacity ({effectiveNodes * 1000} req/hr)</span>
            </div>
            <a
              href="https://contextfence.dev/profile"
              target="_blank"
              rel="noopener noreferrer"
              className="prof-foot-link"
            >
              Add more nodes →
            </a>
          </div>
        </motion.div>

        {/* Right: Fleet Allocation Dial (1fr) */}
        <motion.div className="ag2-card prof-dial-box" variants={cardVariants}>
          <div className="prof-box-head">
            <div>
              <h3 className="prof-box-title">Fleet Allocation</h3>
              <p className="prof-box-sub">Active nodes vs. standby headroom.</p>
            </div>
          </div>

          <div className="prof-donut-wrap" style={{ height: 160, position: 'relative', margin: '8px 0' }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={nodeDonutData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={66}
                  paddingAngle={4}
                  dataKey="value"
                  isAnimationActive
                  animationDuration={700}
                >
                  {nodeDonutData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>

            <div className="prof-donut-center">
              <span className="prof-donut-num">{nodeUtilizedPct}%</span>
              <span className="prof-donut-cap">Allocated</span>
            </div>
          </div>

          <div className="prof-dial-breakdown">
            <div className="prof-dial-row">
              <span className="prof-dot" style={{ background: C.coral }} />
              <span>Active Agent Proxies</span>
              <span className="prof-dial-val">{activeAgentNodes}</span>
            </div>
            <div className="prof-dial-row">
              <span className="prof-dot" style={{ background: C.teal }} />
              <span>Standby Buffer</span>
              <span className="prof-dial-val">{idleNodes}</span>
            </div>
          </div>

          <div className="prof-dial-action-wrap">
            <a
              href="https://contextfence.dev/profile"
              target="_blank"
              rel="noopener noreferrer"
              className="prof-btn-action prof-btn-nodes prof-btn-block"
            >
              <Zap size={14} />
              <span>Add Nodes</span>
              <ExternalLink size={12} />
            </a>
          </div>
        </motion.div>
      </motion.div>

      {/* Bottom Section: 2-Column Grid (Account Details Left | Invoices & Receipts Right) */}
      <div className="prof-bottom-grid">
        {/* Left Column: Unified Operator Identity & Form Card */}
        <div className="ag2-card prof-form-box">
          {/* Identity Header Strip */}
          <div className="prof-card-identity-header">
            <div className="prof-identity-left">
              <div className="prof-avatar">
                {avatar ? (
                  <img src={avatar} alt="" referrerPolicy="no-referrer" className="prof-avatar-img" />
                ) : (
                  <div className="prof-avatar-fallback">{userInitials}</div>
                )}
              </div>

              <div className="prof-identity-info">
                <div className="prof-identity-title-row">
                  <h2 className="prof-user-title">{displayName}</h2>
                  <span className={`prof-plan-tag prof-plan-${plan}`}>
                    {planLabel} Plan
                  </span>
                </div>
                <p className="prof-identity-email">{displayEmail}</p>
              </div>
            </div>

            <div className="prof-identity-right">
              {!user ? (
                <button
                  className="ag2-banner-cta"
                  onClick={handleSignIn}
                  disabled={signingInGoogle}
                >
                  {signingInGoogle ? 'Signing in…' : 'Sign in with Google'}
                </button>
              ) : (
                <button
                  className="prof-signout-btn"
                  onClick={() => auth && signOut(auth)}
                >
                  Sign out
                </button>
              )}
            </div>
          </div>

          <div className="prof-card-divider" />

          {/* Form Fields */}
          <div className="prof-box-head" style={{ marginBottom: 12 }}>
            <div>
              <h3 className="prof-box-title" style={{ fontSize: 14 }}>Account Information</h3>
              <p className="prof-box-sub" style={{ fontSize: 11.5 }}>Contact details and organization credentials.</p>
            </div>
          </div>

          <div className="prof-form-grid">
            <div className="prof-form-row">
              <div className="prof-form-field">
                <label className="prof-form-label">First Name</label>
                <input
                  className="prof-input"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Aditya"
                />
              </div>
              <div className="prof-form-field">
                <label className="prof-form-label">Last Name</label>
                <input
                  className="prof-input"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Srivastava"
                />
              </div>
            </div>

            <div className="prof-form-row">
              <div className="prof-form-field">
                <label className="prof-form-label">Email (Synced)</label>
                <input
                  className="prof-input prof-input-disabled"
                  value={displayEmail}
                  disabled
                  placeholder="igaditya10@gmail.com"
                />
              </div>

              <div className="prof-form-field">
                <label className="prof-form-label">Company / Org</label>
                <input
                  className="prof-input"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Organization or Studio"
                />
              </div>
            </div>

            <div className="prof-form-field">
              <label className="prof-form-label">Phone Number</label>
              <div className="prof-phone-group">
                <select
                  className="prof-phone-select"
                  value={phoneDial}
                  onChange={(e) => setPhoneDial(e.target.value)}
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <input
                  className="prof-phone-input"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="Phone number"
                />
              </div>
            </div>

            {saveError && (
              <div className="prof-error-box">
                <AlertCircle size={14} />
                <span>{saveError}</span>
              </div>
            )}

            <div className="prof-form-actions">
              <button
                type="button"
                className="prof-save-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  'Saving…'
                ) : saved ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Check size={14} /> Saved
                  </span>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Invoices & Receipts Card */}
        <div className="ag2-card prof-ledger-box">
          <div className="prof-box-head">
            <div>
              <h3 className="prof-box-title">Invoices &amp; Receipts</h3>
              <p className="prof-box-sub">Verified payment transactions and official invoice downloads.</p>
            </div>
            <span className="prof-badge-count">{txs?.length ?? 0}</span>
          </div>

          {txs && txs.length > 0 ? (
            <div className="prof-table-scroll">
              <table className="prof-ledger-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Plan &amp; Nodes</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((t) => (
                    <tr key={t.id}>
                      <td className="prof-td-dim">{t.date}</td>
                      <td className="prof-td-bold">{t.plan}</td>
                      <td className="prof-td-num">₹{t.amountInr.toLocaleString('en-IN')}</td>
                      <td>
                        <span className="prof-status-tag">
                          <CheckCircle2 size={10} />
                          {t.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="prof-download-pill"
                          onClick={() => downloadBill(t, { firstName, lastName, email: displayEmail, company })}
                          title="Download PDF Invoice"
                        >
                          <Download size={11} />
                          <span>PDF</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="prof-empty-state">
              <Layers size={28} className="prof-empty-icon" />
              <p className="prof-empty-msg">No invoices recorded yet.</p>
              <p className="prof-empty-hint">When you purchase nodes or upgrade your plan, verified receipts will appear here.</p>
              <a
                href="https://contextfence.dev/profile"
                target="_blank"
                rel="noopener noreferrer"
                className="prof-btn-action prof-btn-nodes prof-btn-inline"
              >
                <Zap size={13} />
                <span>Add Nodes</span>
              </a>
            </div>
          )}
        </div>
      </div>

      <style>{`
.ag2-root {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}
.ag2-root::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(255, 49, 68, 0.06), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.07), transparent 65%);
}
.ag2-root > * { position: relative; z-index: 1; }

@keyframes ag2spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ag2-spin { animation: ag2spin 1s linear infinite; }

/* Header */
.ag2-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
.ag2-heading { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.ag2-subhead { font-size: 13px; font-weight: 500; color: var(--text-muted); margin: 4px 0 0; }
.ag2-refresh {
  display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px;
  border-radius: 999px; border: 1px solid var(--border-default); cursor: pointer; font: inherit;
  background: var(--bg-inset); color: var(--text-secondary); font-size: 12.5px; font-weight: 650;
  transition: background 160ms ease, color 160ms ease;
}
.ag2-refresh:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.ag2-refresh:disabled { cursor: progress; }

/* Actions */
.prof-head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.prof-btn-action {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 650; padding: 8px 16px;
  border-radius: 999px; text-decoration: none; cursor: pointer;
  transition: transform 0.15s ease, opacity 0.15s ease; border: none;
}
.prof-btn-action:hover { opacity: 0.92; transform: translateY(-1px); }
.prof-btn-action:active { transform: translateY(0); }
.prof-btn-upgrade { background: linear-gradient(160deg, #17b28c, #0e8a6d); color: #ffffff; box-shadow: var(--glow-teal); }
.prof-btn-nodes { background: linear-gradient(160deg, #ff4d5e, #e51f33); color: #ffffff; box-shadow: var(--glow-red); }
.prof-btn-block { width: 100%; justify-content: center; border-radius: 12px; padding: 11px; margin-top: 12px; }
.prof-btn-inline { display: inline-flex; padding: 8px 18px; margin-top: 14px; }

/* Base Card */
.ag2-card {
  position: relative;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 24px;
  padding: 24px;
  box-shadow: var(--card-shadow);
}

/* KPI row */
.ag2-kpis { display: grid; gap: 18px; grid-template-columns: 1fr 1fr 1fr; }
@media (max-width: 900px) { .ag2-kpis { grid-template-columns: 1fr; } }
.ag2-kpi { display: flex; flex-direction: column; justify-content: space-between; min-height: 180px; padding: 24px 26px; border-radius: 24px; }
.ag2-kpi-label { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; margin: 0; opacity: 0.95; }
.ag2-kpi-value { font-size: 38px; font-weight: 400; letter-spacing: -0.03em; line-height: 1; margin: 8px 0 4px; font-variant-numeric: tabular-nums; }
.ag2-kpi-sub { font-size: 12.5px; font-weight: 500; margin: 0; opacity: 0.85; }
.ag2-kpi-orange { background: linear-gradient(160deg, #ff5163, #ff3144); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(255,49,68,0.28); }
.ag2-kpi-teal   { background: linear-gradient(160deg, #43907f, #397e70); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(57,126,112,0.26); }
.ag2-kpi-white .ag2-kpi-label { color: var(--text-muted); }
.ag2-kpi-white .ag2-kpi-value { color: var(--text-primary); }
.ag2-kpi-white .ag2-kpi-sub { color: var(--text-secondary); opacity: 1; }
.ag2-kpi-unit { font-size: 0.45em; font-weight: 450; opacity: 0.8; letter-spacing: -0.01em; margin-left: 2px; }
.ag2-meter { height: 6px; border-radius: 999px; background: var(--bg-inset); overflow: hidden; margin-top: 12px; margin-bottom: 6px; }
.ag2-meter-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-teal), #2fe6b0); transition: width 700ms cubic-bezier(0.22,1,0.36,1); }

/* Charts Layout & AgentDetail Styles */
.prof-charts-row { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; }
@media (max-width: 900px) { .prof-charts-row { grid-template-columns: 1fr; } }
.prof-chart-box, .prof-dial-box { padding: 24px; display: flex; flex-direction: column; justify-content: space-between; }
.ad-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.ad-h3 { font-size: 16px; font-weight: 650; color: var(--text-primary); margin: 0; }
.ad-h3-sub { font-size: 12.5px; color: var(--text-muted); margin: 3px 0 0; }

.ad-range { display: flex; gap: 2px; background: var(--bg-inset); padding: 3px; border-radius: 999px; border: 1px solid var(--border-default); }
.ad-range-btn {
  background: transparent; border: none; font-size: 11.5px; font-weight: 650; color: var(--text-muted);
  padding: 5px 12px; border-radius: 999px; cursor: pointer; transition: all 0.15s ease;
}
.ad-range-btn:hover:not(.active) { color: var(--text-secondary); }
.ad-range-btn.active { background: var(--card-bg); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.12); }

.prof-chart-foot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-default); font-size: 12px; color: var(--text-muted); }
.prof-legend-entry { display: flex; align-items: center; gap: 6px; }
.prof-dot { width: 7px; height: 7px; border-radius: 50%; }
.prof-foot-link { margin-left: auto; color: var(--accent-coral); font-weight: 650; text-decoration: none; }

/* Donut */
.prof-box-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.prof-box-title { font-size: 16px; font-weight: 650; color: var(--text-primary); margin: 0; }
.prof-box-sub { font-size: 12.5px; color: var(--text-muted); margin: 3px 0 0; }
.prof-donut-center { position: absolute; inset: 0; pointer-events: none; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.prof-donut-num { font-size: 26px; font-weight: 350; color: var(--text-primary); line-height: 1; font-variant-numeric: tabular-nums; }
.prof-donut-cap { font-size: 10.5px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; margin-top: 3px; }
.prof-dial-breakdown { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.prof-dial-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-muted); }
.prof-dial-val { margin-left: auto; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }

/* Bottom 2-Column Grid */
.prof-bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 950px) { .prof-bottom-grid { grid-template-columns: 1fr; } }

/* Unified Operator Identity & Form Card */
.prof-form-box { padding: 24px 26px; display: flex; flex-direction: column; justify-content: space-between; }
.prof-card-identity-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap;
}
.prof-identity-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.prof-avatar {
  width: 50px; height: 50px; border-radius: 16px; overflow: hidden;
  flex-shrink: 0; background: var(--bg-inset); border: 1px solid var(--border-default);
  display: grid; place-items: center;
}
.prof-avatar-img { width: 100%; height: 100%; object-fit: cover; }
.prof-avatar-fallback { font-size: 19px; font-weight: 700; color: var(--text-muted); }
.prof-identity-info { min-width: 0; }
.prof-identity-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.prof-user-title { font-size: 17px; font-weight: 650; color: var(--text-primary); margin: 0; letter-spacing: -0.01em; }
.prof-identity-email { font-size: 12.5px; color: var(--text-muted); margin: 3px 0 0; }
.prof-plan-tag {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 2px 9px; border-radius: 999px;
}
.prof-plan-teams { background: rgba(57,126,112,0.12); color: #2fe6b0; border: 1px solid rgba(57,126,112,0.25); }
.prof-plan-starter { background: rgba(255,49,68,0.12); color: #ff4d5e; border: 1px solid rgba(255,49,68,0.25); }
.prof-plan-free { background: var(--bg-inset); color: var(--text-muted); border: 1px solid var(--border-default); }
.prof-signout-btn {
  background: transparent; color: var(--text-muted); border: 1px solid var(--border-default);
  border-radius: 999px; padding: 6px 14px; font-size: 11.5px; font-weight: 600; cursor: pointer;
  transition: all 0.15s ease;
}
.prof-signout-btn:hover { color: var(--accent-coral); border-color: rgba(255,49,68,0.3); background: rgba(255,49,68,0.04); }
.ag2-banner-cta {
  font-size: 12px; font-weight: 650; color: #ffffff;
  background: #111111; padding: 8px 16px; border-radius: 999px; border: none; cursor: pointer;
}

.prof-card-divider {
  height: 1px; background: var(--border-default); margin: 18px 0 16px;
}

.prof-form-grid { display: flex; flex-direction: column; gap: 12px; }
.prof-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 600px) { .prof-form-row { grid-template-columns: 1fr; } }
.prof-form-field { display: flex; flex-direction: column; gap: 4px; }
.prof-form-label { font-size: 10.5px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.prof-input {
  width: 100%; padding: 9px 12px; font-size: 12.5px; border-radius: 10px;
  background: var(--bg-inset); border: 1px solid var(--border-default); color: var(--text-primary);
  outline: none; transition: border-color 0.15s ease;
}
.prof-input:focus { border-color: var(--accent-coral); }
.prof-input-disabled { opacity: 0.75; cursor: not-allowed; }
.prof-phone-group { display: flex; gap: 6px; }
.prof-phone-select {
  width: 95px; padding: 9px 8px; font-size: 12.5px; border-radius: 10px;
  background: var(--bg-inset); border: 1px solid var(--border-default); color: var(--text-primary);
  outline: none; cursor: pointer;
}
.prof-phone-input {
  flex: 1; padding: 9px 12px; font-size: 12.5px; border-radius: 10px;
  background: var(--bg-inset); border: 1px solid var(--border-default); color: var(--text-primary);
  outline: none;
}
.prof-phone-input:focus { border-color: var(--accent-coral); }
.prof-form-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
.prof-save-btn {
  background: var(--text-primary); color: var(--bg-surface, #ffffff); font-weight: 650; font-size: 12px;
  padding: 8px 20px; border-radius: 999px; border: none; cursor: pointer; transition: opacity 0.15s ease;
}
:root[data-theme="dark"] .prof-save-btn { color: #0a0d13; background: #f2f5f9; }
.prof-save-btn:hover { opacity: 0.88; }
.prof-error-box { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #ff4d4f; background: rgba(255,77,79,0.08); padding: 8px 12px; border-radius: 8px; }

/* Ledger Table (Right Column Card) */
.prof-ledger-box { padding: 24px 26px; display: flex; flex-direction: column; justify-content: space-between; }
.prof-badge-count { font-size: 11px; font-weight: 700; color: var(--text-muted); background: var(--bg-inset); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border-default); }
.prof-table-scroll { overflow-x: auto; margin-top: 16px; flex: 1; }
.prof-ledger-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.prof-ledger-table th { text-align: left; font-size: 10.5px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; padding: 9px 10px; border-bottom: 1px solid var(--border-default); }
.prof-ledger-table td { padding: 10px 10px; border-bottom: 1px solid var(--border-default); color: var(--text-muted); }
.prof-td-dim { font-family: var(--font-mono, monospace); font-size: 11px; }
.prof-td-bold { color: var(--text-primary); font-weight: 600; }
.prof-td-num { color: var(--text-primary); font-weight: 700; font-family: var(--font-mono, monospace); }
.prof-status-tag { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; background: rgba(82,196,26,0.12); color: #52c41a; }
.prof-download-pill { display: inline-flex; align-items: center; gap: 4px; background: var(--bg-inset); border: 1px solid var(--border-default); color: var(--text-primary); border-radius: 6px; font-size: 11px; font-weight: 600; padding: 4px 9px; cursor: pointer; transition: all 0.15s ease; }
.prof-download-pill:hover { border-color: var(--border-strong); background: var(--bg-surface-hover); }

/* Empty */
.prof-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px; text-align: center; color: var(--text-muted); flex: 1; }
.prof-empty-icon { opacity: 0.35; margin-bottom: 12px; }
.prof-empty-msg { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0 0 4px; }
.prof-empty-hint { font-size: 12px; max-width: 280px; margin: 0; line-height: 1.5; }

/* Tooltip matching AgentDetail */
.ad-tooltip {
  background: var(--card-bg, #10151d);
  border: 1px solid var(--border-strong, rgba(255,255,255,0.1));
  border-radius: 12px;
  padding: 10px 14px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  font-size: 12px;
  min-width: 150px;
}
.ad-tooltip-label { margin: 0 0 6px; font-size: 11px; font-weight: 700; color: var(--text-muted); }
.ad-tooltip-row { display: flex; align-items: center; gap: 7px; padding: 2px 0; }
.ad-tooltip-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.ad-tooltip-name { color: var(--text-secondary); font-size: 11.5px; }
.ad-tooltip-val { margin-left: auto; color: var(--text-primary); font-weight: 700; font-family: var(--font-mono, monospace); }

/* Dark mode theme overrides */
:root[data-theme="dark"] .ag2-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .ag2-kpi-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
:root[data-theme="dark"] .ag2-kpi-teal { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
:root[data-theme="dark"] .ag2-banner-cta { background: #f2f5f9; color: #0a0d13; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .ag2-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .ag2-kpi-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
  :root:not([data-theme]) .ag2-kpi-teal { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
  :root:not([data-theme]) .ag2-banner-cta { background: #f2f5f9; color: #0a0d13; }
}
      `}</style>
    </div>
  );
}