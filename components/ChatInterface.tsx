"use client";

import { useState } from "react";
import CrimeIndexLogo from "./CrimeIndexLogo";
import RtciChat from "./RtciChat";
import NibrsChat from "./NibrsChat";
import ExplainerContent from "./ExplainerContent";
import GettingStarted from "./GettingStarted";
import Tracker from "./Tracker";

type TabId = "current" | "historical" | "nibrs" | "explainer";

const TABS: { id: TabId; label: string; shortLabel: string; color: string }[] = [
  { id: "current", label: "Current Trends", shortLabel: "Current", color: "#475EC7" },
  { id: "historical", label: "Historical Library", shortLabel: "Historical", color: "#8B5E3C" },
  { id: "nibrs", label: "NIBRS Explorer", shortLabel: "NIBRS", color: "#2d8659" },
  { id: "explainer", label: "Tutorial", shortLabel: "Tutorial", color: "#333" },
];

interface ChatInterfaceProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
  historicalMaxYear?: number;
}

export default function ChatInterface({ heroData, heroAgencyCount, heroPopulation, historicalHeroData, historicalMaxYear }: ChatInterfaceProps) {
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  // Track which tabs have been visited — lazy-mount on first visit, keep mounted after
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(new Set());

  const selectTab = (tab: TabId | null) => {
    if (tab) setMountedTabs((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
    setActiveTab(tab);
  };

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      {/* Header */}
      <header className="bg-white border-b border-[var(--border)] shrink-0">
        {/* Top row: logo + tab pills (desktop) */}
        <div className="px-4 md:px-6 flex items-center justify-between relative" style={{ height: 56 }}>
          {/* Left: back arrow + logo (desktop only) + Crime Index (desktop only) */}
          <div className="flex items-center gap-3 md:gap-4 min-w-0 shrink-0">
            <a
              href="https://crimeindex.org"
              className="flex items-center gap-1 text-xs font-bold text-[var(--muted)] hover:text-[var(--foreground)] transition-colors shrink-0"
            >
              <span>&larr;</span>
              <span>Back</span>
            </a>
            <div className="h-5 w-px bg-[var(--border)] hidden md:block" />
            <button
              onClick={() => selectTab(null)}
              className="hidden md:flex items-center gap-2 shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
            >
              <CrimeIndexLogo size={24} />
              <span
                className="text-xs md:text-sm font-medium tracking-widest uppercase text-[var(--foreground)]"
                style={{ letterSpacing: "2.5px" }}
              >
                Crime Index
              </span>
            </button>
          </div>

          {/* Center: title */}
          <button
            onClick={() => selectTab(null)}
            className="absolute left-1/2 -translate-x-1/2 text-[11px] md:text-[13px] lg:text-base font-bold uppercase text-[var(--foreground)] whitespace-nowrap cursor-pointer hover:opacity-80 transition-opacity"
            style={{ letterSpacing: "2.5px" }}
          >
            Crime Data Assistant
          </button>

          {/* Right: logo on mobile, tab pills on desktop */}
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => selectTab(null)} className="md:hidden flex items-center shrink-0 cursor-pointer">
              <CrimeIndexLogo size={24} />
            </button>
            <div className={`${activeTab === null ? "hidden" : "hidden md:flex"} items-center gap-0 rounded-lg overflow-hidden border border-[var(--border)]`}>
              {TABS.map((tab, i) => (
                <button
                  key={tab.id}
                  onClick={() => selectTab(tab.id)}
                  className={`text-xs lg:text-sm font-medium px-2.5 lg:px-4 py-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                    i > 0 ? "border-l border-[var(--border)]" : ""
                  } ${
                    activeTab === tab.id
                      ? "text-white"
                      : "bg-white text-[#666] hover:bg-[#f0f0f0]"
                  }`}
                  style={activeTab === tab.id ? { backgroundColor: tab.color } : undefined}
                >
                  <span className="hidden lg:inline">{tab.label}</span>
                  <span className="lg:hidden">{tab.shortLabel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Mobile/tablet tab row — visible below md (768px) */}
        {activeTab !== null && (
          <div className="md:hidden flex border-t border-[var(--border)]">
            {TABS.map((tab, i) => (
              <button
                key={tab.id}
                onClick={() => selectTab(tab.id)}
                className={`flex-1 text-xs font-medium py-2.5 transition-colors cursor-pointer ${
                  i > 0 ? "border-l border-[var(--border)]" : ""
                } ${
                  activeTab === tab.id
                    ? "text-white"
                    : "bg-white text-[#666]"
                }`}
                style={activeTab === tab.id ? { backgroundColor: tab.color } : undefined}
              >
                {tab.shortLabel}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* Getting Started — shown when no tab is selected */}
      {activeTab === null && (
        <GettingStarted onSelectTab={(tab) => selectTab(tab)} />
      )}

      {/* Tab content — lazy-mounted on first visit, then kept mounted to preserve state */}
      {mountedTabs.has("current") && (
        <RtciChat
          mode="current"
          heroData={heroData}
          heroAgencyCount={heroAgencyCount}
          heroPopulation={heroPopulation}
          visible={activeTab === "current"}
        />
      )}
      {mountedTabs.has("historical") && (
        <RtciChat
          mode="historical"
          historicalHeroData={historicalHeroData}
          historicalMaxYear={historicalMaxYear}
          visible={activeTab === "historical"}
        />
      )}
      {mountedTabs.has("nibrs") && (
        <NibrsChat
          visible={activeTab === "nibrs"}
        />
      )}
      {mountedTabs.has("explainer") && (
        <ExplainerContent visible={activeTab === "explainer"} />
      )}
      <Tracker activeTab={activeTab} />
    </div>
  );
}
