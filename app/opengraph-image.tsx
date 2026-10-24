import { ImageResponse } from "next/og";
import { isSourceEnabled } from "@/lib/sources";

// Hate Crime is named only while that source is enabled.
const HATE_CRIME = isSourceEnabled("hate_crime");
const CHIPS = [
  { label: "Current", bg: "#eef1fb", fg: "#475EC7", line: "#c5cdf0" },
  { label: "Historical", bg: "#f5f0eb", fg: "#8B5E3C", line: "#ddd0c2" },
  { label: "NIBRS", bg: "#ecf5f0", fg: "#2d8659", line: "#b8dcc8" },
  { label: "SHR", bg: "#fdf8e8", fg: "#8B6914", line: "#e8d48b" },
  ...(HATE_CRIME ? [{ label: "Hate Crime", bg: "#efefef", fg: "#4A4A4A", line: "#d0d0d0" }] : []),
];

export const runtime = "edge";
export const alt = "Crime Data Assistant by The Crime Index";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f7f8fb",
          color: "#202638",
          fontFamily: "Arial, sans-serif",
          padding: "70px 76px",
          border: "1px solid #d9dee9",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 58,
              height: 58,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 14,
              background: "#202638",
              color: "#ffffff",
              fontSize: 28,
              fontWeight: 800,
            }}
          >
            CI
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 28, fontWeight: 800 }}>The Crime Index</div>
            <div style={{ fontSize: 22, color: "#697184" }}>AI research across U.S. crime datasets</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ fontSize: 76, lineHeight: 0.98, fontWeight: 900, letterSpacing: 0 }}>
            Crime Data Assistant
          </div>
          <div style={{ maxWidth: 940, fontSize: 34, lineHeight: 1.25, color: "#3f4758" }}>
            {HATE_CRIME
              ? "Ask plain-English questions across current, historical, NIBRS, SHR, and hate crime data."
              : "Ask plain-English questions across current, historical, NIBRS, and SHR data."}
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, fontSize: 22, fontWeight: 700 }}>
          {CHIPS.map(({ label, bg, fg, line }) => (
            <div
              key={label}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                background: bg,
                color: fg,
                border: `1px solid ${line}`,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    size
  );
}
