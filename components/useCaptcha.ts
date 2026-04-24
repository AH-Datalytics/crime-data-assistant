"use client";

import { useState, useCallback, useRef } from "react";

/**
 * Hook to manage CAPTCHA state for chat components.
 * When the API returns captchaRequired, this pauses the query,
 * shows the Turnstile modal, verifies the token, and retries.
 */
export function useCaptcha() {
  const [captchaNeeded, setCaptchaNeeded] = useState(false);
  const retryFnRef = useRef<(() => void) | null>(null);

  /** Call when an API response has captchaRequired: true. Pass a retry function. */
  const requestCaptcha = useCallback((retryFn: () => void) => {
    retryFnRef.current = retryFn;
    setCaptchaNeeded(true);
  }, []);

  /** Called by TurnstileModal after successful verification. */
  const onVerified = useCallback(async (token: string) => {
    const sessionId = (() => {
      try { return sessionStorage.getItem("cda-session") || ""; }
      catch { return ""; }
    })();

    try {
      const res = await fetch("/api/verify-captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, sessionId }),
      });
      const data = await res.json();
      if (data.success) {
        setCaptchaNeeded(false);
        // Retry the original query
        retryFnRef.current?.();
        retryFnRef.current = null;
      }
    } catch {
      // Verification failed — keep modal open for retry
    }
  }, []);

  const onClose = useCallback(() => {
    setCaptchaNeeded(false);
    retryFnRef.current = null;
  }, []);

  return { captchaNeeded, requestCaptcha, onVerified, onClose };
}
