"use client";

import { useEffect, useRef, useCallback } from "react";

const SITE_KEY = "0x4AAAAAADCIv1mgCVj8soR-";

interface TurnstileModalProps {
  onVerified: (token: string) => void;
  onClose: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}

let scriptLoaded = false;
let scriptLoading = false;

function loadScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve();
  if (scriptLoading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (scriptLoaded) { clearInterval(check); resolve(); }
      }, 100);
    });
  }
  scriptLoading = true;
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";
    s.async = true;
    window.onTurnstileLoad = () => {
      scriptLoaded = true;
      resolve();
    };
    document.head.appendChild(s);
  });
}

export default function TurnstileModal({ onVerified, onClose }: TurnstileModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  const init = useCallback(async () => {
    await loadScript();
    if (!containerRef.current || !window.turnstile) return;
    // Clear any previous widget
    if (widgetIdRef.current) {
      try { window.turnstile.remove(widgetIdRef.current); } catch {}
    }
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: SITE_KEY,
      callback: (token: string) => onVerified(token),
      theme: "light",
      size: "normal",
    });
  }, [onVerified]);

  useEffect(() => {
    init();
    return () => {
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch {}
      }
    };
  }, [init]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl px-8 py-6 max-w-sm w-full mx-4 text-center">
        <p className="text-sm text-[var(--muted)] mb-4">
          Quick verification to continue
        </p>
        <div ref={containerRef} className="flex justify-center mb-4" />
        <button
          onClick={onClose}
          className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
