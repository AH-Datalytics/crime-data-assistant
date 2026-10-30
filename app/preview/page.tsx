import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { previewEnabled } from "@/lib/nibrs-shadow/preview";
import PreviewClient from "./PreviewClient";

// Owner-only local preview of the shadow engine: 404 on a production build (the same gate as its API route).
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "NIBRS engine preview", robots: { index: false, follow: false } };

export default function PreviewPage() {
  if (!previewEnabled()) notFound();
  return <PreviewClient />;
}
