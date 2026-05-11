import {
  Activity,
  BarChart2,
  TrendingUp,
  Zap,
  Scale,
  MoreHorizontal,
  Footprints,
  Bike,
  Waves,
  List,
  LineChart as LineChartIcon,
  Calendar,
  Settings,
} from 'lucide-react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { useEffect, useState } from 'react';
import { jwtDecode } from 'jwt-decode';
import apiClient from './services/apiClient';
import Login from './components/Login';
import Profile from './components/Profile';
import Spinner from './components/Spinner';

const ICON_MAP = {
  running: <Footprints className="w-5 h-5" />,
  cycling: <Bike className="w-5 h-5" />,
  swimming: <Waves className="w-5 h-5" />,
};

interface Activity {
  name: string;
  activity_type: string;
  timestamp: string;
  duration_min: number;
  avg_heart_rate: number;
  distance: number;
  trimp: number;
}

interface Metrics {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
}

interface UserProfile {
  name?: string;
  email?: string;
  picture?: string;
}

export default function App() {
  const [metrics, setMetrics] = useState<Metrics[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getAnalysis = async () => {
      try {
        const response = await apiClient.get('/api/analysis');
        setMetrics(response.data.metrics);
        setActivities(response.data.activities);
      } catch (error) {
        setError('Failed to fetch analysis data. Please try again later.');
        console.error('Error fetching analysis:', error);
      } finally {
        setIsLoading(false);
      }
    };
    getAnalysis();
  }, []);

  const handleLoginSuccess = (credentialResponse: any) => {
    if (credentialResponse.access_token || credentialResponse.credential) {
      try {
        const token = credentialResponse.credential || credentialResponse.access_token;
        const decoded: UserProfile = jwtDecode(token);
        setUser(decoded);
        setIsLoggedIn(true);
      } catch(e) {
        console.error("Failed to decode token", e);
      }
    }
  };

  const handleLoginError = () => {
    console.log('Login Failed');
  };

  const handleLogout = () => {
    setUser(null);
    setIsLoggedIn(false);
  };

  return (
    <div className="bg-surface text-on-surface antialiased pt-16 pb-16 md:pb-0 min-h-screen">
      {/* TopAppBar */}
      <header className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 h-16 bg-surface-container-lowest border-b border-surface-variant">
        <div className="flex items-center gap-2">
          <Activity className="w-6 h-6 text-primary" />
          <span className="text-lg font-black tracking-tighter text-primary font-lexend mt-0.5">
            PERFORMANCE LAB
          </span>
        </div>
        <nav className="hidden md:flex gap-6">
          <a
            className="text-primary font-bold font-lexend tracking-tight hover:bg-surface-container-low transition-all active:scale-95 px-3 py-2 rounded-lg"
            href="#"
          >
            Activities
          </a>
          <a
            className="text-secondary font-semibold font-lexend tracking-tight hover:bg-surface-container-low transition-all active:scale-95 px-3 py-2 rounded-lg"
            href="#"
          >
            Progress
          </a>
          <a
            className="text-secondary font-semibold font-lexend tracking-tight hover:bg-surface-container-low transition-all active:scale-95 px-3 py-2 rounded-lg"
            href="#"
          >
            Training
          </a>
        </nav>
        <div className="flex items-center">
          {isLoggedIn && user ? (
            <Profile user={user} onLogout={handleLogout} />
          ) : (
            <Login onSuccess={handleLoginSuccess} onError={handleLoginError} />
          )}
        </div>
      </header>
      <main className="max-w-[1600px] mx-auto p-4 md:p-6 lg:p-8 space-y-stack-lg mt-8">
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <div className="text-center text-error">{error}</div>
        ) : (
          <>
            {/* Header */}
            <div>
              <h1 className="font-lexend text-[40px] leading-tight font-bold text-primary">
                Dashboard
              </h1>
              <p className="font-manrope text-base text-secondary mt-2">
                Your current training status and recent efforts.
              </p>
            </div>

            {/* Metrics Summary Cards */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-gutter">
              {/* Weekly Load */}
              <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-card-padding flex flex-col justify-between shadow-sm">
                <div className="flex justify-between items-start mb-4">
                  <span className="font-manrope text-xs font-bold tracking-[0.05em] uppercase text-secondary">
                    Weekly Load
                  </span>
                  <BarChart2 className="w-4 h-4 text-outline" />
                </div>
                <div>
                  <span className="font-manrope text-3xl font-semibold tracking-[-0.02em] text-primary">
                    452
                  </span>
                  <span className="font-manrope text-sm text-secondary ml-1">
                    TSS
                  </span>
                </div>
                <div className="mt-3">
                  <span className="text-xs font-manrope font-medium text-on-tertiary-container bg-tertiary-fixed-dim/20 inline-block px-2 py-1 rounded-sm">
                    +12% vs last week
                  </span>
                </div>
              </div>

              {/* Fitness (CTL) */}
              <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-card-padding flex flex-col justify-between shadow-sm">
                <div className="flex justify-between items-start mb-4">
                  <span className="font-manrope text-xs font-bold tracking-[0.05em] uppercase text-secondary">
                    Fitness (CTL)
                  </span>
                  <TrendingUp className="w-4 h-4 text-outline" />
                </div>
                <div>
                  <span className="font-manrope text-3xl font-semibold tracking-[-0.02em] text-primary">
                    {metrics.length > 0 && metrics[metrics.length - 1].ctl != null
                      ? metrics[metrics.length - 1].ctl.toFixed(1)
                      : 'N/A'}
                  </span>
                </div>
                <div className="mt-3">
                  <span className="text-xs font-manrope font-medium text-on-tertiary-container bg-tertiary-fixed-dim/20 inline-block px-2 py-1 rounded-sm">
                    Optimal Range
                  </span>
                </div>
                </div>

                {/* Fatigue (ATL) */}
                <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-card-padding flex flex-col justify-between shadow-sm">
                <div className="flex justify-between items-start mb-4">
                  <span className="font-manrope text-xs font-bold tracking-[0.05em] uppercase text-secondary">
                    Fatigue (ATL)
                  </span>
                  <Zap className="w-4 h-4 text-outline" />
                </div>
                <div>
                  <span className="font-manrope text-3xl font-semibold tracking-[-0.02em] text-primary">
                    {metrics.length > 0 && metrics[metrics.length - 1].atl != null
                      ? metrics[metrics.length - 1].atl.toFixed(1)
                      : 'N/A'}
                  </span>
                </div>
                <div className="mt-3">
                  <span className="text-xs font-manrope font-medium text-error bg-error-container/50 inline-block px-2 py-1 rounded-sm">
                    High
                  </span>
                </div>
                </div>

                {/* Form (TSB) */}
                <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-card-padding flex flex-col justify-between shadow-sm">
                <div className="flex justify-between items-start mb-4">
                  <span className="font-manrope text-xs font-bold tracking-[0.05em] uppercase text-secondary">
                    Form (TSB)
                  </span>
                  <Scale className="w-4 h-4 text-outline" />
                </div>
                <div>
                  <span className="font-manrope text-3xl font-semibold tracking-[-0.02em] text-primary">
                    {metrics.length > 0 && metrics[metrics.length - 1].tsb != null
                      ? metrics[metrics.length - 1].tsb.toFixed(1)
                      : 'N/A'}
                  </span>
                </div>
                <div className="mt-3">
                  <span className="text-xs font-manrope font-medium text-secondary bg-surface-variant/50 inline-block px-2 py-1 rounded-sm">
                    Productive
                  </span>
                </div>
                </div>
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
                {/* Middle Section: Recent Activities */}
                <section className="lg:col-span-5 bg-surface-container-lowest border border-surface-variant rounded-xl flex flex-col shadow-sm max-h-[500px]">
                <div className="p-card-padding border-b border-surface-variant flex justify-between items-center">
                  <h2 className="font-lexend text-2xl font-semibold leading-snug text-primary">
                    Recent Activities
                  </h2>
                  <button className="text-secondary hover:text-primary transition-colors">
                    <MoreHorizontal className="w-5 h-5" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {activities.slice(0, 3).map((activity, index) => (
                    <div
                      key={index}
                      className="p-4 border-b border-surface-variant hover:bg-surface-container-low transition-colors flex items-center gap-4 cursor-pointer"
                    >
                      <div className="w-10 h-10 rounded-full bg-error-container text-error flex items-center justify-center shrink-0">
                        {ICON_MAP[activity.activity_type] || (
                          <Activity className="w-5 h-5" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-manrope text-base text-primary font-semibold truncate">
                          {activity.name}
                        </h3>
                        <p className="font-manrope text-sm text-secondary truncate">
                          {activity.timestamp 
                            ? new Date(activity.timestamp).toLocaleDateString()
                            : 'Unknown Date'} •{' '}
                          {activity.activity_type}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-manrope text-sm font-semibold tracking-[-0.02em] text-primary">
                          {activity.duration_min != null
                            ? new Date(activity.duration_min * 60 * 1000)
                                .toISOString()
                                .substr(11, 8)
                            : '00:00:00'}
                        </div>
                        <div className="font-manrope text-xs text-secondary mt-0.5">
                          {activity.avg_heart_rate ?? 0} bpm |{' '}
                          {activity.trimp?.toFixed(0) ?? 0} TRIMP
                        </div>
                      </div>
                    </div>
                  ))}
                </div>                <div className="p-4 border-t border-surface-variant text-center bg-surface-container-lowest rounded-b-xl">
                  <button className="font-manrope text-xs font-bold tracking-[0.05em] text-on-tertiary-container hover:text-on-tertiary-fixed-variant transition-colors uppercase w-full py-1">
                    View All Activities
                  </button>
                </div>
              </section>

              {/* Bottom Section: Fitness Progression Chart */}
              <section className="lg:col-span-7 bg-surface-container-lowest border border-surface-variant rounded-xl p-card-padding flex flex-col shadow-sm">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="font-lexend text-2xl font-semibold leading-snug text-primary">
                      Fitness Progression
                    </h2>
                    <p className="font-manrope text-sm text-secondary">
                      Past 30 Days PMC
                    </p>
                  </div>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-primary outline outline-1 outline-offset-1 outline-primary/20"></div>
                      <span className="font-manrope text-[10px] font-bold tracking-[0.05em] uppercase text-secondary">
                        CTL
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-error outline outline-1 outline-offset-1 outline-error/20"></div>
                      <span className="font-manrope text-[10px] font-bold tracking-[0.05em] uppercase text-secondary">
                        ATL
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-tertiary-fixed-dim outline outline-1 outline-offset-1 outline-tertiary-fixed-dim/20"></div>
                      <span className="font-manrope text-[10px] font-bold tracking-[0.05em] uppercase text-secondary">
                        TSB
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex-1 min-h-[350px] w-full bg-surface-container-low rounded-lg border border-surface-variant p-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={metrics}
                      margin={{ top: 10, right: 0, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="4 4"
                        vertical={false}
                        stroke="#e0e3e5"
                      />
                      <XAxis
                        dataKey="date"
                        axisLine={false}
                        tickLine={false}
                        tick={{
                          fill: '#76777d',
                          fontSize: 12,
                          fontFamily: 'Manrope',
                        }}
                        dy={10}
                      />
                      {/* Left Axis for CTL/ATL */}
                      <YAxis yAxisId="left" domain={[30, 120]} hide />
                      {/* Right Axis for TSB */}
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[-40, 40]}
                        hide
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#ffffff',
                          borderRadius: '8px',
                          border: '1px solid #e0e3e5',
                          boxShadow:
                            '0 4px 6px -1px rgb(0 0 0 / 0.05)',
                        }}
                        labelStyle={{
                          fontWeight: 'bold',
                          color: '#191c1e',
                          fontFamily: 'Manrope',
                          marginBottom: '4px',
                        }}
                        itemStyle={{
                          fontFamily: 'Manrope',
                          fontSize: '14px',
                        }}
                      />
                      <ReferenceLine
                        y={0}
                        yAxisId="right"
                        stroke="#76777d"
                        strokeDasharray="3 3"
                      />
                      <Area
                        yAxisId="right"
                        type="monotone"
                        dataKey="tsb"
                        name="TSB (Form)"
                        fill="#c9e6ff"
                        stroke="none"
                        fillOpacity={0.6}
                      />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="ctl"
                        name="CTL (Fitness)"
                        stroke="#000000"
                        strokeWidth={2.5}
                        dot={false}
                      />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="atl"
                        name="ATL (Fatigue)"
                        stroke="#ba1a1a"
                        strokeWidth={1.5}
                        dot={false}
                        opacity={0.8}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>
          </>
        )}
      </main>

      {/* BottomNavBar (Mobile Only) */}
      <nav className="md:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center h-16 px-4 bg-surface-container-lowest/90 backdrop-blur-md border-t border-surface-variant shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
        <a
          href="#"
          className="flex flex-col items-center justify-center text-primary border-t-2 border-primary pt-2 active:scale-95 transition-all w-1/4"
        >
          <List className="w-5 h-5 mb-1" />
          <span className="font-lexend text-[10px] font-medium uppercase tracking-wider">
            Activities
          </span>
        </a>
        <a
          href="#"
          className="flex flex-col items-center justify-center text-secondary pt-2 hover:text-primary active:scale-95 transition-all w-1/4 border-t-2 border-transparent"
        >
          <LineChartIcon className="w-5 h-5 mb-1" />
          <span className="font-lexend text-[10px] font-medium uppercase tracking-wider">
            Progress
          </span>
        </a>
        <a
          href="#"
          className="flex flex-col items-center justify-center text-secondary pt-2 hover:text-primary active:scale-95 transition-all w-1/4 border-t-2 border-transparent"
        >
          <Calendar className="w-5 h-5 mb-1" />
          <span className="font-lexend text-[10px] font-medium uppercase tracking-wider">
            Training
          </span>
        </a>
        <a
          href="#"
          className="flex flex-col items-center justify-center text-secondary pt-2 hover:text-primary active:scale-95 transition-all w-1/4 border-t-2 border-transparent"
        >
          <Settings className="w-5 h-5 mb-1" />
          <span className="font-lexend text-[10px] font-medium uppercase tracking-wider">
            Settings
          </span>
        </a>
      </nav>
    </div>
  );
}
