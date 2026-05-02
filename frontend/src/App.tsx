/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

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
  User,
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

const pmcData = [
  { date: 'Oct 1', ctl: 70, atl: 65, tsb: 5 },
  { date: 'Oct 4', ctl: 72, atl: 68, tsb: 4 },
  { date: 'Oct 7', ctl: 73, atl: 88, tsb: -15 },
  { date: 'Oct 10', ctl: 75, atl: 84, tsb: -9 },
  { date: 'Oct 13', ctl: 76, atl: 75, tsb: 1 },
  { date: 'Oct 16', ctl: 78, atl: 95, tsb: -17 },
  { date: 'Oct 19', ctl: 80, atl: 90, tsb: -10 },
  { date: 'Oct 22', ctl: 81, atl: 85, tsb: -4 },
  { date: 'Oct 25', ctl: 83, atl: 105, tsb: -22 },
  { date: 'Oct 28', ctl: 84, atl: 98, tsb: -14 },
  { date: 'Oct 31', ctl: 85.4, atl: 92.1, tsb: -6.7 },
];

export default function App() {
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
        <div className="w-8 h-8 rounded-full bg-surface-variant flex items-center justify-center overflow-hidden cursor-pointer hover:bg-surface-dim transition-colors">
          <User className="w-4 h-4 text-on-surface-variant" />
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-4 md:p-6 lg:p-8 space-y-stack-lg mt-8">
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
              <span className="font-manrope text-sm text-secondary ml-1">TSS</span>
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
                85.4
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
                92.1
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
                -6.7
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
              {/* Activity Item: Run */}
              <div className="p-4 border-b border-surface-variant hover:bg-surface-container-low transition-colors flex items-center gap-4 cursor-pointer">
                <div className="w-10 h-10 rounded-full bg-error-container text-error flex items-center justify-center shrink-0">
                  <Footprints className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-manrope text-base text-primary font-semibold truncate">
                    Threshold Intervals
                  </h3>
                  <p className="font-manrope text-sm text-secondary truncate">
                    Today • Run
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-manrope text-sm font-semibold tracking-[-0.02em] text-primary">
                    1:15:00
                  </div>
                  <div className="font-manrope text-xs text-secondary mt-0.5">
                    165 bpm | 85 TRIMP
                  </div>
                </div>
              </div>

              {/* Activity Item: Bike */}
              <div className="p-4 border-b border-surface-variant hover:bg-surface-container-low transition-colors flex items-center gap-4 cursor-pointer">
                <div className="w-10 h-10 rounded-full bg-tertiary-fixed text-on-tertiary-container flex items-center justify-center shrink-0">
                  <Bike className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-manrope text-base text-primary font-semibold truncate">
                    Endurance Ride
                  </h3>
                  <p className="font-manrope text-sm text-secondary truncate">
                    Yesterday • Bike
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-manrope text-sm font-semibold tracking-[-0.02em] text-primary">
                    3:30:00
                  </div>
                  <div className="font-manrope text-xs text-secondary mt-0.5">
                    132 bpm | 142 TRIMP
                  </div>
                </div>
              </div>

              {/* Activity Item: Swim */}
              <div className="p-4 border-b border-surface-variant hover:bg-surface-container-low transition-colors flex items-center gap-4 cursor-pointer">
                <div className="w-10 h-10 rounded-full bg-secondary-fixed text-on-secondary-container flex items-center justify-center shrink-0">
                  <Waves className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-manrope text-base text-primary font-semibold truncate">
                    Masters Swim
                  </h3>
                  <p className="font-manrope text-sm text-secondary truncate">
                    Oct 24 • Swim
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-manrope text-sm font-semibold tracking-[-0.02em] text-primary">
                    0:55:00
                  </div>
                  <div className="font-manrope text-xs text-secondary mt-0.5">
                    145 bpm | 45 TRIMP
                  </div>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-surface-variant text-center bg-surface-container-lowest rounded-b-xl">
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
                  data={pmcData}
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
                    tick={{ fill: '#76777d', fontSize: 12, fontFamily: 'Manrope' }}
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
                      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)',
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
