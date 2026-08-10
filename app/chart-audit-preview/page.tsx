import { notFound } from "next/navigation";
import ChartAuditPreviewClient from "./preview-client";

export const dynamic = "force-dynamic";

export default function ChartAuditPreviewPage() {
  if (process.env.CHART_AUDIT_PREVIEW_ENABLED !== "1") notFound();
  return <ChartAuditPreviewClient />;
}
