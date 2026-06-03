"use client";

import { useState, useEffect } from "react";
import HomeIcon from "./HomeIcon";
import RtciChat from "./RtciChat";
import NibrsChat from "./NibrsChat";
import ShrChat from "./ShrChat";
import ExplainerContent from "./ExplainerContent";
import GettingStarted from "./GettingStarted";
import Tracker from "./Tracker";

type TabId = "current" | "historical" | "nibrs" | "shr" | "explainer";

const TABS: { id: TabId; label: string; shortLabel: string; color: string }[] = [
  { id: "current", label: "Current Trends", shortLabel: "Current", color: "#475EC7" },
  { id: "historical", label: "Historical Library", shortLabel: "Historical", color: "#8B5E3C" },
  { id: "nibrs", label: "NIBRS Explorer", shortLabel: "NIBRS", color: "#2d8659" },
  { id: "shr", label: "Homicide Reports", shortLabel: "SHR", color: "#8B6914" },
  { id: "explainer", label: "Tutorial", shortLabel: "Tutorial", color: "#333" },
];

interface ChatInterfaceProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
  historicalMaxYear?: number;
  shrHeroData?: { year: number; pct_firearm: number }[];
}

export default function ChatInterface({ heroData, heroAgencyCount, heroPopulation, historicalHeroData, historicalMaxYear, shrHeroData }: ChatInterfaceProps) {
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [isEmbed, setIsEmbed] = useState(false);
  // Track which tabs have been visited — lazy-mount on first visit, keep mounted after
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(new Set());

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("embed") === "1") {
      setIsEmbed(true);
      document.documentElement.classList.add("in-iframe");
    }
  }, []);

  const selectTab = (tab: TabId | null) => {
    if (tab) setMountedTabs((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
    setActiveTab(tab);
  };

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      {/* Header */}
      <header className="bg-white border-b border-[var(--border)] shrink-0">
        {/* Top row: logo + tab pills (desktop) */}
        <div className="px-3 sm:px-4 md:px-6 flex items-center justify-between relative" style={{ height: 52 }}>
          {/* Left: logo on mobile */}
          <div className="flex items-center shrink-0">
            <button onClick={() => selectTab(null)} className="md:hidden flex items-center shrink-0 cursor-pointer">
              <HomeIcon size={22} />
            </button>
          </div>

          {/* Center: title (hidden in embed mode — portal header already shows app name) */}
          {!isEmbed && (
            <button
              onClick={() => selectTab(null)}
              className="absolute left-1/2 -translate-x-1/2 font-bold uppercase text-[var(--foreground)] cursor-pointer hover:opacity-80 transition-opacity text-[10px] sm:text-[11px] md:text-xs whitespace-nowrap"
              style={{ letterSpacing: "1.5px" }}
            >
              Crime Data Assistant
            </button>
          )}

          {/* Right: tab pills on desktop */}
          <div className="flex items-center gap-3 shrink-0">
            <div className={`${activeTab === null ? "hidden" : "hidden md:flex"} items-center gap-0.5`}>
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => selectTab(tab.id)}
                  className={`relative text-[11px] lg:text-xs px-2 lg:px-3 py-2 rounded-md cursor-pointer whitespace-nowrap transition-all duration-200 ${
                    activeTab === tab.id
                      ? "font-semibold"
                      : "font-medium text-[#888] hover:text-[var(--foreground)] hover:bg-[#f4f4f4]"
                  }`}
                  style={activeTab === tab.id ? { color: tab.color, backgroundColor: tab.color + '0d' } : undefined}
                >
                  <span className="hidden lg:inline">{tab.label}</span>
                  <span className="lg:hidden">{tab.shortLabel}</span>
                  <span
                    className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full transition-all duration-300"
                    style={{
                      backgroundColor: tab.color,
                      opacity: activeTab === tab.id ? 1 : 0,
                      transform: activeTab === tab.id ? 'scaleX(1)' : 'scaleX(0)',
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Mobile/tablet tab row — visible below md (768px) */}
        {activeTab !== null && (
          <div className="md:hidden flex border-t border-[var(--border)] bg-white">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => selectTab(tab.id)}
                className={`relative flex-1 text-[10px] sm:text-[11px] font-medium py-2 transition-all cursor-pointer ${
                  activeTab === tab.id
                    ? "font-semibold"
                    : "text-[#999]"
                }`}
                style={activeTab === tab.id ? { color: tab.color } : undefined}
              >
                {tab.shortLabel}
                <span
                  className="absolute bottom-0 left-1.5 right-1.5 h-[2px] rounded-full transition-all duration-300"
                  style={{
                    backgroundColor: tab.color,
                    opacity: activeTab === tab.id ? 1 : 0,
                    transform: activeTab === tab.id ? 'scaleX(1)' : 'scaleX(0)',
                  }}
                />
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
      {mountedTabs.has("shr") && (
        <ShrChat
          visible={activeTab === "shr"}
          heroData={shrHeroData}
        />
      )}
      {mountedTabs.has("explainer") && (
        <ExplainerContent visible={activeTab === "explainer"} />
      )}
      <Tracker activeTab={activeTab} />
    </div>
  );
}
