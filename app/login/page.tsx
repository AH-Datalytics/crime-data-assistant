"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import HomeIcon from "@/components/HomeIcon";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (data.success) {
        router.push("/");
      } else {
        setError(data.error || "Wrong password");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--surface)]">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-xl shadow-lg p-8">
          <div className="flex items-center justify-center gap-2 mb-1">
            <HomeIcon size={28} />
            <h1 className="text-xl font-bold text-[var(--foreground)] text-center">
              Crime Index
            </h1>
          </div>
          <p className="text-sm text-[var(--muted)] text-center mb-6">
            Enter password to continue
          </p>
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full px-4 py-3 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[var(--accent)] mb-3"
              autoFocus
              disabled={loading}
            />
            {error && (
              <p className="text-sm text-red-500 mb-3">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || !password.trim()}
              className="w-full py-3 text-sm font-semibold text-white bg-[var(--foreground)] rounded-full hover:bg-[var(--accent-hover)] disabled:opacity-50 cursor-pointer"
            >
              {loading ? "Checking..." : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
