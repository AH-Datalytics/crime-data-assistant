"use client";

import { useState } from "react";
import CrimeIndexLogo from "./CrimeIndexLogo";
import RtciChat from "./RtciChat";
import NibrsChat from "./NibrsChat";
import ExplainerContent from "./ExplainerContent";
import WelcomeModal from "./WelcomeModal";

type TabId = "current" | "historical" | "nibrs" | "explainer";

const TABS: { id: TabId; label: string; shortLabel: string; color: string }[] = [
  { id: "current", label: "Current Trends", shortLabel: "Current", color: "#475EC7" },
  { id: "historical", label: "Historical Library", shortLabel: "Historical", color: "#8B5E3C" },
  { id: "nibrs", label: "NIBRS Explorer", shortLabel: "NIBRS", color: "#2d8659" },
  { id: "explainer", label: "Explainer", shortLabel: "Explainer", color: "#333" },
];

interface ChatInterfaceProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
  historicalMaxYear?: number;
}

export default function ChatInterface({ heroData, heroAgencyCount, heroPopulation, historicalHeroData, historicalMaxYear }: ChatInterfaceProps) {
  const [activeTab, setActiveTab] = useState<TabId>("current");

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      <WelcomeModal />
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
            <div className="hidden md:flex items-center gap-2 shrink-0">
              <CrimeIndexLogo size={24} />
              <span
                className="text-xs md:text-sm font-medium tracking-widest uppercase text-[var(--foreground)]"
                style={{ letterSpacing: "2.5px" }}
              >
                Crime Index
              </span>
            </div>
          </div>

          {/* Center: title */}
          <span
            className="absolute left-1/2 -translate-x-1/2 text-sm md:text-base font-bold uppercase text-[var(--foreground)]"
            style={{ letterSpacing: "4px" }}
          >
            Crime Data Assistant
          </span>

          {/* Right: logo on mobile, tab pills on desktop */}
          <div className="flex items-center gap-3 shrink-0">
            <a href="https://crimeindex.org" className="md:hidden flex items-center shrink-0">
              <CrimeIndexLogo size={24} />
            </a>
            <div className="hidden md:flex items-center gap-0 rounded-lg overflow-hidden border border-[var(--border)]">
              {TABS.map((tab, i) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`text-sm font-medium px-4 py-1.5 transition-colors cursor-pointer ${
                    i > 0 ? "border-l border-[var(--border)]" : ""
                  } ${
                    activeTab === tab.id
                      ? "text-white"
                      : "bg-white text-[#666] hover:bg-[#f0f0f0]"
                  }`}
                  style={activeTab === tab.id ? { backgroundColor: tab.color } : undefined}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Mobile/tablet tab row — visible below md (768px) */}
        <div className="md:hidden flex border-t border-[var(--border)]">
          {TABS.map((tab, i) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
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
      </header>

      {/* Tab content — all stay mounted, CSS show/hide preserves state */}
      <RtciChat
        mode="current"
        heroData={heroData}
        heroAgencyCount={heroAgencyCount}
        heroPopulation={heroPopulation}
        visible={activeTab === "current"}
      />
      <RtciChat
        mode="historical"
        historicalHeroData={historicalHeroData}
        historicalMaxYear={historicalMaxYear}
        visible={activeTab === "historical"}
      />
      <NibrsChat
        visible={activeTab === "nibrs"}
      />
      <ExplainerContent visible={activeTab === "explainer"} />
    </div>
  );
}
