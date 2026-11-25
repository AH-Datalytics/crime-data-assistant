import { DEFAULT_TREND_FILE, formatTrend, readTrend } from "./scoreboard-v2";

const index = process.argv.indexOf("--file");
if (index >= 0 && !process.argv[index + 1]) throw new Error("--file requires a path");
console.log(formatTrend(readTrend(index >= 0 ? process.argv[index + 1] : DEFAULT_TREND_FILE)));
