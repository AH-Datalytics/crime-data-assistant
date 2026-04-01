"use client";

import { useEffect, useRef } from "react";

/**
 * Lightweight visitor tracker. Captures referrer, UTM params, and tab switches.
 * Fires once on page load, then on each tab change.
 */

function getSessionId(): string {
  const key = "cda-session";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    sessionStorage.setItem(key, id);
  }
  return id;
}

function getUtmParams(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get("utm_source") || "",
    utm_medium: params.get("utm_medium") || "",
    utm_campaign: params.get("utm_campaign") || "",
    utm_content: params.get("utm_content") || "",
  };
}

function send(data: Record<string, unknown>) {
  try {
    // Use sendBeacon for reliability, fall back to fetch
    const payload = JSON.stringify(data);
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/track", payload);
    } else {
      fetch("/api/track", {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Never throw — tracking must be invisible
  }
}

interface TrackerProps {
  activeTab: string | null;
}

export default function Tracker({ activeTab }: TrackerProps) {
  const hasSentPageview = useRef(false);
  const lastTab = useRef<string | null>(null);

  // Send pageview on first load
  useEffect(() => {
    if (hasSentPageview.current) return;
    hasSentPageview.current = true;

    const utm = getUtmParams();
    send({
      sessionId: getSessionId(),
      referrer: document.referrer || "",
      ...utm,
      landingPage: window.location.pathname + window.location.search,
      tab: activeTab || "home",
      event: "pageview",
      screenWidth: window.innerWidth,
    });
  }, []);

  // Send tab_switch events
  useEffect(() => {
    if (!hasSentPageview.current) return;
    if (activeTab === lastTab.current) return;
    if (lastTab.current === null) {
      // First render — already captured in pageview
      lastTab.current = activeTab;
      return;
    }
    lastTab.current = activeTab;

    send({
      sessionId: getSessionId(),
      referrer: "",
      tab: activeTab || "home",
      event: "tab_switch",
      screenWidth: window.innerWidth,
    });
  }, [activeTab]);

  return null;
}
