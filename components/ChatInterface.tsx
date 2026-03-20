"use client";

import { useState } from "react";
import CrimeIndexLogo from "./CrimeIndexLogo";
import RtciChat from "./RtciChat";
import NibrsChat from "./NibrsChat";

type TabId = "current" | "historical" | "nibrs";

const TABS: { id: TabId; label: string; color: string }[] = [
  { id: "current", label: "Current Trends", color: "#475EC7" },
  { id: "historical", label: "Historical Library", color: "#8B5E3C" },
  { id: "nibrs", label: "NIBRS Explorer", color: "#2d8659" },
];

interface ChatInterfaceProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
}

export default function ChatInterface({ heroData, heroAgencyCount, heroPopulation, historicalHeroData }: ChatInterfaceProps) {
  const [activeTab, setActiveTab] = useState<TabId>("current");

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      {/* Header */}
      <header
        className="bg-white border-b border-[var(--border)] px-4 sm:px-6 flex items-center justify-between shrink-0"
        style={{ height: 56 }}
      >
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <CrimeIndexLogo size={24} />
            <span
              className="text-xs sm:text-sm font-medium tracking-widest uppercase text-[var(--foreground)]"
              style={{ letterSpacing: "2.5px" }}
            >
              Crime Index
            </span>
          </div>
          <div className="h-5 w-px bg-[var(--border)] hidden sm:block" />
          <span className="text-xs sm:text-sm text-[var(--foreground)] hidden sm:block">
            Crime Data Assistant
          </span>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {/* Tab pills */}
          <div className="flex items-center gap-0 rounded-lg overflow-hidden border border-[var(--border)]">
            {TABS.map((tab, i) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-xs sm:text-sm font-medium px-3 sm:px-4 py-1.5 transition-colors cursor-pointer ${
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

          {/* About link */}
          <a
            href="/about"
            className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors hidden sm:block"
          >
            About
          </a>
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
        visible={activeTab === "historical"}
      />
      <NibrsChat
        visible={activeTab === "nibrs"}
      />
    </div>
  );
}
