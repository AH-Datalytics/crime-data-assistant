"use client";

import { useState, useEffect } from "react";

/**
 * Animated placeholder that waits for chart animation, then types through
 * example prompts one at a time, and settles back to the default text.
 *
 * Flow: [default text] → type prompt 1 → pause → delete → type prompt 2 → pause → delete → [default text]
 */
export function useAnimatedPlaceholder(
  prompts: string[],
  defaultText: string,
  opts?: { typeSpeed?: number; deleteSpeed?: number; pauseMs?: number; startDelay?: number }
) {
  const { typeSpeed = 40, deleteSpeed = 20, pauseMs = 2000, startDelay = 2000 } = opts || {};
  const [text, setText] = useState(defaultText);
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const sleep = (ms: number) => new Promise<void>((r) => (timeout = setTimeout(r, ms)));

    const run = async () => {
      // Wait for chart animation to finish
      await sleep(startDelay);
      if (cancelled) return;

      setTyping(true);

      for (const prompt of prompts) {
        if (cancelled) return;
        // Type forward
        for (let i = 0; i <= prompt.length; i++) {
          if (cancelled) return;
          setText(prompt.slice(0, i));
          await sleep(typeSpeed);
        }
        // Pause to let user read
        await sleep(pauseMs);
        if (cancelled) return;
        // Delete backward
        for (let i = prompt.length; i >= 0; i--) {
          if (cancelled) return;
          setText(prompt.slice(0, i));
          await sleep(deleteSpeed);
        }
        // Brief gap before next
        await sleep(300);
      }

      // Settle back to default
      setTyping(false);
      setText(defaultText);
    };

    run();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [active, prompts, defaultText, typeSpeed, deleteSpeed, pauseMs, startDelay]);

  return {
    placeholder: typing ? text + "│" : text,
    pause: () => { setActive(false); setText(defaultText); setTyping(false); },
  };
}
