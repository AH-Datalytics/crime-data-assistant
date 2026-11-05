import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { assistantEnabled } from "@/lib/assistant-gate";
import AssistantClient from "./AssistantClient";
import "./assistant.css";

// The Crime Data Assistant redesign, local preview (docs/superpowers/specs/2026-10-31-crime-data-assistant-redesign-design.md):
// the chat wired to the new NIBRS engine. 404 on a production build, the same gate as /preview and its API.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Crime Data Assistant (preview)", robots: { index: false, follow: false } };

export default function AssistantPage() {
  if (!assistantEnabled()) notFound();
  return <AssistantClient />;
}
