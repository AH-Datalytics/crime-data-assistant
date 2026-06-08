import { ImageResponse } from "next/og";

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
            Ask plain-English questions across current, historical, NIBRS, SHR, and hate crime data.
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, fontSize: 22, fontWeight: 700 }}>
          {["Current", "Historical", "NIBRS", "SHR", "Hate Crime"].map((label, index) => (
            <div
              key={label}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                background: ["#eef1fb", "#f5f0eb", "#ecf5f0", "#fdf8e8", "#efefef"][index],
                color: ["#475EC7", "#8B5E3C", "#2d8659", "#8B6914", "#4A4A4A"][index],
                border: `1px solid ${["#c5cdf0", "#ddd0c2", "#b8dcc8", "#e8d48b", "#d0d0d0"][index]}`,
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
