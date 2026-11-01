import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { previewEnabled } from "@/lib/nibrs-shadow/preview";
import AssistantClient from "./AssistantClient";
import "./assistant.css";

// The Crime Data Assistant redesign, local preview (docs/superpowers/specs/2026-10-31-crime-data-assistant-redesign-design.md):
// the chat wired to the new NIBRS engine. 404 on a production build, the same gate as /preview and its API.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Crime Data Assistant (preview)", robots: { index: false, follow: false } };

export default function AssistantPage() {
  if (!previewEnabled()) notFound();
  return <AssistantClient />;
}
