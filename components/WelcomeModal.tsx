"use client";

import { useState } from "react";

const STORAGE_KEY = "cda-welcome-dismissed";

export default function WelcomeModal() {
  const [show, setShow] = useState(() =>
    typeof window !== "undefined" ? !localStorage.getItem(STORAGE_KEY) : false
  );

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, "1");
    setShow(false);
  }

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto relative">
        {/* Close button */}
        <button
          onClick={dismiss}
          className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors cursor-pointer text-[var(--muted)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <div className="p-6 md:p-8">
          <h2 className="text-xl font-bold text-[var(--foreground)] mb-1">
            Welcome to the Crime Data Assistant
          </h2>
          <p className="text-sm text-[var(--muted)] mb-6">
            Ask questions in plain English and get answers from real crime data. Here&apos;s what each tab can do:
          </p>

          {/* Current Trends */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: "#475EC7" }}
              />
              <h3 className="text-sm font-bold text-[var(--foreground)]">Current Trends</h3>
            </div>
            <p className="text-sm text-[var(--muted)] leading-relaxed pl-[18px]">
              Monthly crime and clearance rate data from hundreds of police departments. Track trends and see what&apos;s happening right now. Data is preliminary and subject to change.
            </p>
          </div>

          {/* Historical Library */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: "#8B5E3C" }}
              />
              <h3 className="text-sm font-bold text-[var(--foreground)]">Historical Library</h3>
            </div>
            <p className="text-sm text-[var(--muted)] leading-relaxed pl-[18px]">
              Explore nearly 100 years of crime data from the FBI&apos;s Summary Reporting System.
            </p>
          </div>

          {/* NIBRS Explorer */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: "#2d8659" }}
              />
              <h3 className="text-sm font-bold text-[var(--foreground)]">NIBRS Explorer</h3>
            </div>
            <p className="text-sm text-[var(--muted)] leading-relaxed pl-[18px]">
              The FBI&apos;s incident-level crime database with more than 1 billion records. Dig into victim and offender demographics, weapon types, clearance rates and types, drug offenses, property crimes, and more. The most detailed crime data available.
            </p>
          </div>

          <button
            onClick={dismiss}
            className="w-full bg-[var(--foreground)] text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
