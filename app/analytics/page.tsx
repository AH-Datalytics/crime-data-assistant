"use client";

import { useState, useEffect } from "react";

interface AnalyticsData {
  queriesPerDay: { day: string; queries: number; sessions: number }[];
  tabBreakdown: { tab: string; queries: number }[];
  sessionDetails: { session_id: string; queries: number; first_query: number; last_query: number; tabs_used: string; duration_sec: number }[];
  sessionDistribution: { queries_bucket: string; sessions: number }[];
  errorRate: { total: number; errors: number };
  topQuestions: { question: string; cnt: number; tab: string }[];
  referrers: { referrer_domain: string; visits: number }[];
  devices: { device: string; visits: number }[];
  visitorsPerDay: { day: string; visits: number; unique_sessions: number }[];
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{typeof value === "number" ? value.toLocaleString() : value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDuration(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export default function AnalyticsPage() {
  const [pw, setPw] = useState("");
  const [authed, setAuthed] = useState(false);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = async (password: string, numDays: number) => {
    setLoading(true);
    try {
      /**
       * The operator's key travels in the Authorization header, never in the URL.
       *
       * It used to be `?pw=${password}`, which put a live credential everywhere a URL goes: server and
       * proxy access logs, browser history, and the `Referer` of anything the page later linked to. The
       * route now refuses any credential-shaped query parameter outright, so this is not merely the
       * preferred form -- the old form no longer works.
       */
      const res = await fetch(`/api/session-analytics?days=${numDays}`, {
        headers: { Authorization: `Bearer ${password}` },
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const json = await res.json();
      setData(json);
      setAuthed(true);
    } catch {
      // ignore
    }
    setLoading(false);
  };

  useEffect(() => {
    if (authed) fetchData(pw, days);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <form
          onSubmit={(e) => { e.preventDefault(); fetchData(pw, days); }}
          className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-80"
        >
          <h1 className="text-lg font-bold text-gray-900 mb-4">Session Analytics</h1>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3"
            autoFocus
          />
          <button className="w-full bg-gray-900 text-white py-2 rounded-lg text-sm font-semibold">
            View Analytics
          </button>
        </form>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const totalQueries = data.queriesPerDay.reduce((s, d) => s + d.queries, 0);
  const totalSessions = data.sessionDetails.length;
  const avgQueriesPerSession = totalSessions > 0 ? (totalQueries / totalSessions).toFixed(1) : "—";
  const errorPct = data.errorRate.total > 0 ? ((data.errorRate.errors / data.errorRate.total) * 100).toFixed(1) : "0";
  const avgDuration = totalSessions > 0
    ? formatDuration(data.sessionDetails.reduce((s, d) => s + d.duration_sec, 0) / totalSessions)
    : "—";

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Session Analytics</h1>
          <div className="flex gap-2">
            {[7, 14, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  days === d ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <StatCard label="Total Queries" value={totalQueries} sub={`Last ${days} days`} />
          <StatCard label="Sessions" value={totalSessions} />
          <StatCard label="Avg Queries/Session" value={avgQueriesPerSession} />
          <StatCard label="Avg Session Duration" value={avgDuration} />
          <StatCard label="Error Rate" value={`${errorPct}%`} sub={`${data.errorRate.errors} errors`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Queries per day */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-900 mb-4">Queries per Day</h3>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.queriesPerDay.map((d) => (
                <div key={d.day} className="flex items-center gap-3 text-xs">
                  <span className="text-gray-500 w-20 shrink-0">{d.day}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                    <div
                      className="bg-blue-500 h-full rounded-full"
                      style={{ width: `${Math.min((d.queries / Math.max(...data.queriesPerDay.map(x => x.queries))) * 100, 100)}%` }}
                    />
                  </div>
                  <span className="text-gray-700 font-semibold w-8 text-right">{d.queries}</span>
                  <span className="text-gray-400 w-16 text-right">{d.sessions} sess</span>
                </div>
              ))}
            </div>
          </div>

          {/* Tab breakdown */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-900 mb-4">Tab Breakdown</h3>
            <div className="space-y-3">
              {data.tabBreakdown.map((t) => (
                <div key={t.tab} className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700 capitalize">{t.tab || "unknown"}</span>
                  <span className="text-sm font-bold text-gray-900">{t.queries.toLocaleString()}</span>
                </div>
              ))}
            </div>

            <h3 className="text-sm font-bold text-gray-900 mt-6 mb-4">Queries per Session</h3>
            <div className="space-y-2">
              {data.sessionDistribution.map((d) => (
                <div key={d.queries_bucket} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{d.queries_bucket} queries</span>
                  <span className="font-semibold text-gray-900">{d.sessions} sessions</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Referrers */}
          {data.referrers.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h3 className="text-sm font-bold text-gray-900 mb-4">Referrers</h3>
              <div className="space-y-2">
                {data.referrers.map((r: { referrer_domain: string; visits: number }) => (
                  <div key={r.referrer_domain} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600 truncate">{r.referrer_domain}</span>
                    <span className="font-semibold text-gray-900 shrink-0 ml-3">{r.visits}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Devices */}
          {data.devices.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h3 className="text-sm font-bold text-gray-900 mb-4">Devices</h3>
              <div className="space-y-2">
                {data.devices.map((d: { device: string; visits: number }) => (
                  <div key={d.device} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{d.device}</span>
                    <span className="font-semibold text-gray-900">{d.visits}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Top questions */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-8">
          <h3 className="text-sm font-bold text-gray-900 mb-4">Top Questions</h3>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {data.topQuestions.map((q, i) => (
              <div key={i} className="flex items-start gap-3 text-sm py-1.5 border-b border-gray-50 last:border-0">
                <span className="text-gray-400 w-6 shrink-0 text-right">{q.cnt}x</span>
                <span className="text-gray-700 flex-1">{q.question}</span>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded capitalize shrink-0">{q.tab}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent sessions */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-bold text-gray-900 mb-4">Recent Sessions</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th className="pb-2 text-xs text-gray-500 font-semibold">Session</th>
                  <th className="pb-2 text-xs text-gray-500 font-semibold">Queries</th>
                  <th className="pb-2 text-xs text-gray-500 font-semibold">Tabs</th>
                  <th className="pb-2 text-xs text-gray-500 font-semibold">Duration</th>
                  <th className="pb-2 text-xs text-gray-500 font-semibold">First Query</th>
                </tr>
              </thead>
              <tbody>
                {data.sessionDetails.slice(0, 50).map((s) => (
                  <tr key={s.session_id} className="border-b border-gray-50">
                    <td className="py-2 text-gray-400 font-mono text-xs">{s.session_id.slice(0, 12)}...</td>
                    <td className="py-2 font-semibold text-gray-900">{s.queries}</td>
                    <td className="py-2 text-gray-600">{s.tabs_used}</td>
                    <td className="py-2 text-gray-600">{formatDuration(s.duration_sec)}</td>
                    <td className="py-2 text-gray-500 text-xs">{formatDate(s.first_query)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
