import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getWriteDb } from "@/lib/rtci-db";
import { persistChartRenderReceipt } from "@/lib/chart-audit";

const receiptSchema = z.object({
  requestId: z.string().uuid(),
  component: z.enum(["ChartPanel", "NibrsChartPanel"]),
  chartType: z.enum(["bar", "line", "pie", "stacked_bar", "scatter", "none"]),
  effectiveXKey: z.string().max(100),
  effectiveYKeys: z.array(z.string().max(100)).max(25),
  lineCount: z.number().int().min(0).max(10000),
  barCount: z.number().int().min(0).max(10000),
  pointCount: z.number().int().min(0).max(10000),
  areaCount: z.number().int().min(0).max(10000),
  legendLabels: z.array(z.string().max(100)).max(50),
  xTickLabels: z.array(z.string().max(100)).max(50),
  yTickLabels: z.array(z.string().max(100)).max(50),
  svgWidth: z.number().int().min(0).max(10000),
  svgHeight: z.number().int().min(0).max(10000),
  overflow: z.boolean(), zeroSize: z.boolean(), invalidText: z.boolean(), renderError: z.boolean(),
  viewportClass: z.enum(["narrow", "desktop"]),
  renderedAt: z.number().int().positive(),
}).strict();

export async function POST(req: NextRequest) {
  try {
    const length = Number(req.headers.get("content-length") || 0);
    if (length > 16 * 1024) return NextResponse.json({ success: false }, { status: 413 });
    const parsed = receiptSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false }, { status: 400 });
    const stored = persistChartRenderReceipt(getWriteDb(), parsed.data);
    return NextResponse.json({ success: stored }, { status: stored ? 202 : 404 });
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
}
